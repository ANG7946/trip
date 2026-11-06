import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PH from '../js/photos.js';

const page = (title, lat, lon, extra = {}) => ({
  title, index: extra.index ?? 1, pageimage: `${title.replace(/ /g, '_')}.jpg`,
  thumbnail: { source: `https://upload.wikimedia.org/thumb/${encodeURIComponent(title)}.jpg`, width: 400, height: 300 },
  coordinates: lat == null ? undefined : [{ lat, lon }], ...extra,
});

test('名稱正規化：去除重音與括號', () => {
  assert.equal(PH.normName('Halászbástya'), 'halaszbastya');
  assert.equal(PH.normName('Belvedere (palace)'), 'belvedere');
});

test('配對：名稱吻合且距離近 → 高信心', () => {
  const stop = { title: '卡爾教堂', localName: 'Karlskirche', city: 'Vienna', coordinates: { lat: 48.1982, lng: 16.3719 } };
  const r = PH.pickBestPage([page('Wien Museum', 48.1990, 16.3720, { index: 1 }), page('Karlskirche', 48.1983, 16.3717, { index: 2 })], stop);
  assert.equal(r.page.title, 'Karlskirche');
  assert.equal(r.confidence, 'high');
});

test('配對：同名但在另一個城市 → 排除', () => {
  const stop = { title: '美景宮', localName: 'Belvedere', city: 'Vienna', coordinates: { lat: 48.1916, lng: 16.3809 } };
  assert.equal(PH.pickBestPage([page('Belvedere', 52.40, 13.05)], stop), null);
});

test('配對：沒有縮圖或非自由授權（無 pageimage）的條目不採用；已排除者略過', () => {
  const stop = { title: 'X', localName: 'Stephansdom', city: 'Vienna' };
  const noThumb = { title: 'Stephansdom', index: 1 };
  assert.equal(PH.pickBestPage([noThumb], stop), null);
  const r = PH.pickBestPage([page('Stephansdom', null, null), page('Stephansdom (Wien)', null, null, { index: 2 })], stop, { rejected: ['Stephansdom'] });
  assert.equal(r.page.title, 'Stephansdom (Wien)');
  // 名稱不吻合者寧缺勿濫
  assert.equal(PH.pickBestPage([page('St. Stephen Cathedral', null, null)], stop), null);
});

test('API 網址：geosearch 座標順序、origin=*、僅自由授權', () => {
  const g = new URL(PH.geoSearchUrl({ lat: 48.2, lng: 16.37 }));
  assert.equal(g.hostname, 'en.wikipedia.org');
  assert.equal(g.searchParams.get('ggscoord'), '48.2|16.37');
  assert.equal(g.searchParams.get('origin'), '*');
  assert.equal(g.searchParams.get('pilicense'), 'free');
  const s = new URL(PH.textSearchUrl({ title: '漁人堡', localName: 'Halászbástya', city: 'Budapest' }));
  assert.equal(s.hostname, 'hu.wikipedia.org', '布達佩斯優先查匈牙利文維基');
  assert.equal(s.searchParams.get('gsrsearch'), 'Halászbástya');
});

test('只接受 upload.wikimedia.org 的 https 圖片', () => {
  assert.equal(PH.isWikimediaUrl('https://upload.wikimedia.org/a.jpg'), true);
  assert.equal(PH.isWikimediaUrl('http://upload.wikimedia.org/a.jpg'), false);
  assert.equal(PH.isWikimediaUrl('https://evil.example/a.jpg'), false);
  assert.equal(PH.isWikimediaUrl('javascript:alert(1)'), false);
});

test('不查交通類停靠點', () => {
  assert.equal(PH.wantsPhoto({ type: 'transfer', title: '火車' }), false);
  assert.equal(PH.wantsPhoto({ type: 'attraction', title: '美景宮' }), true);
});

function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [pred, body] of routes) if (pred(url)) return { ok: true, status: 200, json: async () => body };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

