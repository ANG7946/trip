// photos.js — 景點縮圖（維基百科／Wikimedia Commons）
// 原則：預設關閉；只有使用者開啟後才發出網路請求；圖片存在本機快取，離線可看；一律附上作者與授權。

export const PHOTO_CACHE = 'tc-photos-v1';
export const THUMB_WIDTH = 400;
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
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
export function pickBestPage(pages, stop, { rejected = [] } = {}) {
  const names = [stop.localName, stop.title].filter(Boolean).map(normName).filter(Boolean);
  const here = stopCoords(stop);
  const scored = [];
  for (const p of pages || []) {
    if (!p || !p.thumbnail || !p.thumbnail.source || !p.pageimage) continue;
    if (rejected.includes(p.title)) continue;
    const t = normName(p.title);
    let score = 0;
    let nameMatch = false;
    if (names.some((n) => n === t)) { score += 3; nameMatch = true; } else if (names.some((n) => n.length >= 4 && (t.includes(n) || n.includes(t)))) { score += 2; nameMatch = true; }
    const there = pageCoords(p);
    let dist = null;
    if (here && there) {
      dist = distanceMeters(here, there);
      if (dist > 50000) continue; // 不同城市：排除
      if (dist <= 300) score += 2;
      else if (dist <= 1500) score += 1;
      else if (dist > 15000) score -= 2;
    }
    scored.push({ page: p, score, dist, nameMatch, index: p.index ?? 999 });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index) || ((a.dist ?? 1e9) - (b.dist ?? 1e9)));
  const best = scored[0];
  const confidence = best.score >= 4 ? 'high' : best.score >= 2 ? 'medium' : 'low';
  if (best.score < 0) return null;
  return { page: best.page, confidence, nameMatch: best.nameMatch };
}

// ---------- API 網址 ----------
const COMMON_PARAMS = {
  action: 'query', format: 'json', formatversion: '2', origin: '*',
  prop: 'pageimages|coordinates', piprop: 'thumbnail|name', pithumbsize: String(THUMB_WIDTH), pilicense: 'free',
  colimit: 'max',
};

export function geoSearchUrl(coords) {
  const u = new URL(WIKI_API);
  Object.entries({ ...COMMON_PARAMS, generator: 'geosearch', ggscoord: `${coords.lat}|${coords.lng}`, ggsradius: '500', ggslimit: '10' })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

export function textSearchUrl(stop) {
  const q = [stop.localName || stop.title, stop.city].filter(Boolean).join(' ');
  const u = new URL(WIKI_API);
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

/** 只接受 Wikimedia 網域的 https 圖片網址 */
export function isWikimediaUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && (u.hostname === 'upload.wikimedia.org');
  } catch {
    return false;
  }
}

// ---------- 查詢（fetch 可注入，方便測試） ----------
async function getJson(fetchFn, url) {
  const res = await fetchFn(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 為停靠點找一張縮圖並取得授權資訊。
 * 有座標時先以地理搜尋（較準），再以名稱搜尋。找不到回傳 null。
 */
export async function lookupPhoto(stop, { fetchFn = fetch, rejected = [] } = {}) {
  let pick = null;
  const here = stopCoords(stop);
  if (here) {
    const geo = await getJson(fetchFn, geoSearchUrl(here));
    const candidate = pickBestPage(geo?.query?.pages, stop, { rejected });
    // 地理搜尋必須名稱也吻合才採用；否則改用名稱搜尋，避免抓到隔壁建築（例如漁人堡旁的馬加什教堂）
    if (candidate && candidate.nameMatch) pick = candidate;
  }
  if (!pick) {
    const txt = await getJson(fetchFn, textSearchUrl(stop));
    pick = pickBestPage(txt?.query?.pages, stop, { rejected });
  }
  if (!pick) return null;

  const page = pick.page;
  let artist = '';
  let license = '';
  let licenseUrl = '';
  let thumbUrl = page.thumbnail.source;
  let fileUrl = `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(page.pageimage)}`;
  try {
    const info = await getJson(fetchFn, imageInfoUrl(page.pageimage));
    const ii = info?.query?.pages?.[0]?.imageinfo?.[0];
    if (ii) {
      const md = ii.extmetadata || {};
      artist = stripHtml(md.Artist?.value || md.Credit?.value || '');
      license = stripHtml(md.LicenseShortName?.value || '');
      licenseUrl = isSafeLink(md.LicenseUrl?.value) ? md.LicenseUrl.value : '';
      if (ii.thumburl && isWikimediaUrl(ii.thumburl)) thumbUrl = ii.thumburl;
      if (ii.descriptionurl && isSafeLink(ii.descriptionurl)) fileUrl = ii.descriptionurl;
    }
  } catch { /* 授權資訊取得失敗：仍保留來源連結 */ }
  if (!isWikimediaUrl(thumbUrl)) return null;
  return {
    source: 'wikipedia',
    title: page.title,
    pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
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

export async function downloadToCache(url, fetchFn = fetch) {
  if (!isWikimediaUrl(url)) throw new Error('不允許的圖片來源');
  const res = await fetchFn(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cache = await caches.open(PHOTO_CACHE);
  await cache.put(url, res.clone());
  return res.blob();
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
