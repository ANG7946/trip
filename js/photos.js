// photos.js — 景點縮圖（維基百科／Wikimedia Commons）
// 原則：預設關閉；只有使用者開啟後才發出網路請求；圖片存在本機快取，離線可看；一律附上作者與授權。

export const PHOTO_CACHE = 'tc-photos-v1';
// 使用維基媒體的標準縮圖寬度；非標準尺寸常需現場產生，容易被限流（HTTP 429）
export const THUMB_WIDTH = 330;
export const THUMB_FALLBACK_WIDTH = 250;
const wikiApi = (lang) => `https://${lang}.wikipedia.org/w/api.php`;
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

/** 不查縮圖的停靠點類型（交通移動通常沒有可辨識的「長相」） */
export const PHOTO_SKIP_TYPES = ['transfer'];

export function wantsPhoto(stop) {
  return !PHOTO_SKIP_TYPES.includes(stop.type) && !!(stop.localName || stop.title);
}

// ---------- 名稱比對 ----------
export function normName(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function stopCoords(stop) {
  return stop.entranceCoordinates || stop.coordinates || null;
}

function pageCoords(page) {
  const c = page.coordinates && page.coordinates[0];
  return c && Number.isFinite(c.lat) && Number.isFinite(c.lon) ? { lat: c.lat, lng: c.lon } : null;
}

/**
 * 依名稱與距離為候選條目評分，挑出最合適者。
 * 回傳 { page, confidence: 'high'|'medium'|'low' } 或 null。
 */
// 比對時忽略的通用字（避免「某某博物館」與「另一間博物館」被當成同一個地方）
const GENERIC_WORDS = new Set([
  'the', 'and', 'of', 'von', 'der', 'die', 'das', 'und', 'zum', 'zur', 'am', 'im', 'an', 'es', 'az', 'a',
  'museum', 'muzeum', 'muzeum', 'church', 'kirche', 'templom', 'kostol', 'chapel', 'kapelle',
  'palace', 'palais', 'palota', 'palac', 'schloss', 'castle', 'hrad', 'var', 'burg', 'fortress',
  'park', 'garden', 'garten', 'hotel', 'restaurant', 'cafe', 'kaffeehaus', 'bar', 'station', 'bahnhof',
  'hauptbahnhof', 'railway', 'square', 'platz', 'ter', 'namestie', 'street', 'strasse', 'gasse', 'utca', 'ut', 'ulica',
  'bridge', 'brucke', 'hid', 'most', 'cathedral', 'dom', 'kathedrale', 'bazilika', 'basilica', 'gallery', 'galerie',
  'national', 'nemzeti', 'city', 'old', 'new', 'upper', 'lower', 'obere', 'untere', 'great', 'grand',
  'vienna', 'wien', 'budapest', 'bratislava', 'pozsony', 'austria', 'hungary', 'slovakia',
]);

function tokens(n) {
  return n.split(' ').filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
}

/** 名稱是否吻合：'exact' | 'partial' | null */
export function nameMatchKind(names, pageTitle) {
  const t = normName(pageTitle);
  if (!t) return null;
  if (names.some((n) => n === t)) return 'exact';
  // 一方包含另一方（中文等無空格語言，或 "Karlskirche" vs "Karlskirche Wien"）
  const meaningful = (x) => /[^\x00-\x7f]/.test(x) ? x.length >= 2 : tokens(x).length > 0;
  if (names.some((n) => {
    if (n.length < 2 || !(t.includes(n) || n.includes(t))) return false;
    const shorter = n.length <= t.length ? n : t; // 被包含的一方必須有實質內容，不能只是「museum」這類通用字
    return meaningful(shorter);
  })) return 'partial';
  // 共同的關鍵字（"Schloss Belvedere" vs "Belvedere, Vienna"）
  const tt = new Set(tokens(t));
  if (names.some((n) => tokens(n).some((w) => tt.has(w)))) return 'partial';
  return null;
}

/**
 * 為候選條目評分，挑出最合適者。寧缺勿濫：名稱必須吻合才採用。
 * 回傳 { page, confidence: 'high'|'medium', nameMatch: true } 或 null。
 */
/** 名稱拆分：「Hofburg / Heldenplatz」、「A，B」視為多個可能名稱 */
export function nameVariants(s) {
  const full = String(s || '').trim();
  if (!full) return [];
  const parts = full.split(/\s*[\/／|｜;；、，,]\s*/).map((x) => x.trim()).filter((x) => x.length >= 2);
  return [...new Set([full, ...(parts.length > 1 ? parts : [])])];
}

// 常見城市中心（停靠點沒有座標時，用來排除遠方的同名條目，例如 Volders 的 Karlskirche）
export const CITY_CENTERS = {
  vienna: [48.2082, 16.3738], wien: [48.2082, 16.3738], budapest: [47.4979, 19.0402], bratislava: [48.1486, 17.1077],
  salzburg: [47.8095, 13.0550], prague: [50.0755, 14.4378], praha: [50.0755, 14.4378], munich: [48.1351, 11.5820],
  berlin: [52.52, 13.405], paris: [48.8566, 2.3522], rome: [41.9028, 12.4964], london: [51.5072, -0.1276],
  tokyo: [35.6762, 139.6503], kyoto: [35.0116, 135.7681], osaka: [34.6937, 135.5023], seoul: [37.5665, 126.978], taipei: [25.033, 121.5654],
};
// 城市的各種寫法（標題含城市名稱時加分）
const CITY_ALIASES = {
  vienna: ['vienna', 'wien', 'wiener'], wien: ['vienna', 'wien', 'wiener'],
  budapest: ['budapest', 'budapesti'], bratislava: ['bratislava', 'bratislavsky', 'bratislavska', 'pozsony'],
  prague: ['prague', 'praha', 'prazsky'], praha: ['prague', 'praha', 'prazsky'],
};

function qualifier(title) {
  const m = String(title || '').match(/\(([^)]+)\)\s*$/) || String(title || '').match(/,\s*([^,]+)$/);
  return m ? normName(m[1]) : '';
}