test('lookupPhoto：座標優先；地理搜尋名稱不符時改用名稱搜尋；取得作者與授權（去除 HTML）', async () => {
  const stop = { title: '漁人堡', localName: 'Halászbástya', city: 'Budapest', coordinates: { lat: 47.5022, lng: 19.0348 } };
  const fetchFn = mockFetch([
    [(u) => u.includes('generator=geosearch'), { query: { pages: [page('Matthias Church', 47.5019, 19.0342)] } }],
    [(u) => u.includes('hu.wikipedia.org') && u.includes('generator=search'), { query: { pages: [page('Halászbástya', 47.5021, 19.0349, { index: 1 })] } }],
    [(u) => u.includes('generator=search'), { query: { pages: [page("Fisherman's Bastion", 47.5021, 19.0349, { index: 1 })] } }],
    [(u) => u.includes('commons.wikimedia.org'), { query: { pages: [{ imageinfo: [{
      thumburl: 'https://upload.wikimedia.org/thumb/fb-400.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:FB.jpg',
      extmetadata: { Artist: { value: '<a href="//x">Jane <b>Doe</b></a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } },
    }] }] } }],
  ]);
  const p = await PH.lookupPhoto(stop, { fetchFn });
  assert.equal(p.title, 'Halászbástya');
  assert.equal(p.lang, 'hu');
  assert.match(p.pageUrl, /^https:\/\/hu\.wikipedia\.org\//);
  assert.equal(p.confidence, 'high', '名稱完全吻合且距離近');
  assert.equal(p.artist, 'Jane Doe');
  assert.equal(p.license, 'CC BY-SA 4.0');
  assert.equal(p.thumbUrl, 'https://upload.wikimedia.org/thumb/fb-400.jpg');
  assert.equal(p.hidden, false);
  assert.ok(fetchFn.calls[0].includes('geosearch'), '先用座標查');
});

test('lookupPhoto：找不到時回傳 null；授權資訊失敗時仍保留來源', async () => {
  const none = mockFetch([[(u) => u.includes('generator=search'), { query: {} }]]);
  assert.equal(await PH.lookupPhoto({ title: '不存在的地方', city: 'Nowhere' }, { fetchFn: none }), null);
  const partial = mockFetch([[(u) => u.includes('generator=search'), { query: { pages: [page('Stephansdom', null, null)] } }]]);
  const p = await PH.lookupPhoto({ title: '聖史蒂芬大教堂', localName: 'Stephansdom', city: 'Vienna' }, { fetchFn: partial });
  assert.equal(p.title, 'Stephansdom');
  assert.equal(p.artist, '');
  assert.match(p.fileUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
});

test('搜尋順序：當地語言維基原文 → 英文維基原文 → 中文維基', () => {
  const plans = PH.searchPlans({ title: '卡爾教堂', localName: 'Karlskirche', city: 'Vienna' });
  assert.deepEqual(plans, [
    { lang: 'de', q: 'Karlskirche' }, { lang: 'de', q: 'Karlskirche Vienna' },
    { lang: 'en', q: 'Karlskirche' }, { lang: 'en', q: 'Karlskirche Vienna' }, { lang: 'zh', q: '卡爾教堂' }]);
  assert.deepEqual(PH.searchPlans({ title: 'Café Sacher', city: 'Vienna' }), [{ lang: 'en', q: 'Café Sacher Vienna' }, { lang: 'en', q: 'Café Sacher' }]);
  assert.equal(new URL(PH.textSearchUrl({}, { lang: 'zh', q: '漁人堡' })).hostname, 'zh.wikipedia.org');
});

test('英文找不到時改查中文維基百科，條目連結指向中文維基', async () => {
  const fetchFn = mockFetch([
    [(u) => u.includes('zh.wikipedia.org') && u.includes('generator=search'), { query: { pages: [page('卡爾教堂', null, null)] } }],
    [(u) => u.includes('en.wikipedia.org'), { query: {} }],
  ]);
  const p = await PH.lookupPhoto({ title: '卡爾教堂', localName: 'Karlskirche', city: 'Vienna' }, { fetchFn });
  assert.equal(p.title, '卡爾教堂');
  assert.equal(p.lang, 'zh');
  assert.match(p.pageUrl, /^https:\/\/zh\.wikipedia\.org\/wiki\//);
  assert.equal(p.confidence, 'medium', '中文名稱完全吻合');
});

test('縮圖使用標準寬度 330；網址寬度替換', () => {
  assert.equal(PH.THUMB_WIDTH, 330);
  assert.equal(new URL(PH.geoSearchUrl({ lat: 1, lng: 2 })).searchParams.get('pithumbsize'), '330');
  assert.equal(PH.withThumbWidth('https://upload.wikimedia.org/a/ab/X.jpg/330px-X.jpg', 250), 'https://upload.wikimedia.org/a/ab/X.jpg/250px-X.jpg');
});

test('下載：429 時稍候重試，仍失敗改用 250px；404 不重試', async () => {
  const store = new Map();
  globalThis.caches = { open: async () => ({ put: async (k, v) => store.set(k, v), match: async (k) => store.get(k) }) };
  const url = 'https://upload.wikimedia.org/a/ab/X.jpg/330px-X.jpg';
  const seen = [];
  const okRes = { ok: true, status: 200, clone() { return this; }, blob: async () => ({ size: 10 }) };
  const f = async (u) => { seen.push(u); return u.includes('/250px-') ? okRes : { ok: false, status: 429 }; };
  const blob = await PH.downloadToCache(url, f, { wait: async () => {} });
  assert.equal(blob.size, 10);
  assert.deepEqual(seen, [url, url, url.replace('/330px-', '/250px-')]);
  assert.ok(store.has(url), '以原網址為鍵存入快取');
  const seen404 = [];
  await assert.rejects(() => PH.downloadToCache(url, async (u) => { seen404.push(u); return { ok: false, status: 404 }; }, { wait: async () => {} }), /HTTP 404/);
  assert.equal(seen404.length, 1);
  delete globalThis.caches;
});

test('當地語言判斷：依城市，其次依原文特殊字母', () => {
  assert.equal(PH.localLang({ city: 'Wien' }), 'de');
  assert.equal(PH.localLang({ city: 'Budapest' }), 'hu');
  assert.equal(PH.localLang({ city: 'Bratislava' }), 'sk');
  assert.equal(PH.localLang({ city: '', localName: 'Szépművészeti Múzeum' }), 'hu');
  assert.equal(PH.localLang({ city: 'Somewhere', localName: 'Plain Name' }), null);
});

test('寧缺勿濫：關鍵字吻合可配；城市條目、通用字（museum）不配', () => {
  const belv = { title: '美景宮', localName: 'Schloss Belvedere', city: 'Vienna' };
  assert.equal(PH.pickBestPage([page('Belvedere, Vienna', null, null)], belv).page.title, 'Belvedere, Vienna');
  const cafe = { title: '某咖啡館', localName: 'Café Prückel', city: 'Vienna' };
  assert.equal(PH.pickBestPage([page('Vienna', null, null)], cafe), null, '不可用城市條目充數');
  const leo = { title: '利奧波德博物館', localName: 'Leopold Museum', city: 'Vienna' };
  assert.equal(PH.pickBestPage([page('Museum of Fine Arts', null, null)], leo), null, '只有 museum 相同不算');
  assert.equal(PH.pickBestPage([page('Leopold Museum', null, null)], leo).confidence, 'medium');
  const zh = { title: '漁人堡', city: 'Budapest' };
  assert.equal(PH.pickBestPage([page('漁人堡', null, null)], zh).page.title, '漁人堡');
});

test('某語言查詢失敗（例如 404）時繼續嘗試其他語言；全部失敗才回報錯誤', async () => {
  const errOnly = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => PH.lookupPhoto({ title: 'X', localName: 'Karlskirche', city: 'Vienna' }, { fetchFn: errOnly }), /HTTP 503/);
});

test('接受 thumb.wikimedia.org（2026 起 API 回傳的縮圖網域）並去除追蹤參數', () => {
  const u = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/39/K.jpg/330px-K.jpg?utm_source=de.wikipedia.org&utm_campaign=api';
  assert.equal(PH.isWikimediaUrl(u), true);
  assert.equal(PH.cleanImageUrl(u), 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/39/K.jpg/330px-K.jpg');
  assert.equal(PH.withThumbWidth(u, 250), 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/39/K.jpg/250px-K.jpg');
  assert.equal(PH.isWikimediaUrl('https://thumb.wikimedia.org.evil.example/x.jpg'), false);
});

test('實際回應格式（2026-11 以真實德文維基驗證）：thumb 網域可被採用', async () => {
  const real = { query: { pages: [
    { pageid: 81847, ns: 0, title: 'Johann Bernhard Fischer von Erlach', index: 5, thumbnail: { source: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/db/J.jpg/330px-J.jpg?utm_source=de.wikipedia.org', width: 330, height: 425 }, pageimage: 'J.jpg' },
    { pageid: 82120, ns: 0, title: 'Wiener Karlskirche', index: 1, thumbnail: { source: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/39/Karlskirche_Abendsonne_1.jpg/330px-Karlskirche_Abendsonne_1.jpg?utm_source=de.wikipedia.org&utm_campaign=api&utm_content=thumbnail', width: 330, height: 220 }, pageimage: 'Karlskirche_Abendsonne_1.jpg' },
  ] } };
  const commons = { query: { pages: [{ imageinfo: [{ thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/39/Karlskirche_Abendsonne_1.jpg/330px-Karlskirche_Abendsonne_1.jpg?utm_source=commons.wikimedia.org', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Karlskirche_Abendsonne_1.jpg', extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Thomas_Ledl">Thomas Ledl</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } } }] }] } };
  const fetchFn = mockFetch([[(u) => u.includes('commons.wikimedia.org'), commons], [(u) => u.includes('de.wikipedia.org'), real]]);
  const p = await PH.lookupPhoto({ title: '卡爾教堂', localName: 'Karlskirche', city: 'Vienna' }, { fetchFn });
  assert.equal(p.title, 'Wiener Karlskirche');
  assert.equal(p.thumbUrl, 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/39/Karlskirche_Abendsonne_1.jpg/330px-Karlskirche_Abendsonne_1.jpg');
  assert.equal(p.artist, 'Thomas Ledl');
});

test('「Hofburg / Heldenplatz」拆成多個名稱搜尋與比對', () => {
  assert.deepEqual(PH.nameVariants('Hofburg / Heldenplatz'), ['Hofburg / Heldenplatz', 'Hofburg', 'Heldenplatz']);
  const stop = { title: '霍夫堡／英雄廣場', localName: 'Hofburg / Heldenplatz', city: 'Vienna' };
  const plans = PH.searchPlans(stop).map((x) => `${x.lang}:${x.q}`);
  assert.ok(plans.includes('de:Hofburg') && plans.includes('de:Heldenplatz'), plans.join());
  assert.equal(PH.pickBestPage([page('Heldenplatz', null, null)], stop).page.title, 'Heldenplatz');
});