export function pickBestPage(pages, stop, { rejected = [] } = {}) {
  const names = [...nameVariants(stop.localName), ...nameVariants(stop.title)].map(normName).filter(Boolean);
  const cityKey = normName(stop.city);
  const cityNames = new Set([cityKey].filter(Boolean));
  const aliases = CITY_ALIASES[cityKey] || (cityKey ? [cityKey] : []);
  const center = CITY_CENTERS[cityKey] ? { lat: CITY_CENTERS[cityKey][0], lng: CITY_CENTERS[cityKey][1] } : null;
  const here = stopCoords(stop);
  const scored = [];
  for (const p of pages || []) {
    if (!p || !p.thumbnail || !p.thumbnail.source || !p.pageimage) continue;
    if (rejected.includes(p.title)) continue;
    const t = normName(p.title);
    if (cityNames.has(t) || GENERIC_WORDS.has(t)) continue; // 整個城市的條目不算
    const kind = nameMatchKind(names, p.title);
    if (!kind) continue;
    let score = kind === 'exact' ? 3 : 2;
    const there = pageCoords(p);
    let dist = null;
    if (here && there) {
      dist = distanceMeters(here, there);
      if (dist > 50000) continue; // 不同城市：排除
      if (dist <= 300) score += 2;
      else if (dist <= 1500) score += 1;
      else if (dist > 15000) score -= 2;
    } else if (center && there && distanceMeters(center, there) > 40000) {
      continue; // 沒有停靠點座標時，以城市中心排除遠方的同名地點
    }
    // 標題含城市名稱（Wiener Karlskirche、Stephansdom (Wien)）加分；括號／逗號後是其他地名則扣分
    const words = new Set(t.split(' '));
    if (aliases.some((a) => words.has(a))) score += 1;
    const q = qualifier(p.title);
    if (q && aliases.length && !aliases.some((a) => q.includes(a)) && !names.some((n) => n.includes(q))) score -= 2;
    scored.push({ page: p, score, dist, index: p.index ?? 999 });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index) || ((a.dist ?? 1e9) - (b.dist ?? 1e9)));
  const best = scored[0];
  if (best.score < 1) return null;
  return { page: best.page, confidence: best.score >= 4 ? 'high' : 'medium', nameMatch: true };
}

// ---------- 當地語言 ----------
const LANG_BY_CITY = {
  vienna: 'de', wien: 'de', salzburg: 'de', innsbruck: 'de', graz: 'de', hallstatt: 'de', berlin: 'de', munich: 'de', munchen: 'de',
  budapest: 'hu', szentendre: 'hu', eger: 'hu',
  bratislava: 'sk', pozsony: 'sk', kosice: 'sk',
  prague: 'cs', praha: 'cs', 'cesky krumlov': 'cs', brno: 'cs',
  paris: 'fr', lyon: 'fr', rome: 'it', roma: 'it', florence: 'it', firenze: 'it', venice: 'it', venezia: 'it', milan: 'it', milano: 'it',
  madrid: 'es', barcelona: 'es', seville: 'es', sevilla: 'es', lisbon: 'pt', lisboa: 'pt', porto: 'pt',
  amsterdam: 'nl', brussels: 'nl', krakow: 'pl', warsaw: 'pl', warszawa: 'pl', ljubljana: 'sl', zagreb: 'hr',
  tokyo: 'ja', kyoto: 'ja', osaka: 'ja', nara: 'ja', seoul: 'ko', busan: 'ko', taipei: 'zh', tainan: 'zh', kaohsiung: 'zh',
};

/** 依城市（其次依原文特殊字母）推測當地語言的維基百科；無法判斷時回傳 null */
export function localLang(stop) {
  const city = normName(stop.city);
  if (city && LANG_BY_CITY[city]) return LANG_BY_CITY[city];
  const local = String(stop.localName || '');
  if (/[őűŐŰ]/.test(local)) return 'hu';
  if (/[řůěŘŮĚ]/.test(local)) return 'cs';
  if (/[ľĺŕôťďňĽĹŔÔŤĎŇ]/.test(local)) return 'sk';
  if (/[ßäÄ]/.test(local)) return 'de';
  if (/[぀-ヿ]/.test(local)) return 'ja';
  if (/[가-힯]/.test(local)) return 'ko';
  return null;
}

// ---------- API 網址 ----------
const COMMON_PARAMS = {
  action: 'query', format: 'json', formatversion: '2', origin: '*',
  prop: 'pageimages|coordinates', piprop: 'thumbnail|name', pithumbsize: String(THUMB_WIDTH), pilicense: 'free',
  colimit: 'max',
};

export function geoSearchUrl(coords, lang = 'en') {
  const u = new URL(wikiApi(lang));
  Object.entries({ ...COMMON_PARAMS, generator: 'geosearch', ggscoord: `${coords.lat}|${coords.lng}`, ggsradius: '500', ggslimit: '10' })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 名稱搜尋的嘗試順序（由精確到寬鬆）：
 *  1. 當地語言維基：原文名稱（例：德文維基 Schloss Belvedere）　2. 當地語言維基：原文＋城市
 *  3. 英文維基：原文　4. 英文維基：原文＋城市　5. 中文維基：中文名稱
 */
export function searchPlans(stop) {
  const plans = [];
  const local = (stop.localName || '').trim();
  const title = (stop.title || '').trim();
  const city = (stop.city || '').trim();
  const ll = localLang(stop);
  const add = (lang, q) => { if (q && !plans.some((x) => x.lang === lang && x.q === q)) plans.push({ lang, q }); };
  const locals = nameVariants(local);
  if (locals.length && ll && ll !== 'en') {
    for (const n of locals) add(ll, n);
    add(ll, [locals[0], city].filter(Boolean).join(' '));
  }
  if (locals.length) {
    for (const n of locals) add('en', n);
    add('en', [locals[0], city].filter(Boolean).join(' '));
  }
  if (title && !CJK_RE.test(title)) { add('en', [title, city].filter(Boolean).join(' ')); add('en', title); }
  if (title && CJK_RE.test(title)) add('zh', title);
  return plans;
}

export function textSearchUrl(stop, plan) {
  const { lang, q } = plan || searchPlans(stop)[0] || { lang: 'en', q: stop.title };
  const u = new URL(wikiApi(lang));
  Object.entries({ ...COMMON_PARAMS, generator: 'search', gsrsearch: q, gsrlimit: '5' })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

export function imageInfoUrl(fileName) {
  const u = new URL(COMMONS_API);
  Object.entries({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    titles: `File:${fileName}`, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: String(THUMB_WIDTH),
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|Credit',
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

export function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// 維基媒體的圖片網域（2026 年起 API 回傳的縮圖多改用 thumb.wikimedia.org）
export const WIKIMEDIA_IMAGE_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org'];

/** 只接受 Wikimedia 圖片網域的 https 網址 */
export function isWikimediaUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && WIKIMEDIA_IMAGE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** 去掉追蹤參數（utm_…），讓快取鍵穩定 */
export function cleanImageUrl(s) {
  try {
    const u = new URL(s);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return s;
  }
}

// ---------- 查詢（fetch 可注入，方便測試） ----------
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取得 JSON；遇到限流（429）或暫時錯誤（503）依 Retry-After 或指數退避重試，最多 3 次 */
async function getJson(fetchFn, url, { wait = sleepMs, tries = 4 } = {}) {
  let delay = 2000;
  for (let i = 0; i < tries; i += 1) {
    const res = await fetchFn(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status === 503) && i < tries - 1) {
      const ra = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
      await wait(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 15) * 1000 : delay);
      delay *= 2;
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error('HTTP 429');
}

/**
 * 為停靠點找一張縮圖並取得授權資訊。
 * 有座標時先以地理搜尋（較準），再以名稱搜尋。找不到回傳 null。
 */
export async function lookupPhoto(stop, { fetchFn = fetch, rejected = [], wait } = {}) {
  const gj = (f, u) => getJson(f, u, wait ? { wait } : undefined);
  let pick = null;
  let lang = 'en';
  let lastErr = null;
  let anyOk = false;
  const here = stopCoords(stop);
  if (here) {
    // 地理搜尋也必須名稱吻合才採用，避免抓到隔壁建築（例如漁人堡旁的馬加什教堂）
    for (const gl of [...new Set([localLang(stop), 'en'].filter(Boolean))]) {
      try {
        const geo = await gj(fetchFn, geoSearchUrl(here, gl));
        anyOk = true;
        const candidate = pickBestPage(geo?.query?.pages, stop, { rejected });
        if (candidate) { pick = candidate; lang = gl; break; }
      } catch (e) { lastErr = e; }
    }
  }
  if (!pick) {
    for (const plan of searchPlans(stop)) {
      try {
        const txt = await gj(fetchFn, textSearchUrl(stop, plan));
        anyOk = true;
        const cand = pickBestPage(txt?.query?.pages, stop, { rejected });
        if (cand) { pick = cand; lang = plan.lang; break; }
      } catch (e) { lastErr = e; }
    }
  }
  if (!pick) {
    if (!anyOk && lastErr) throw lastErr; // 每次查詢都失敗：回報錯誤而非「找不到」
    return null;
  }

  const page = pick.page;
  let artist = '';
  let license = '';
  let licenseUrl = '';
  let thumbUrl = cleanImageUrl(page.thumbnail.source);
  let fileUrl = `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(page.pageimage)}`;
  try {
    const info = await gj(fetchFn, imageInfoUrl(page.pageimage));
    const ii = info?.query?.pages?.[0]?.imageinfo?.[0];
    if (ii) {
      const md = ii.extmetadata || {};
      artist = stripHtml(md.Artist?.value || md.Credit?.value || '');
      license = stripHtml(md.LicenseShortName?.value || '');
      licenseUrl = isSafeLink(md.LicenseUrl?.value) ? md.LicenseUrl.value : '';
      if (ii.thumburl && isWikimediaUrl(ii.thumburl)) thumbUrl = cleanImageUrl(ii.thumburl);
      if (ii.descriptionurl && isSafeLink(ii.descriptionurl)) fileUrl = ii.descriptionurl;
    }
  } catch { /* 授權資訊取得失敗：仍保留來源連結 */ }
  if (!isWikimediaUrl(thumbUrl)) return null;
  return {
    source: 'wikipedia',
    title: page.title,
    pageUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    lang,
    fileUrl,
    thumbUrl,
    width: page.thumbnail.width || null,
    height: page.thumbnail.height || null,
    artist: artist.slice(0, 200),
    license: license.slice(0, 60),
    licenseUrl,
    confidence: pick.confidence,
    hidden: false,
    rejected,
    fetchedAt: new Date().toISOString(),
  };
}

function isSafeLink(s) {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------- 本機快取（Cache Storage） ----------
export async function cachedBlob(url) {
  if (!('caches' in globalThis)) return null;
  const cache = await caches.open(PHOTO_CACHE);
  const res = await cache.match(url);
  return res ? res.blob() : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把縮圖網址中的寬度（.../330px-File.jpg）換成另一個標準寬度 */
export function withThumbWidth(url, width) {
  return cleanImageUrl(url).replace(/\/(\d+)px-([^/]+)$/, `/${width}px-$2`);
}

/**
 * 下載圖片並存入本機快取（以原始網址為鍵）。
 * 遇到 429／5xx 稍候重試一次；仍失敗則改用較小的標準寬度再試。
 */
export async function downloadToCache(url, fetchFn = fetch, { wait = sleep } = {}) {
  if (!isWikimediaUrl(url)) throw new Error('不允許的圖片來源');
  const opts = { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' };
  const attempts = [url, url, withThumbWidth(url, THUMB_FALLBACK_WIDTH)].filter((u, i, a) => i < 2 || u !== a[0]);
  let lastErr = null;
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const res = await fetchFn(attempts[i], opts);
      if (res.ok) {
        const cache = await caches.open(PHOTO_CACHE);
        await cache.put(url, res.clone());
        return res.blob();
      }
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status === 404) break;
      if (res.status === 429 || res.status >= 500) await wait(1500 * (i + 1));
    } catch (e) {
      lastErr = new Error(e && e.message ? e.message : '網路錯誤');
      await wait(800);
    }
  }
  throw lastErr || new Error('下載失敗');
}

export async function cacheStats() {
  if (!('caches' in globalThis)) return { count: 0, bytes: 0 };
  const cache = await caches.open(PHOTO_CACHE);
  const keys = await cache.keys();
  let bytes = 0;
  for (const k of keys) {
    const r = await cache.match(k);
    if (r) bytes += (await r.clone().blob()).size;
  }
  return { count: keys.length, bytes };
}

export async function clearCache() {
  if ('caches' in globalThis) await caches.delete(PHOTO_CACHE);
}
