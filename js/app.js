// app.js — 介面與互動
import * as C from './core.js?v=1.8.2';
import * as DB from './db.js?v=1.8.2';
import * as V from './csv.js?v=1.8.2';
import * as X from './xlsx.js?v=1.8.2';
import * as PH from './photos.js?v=1.8.2';
import * as IM from './images.js?v=1.8.2';
import * as WX from './weather.js?v=1.8.2';

export const APP_VERSION = '1.8.2';

// ---------- 狀態 ----------
const state = {
  trips: [],
  activeTripId: null,
  viewDate: null,
  phase: 'during',
  todayInTrip: null,
  lastExportAt: null,
  onboardingDismissed: false,
  modeOverride: {},          // 暫時切換的交通方式（stopId → mode），不寫入資料
  expanded: new Set(),       // 清單中展開的卡片
  pendingImport: null,       // 匯入預覽
  swState: 'unknown',        // unknown | ready | unsupported
  persisted: null,
  updateReady: null,
  route: { name: 'today', arg: null },
  mapPrefs: { provider: 'apple', appleStyle: 'unified' }, // 本機設定，所有旅程共用
  photoPrefs: { enabled: false, allowLive: false },       // 縮圖：預設關閉；即時下載另行開啟
  photoJob: null,                                          // 預先下載進度
  images: new Map(),                                       // 自己的照片：id → { mime, data(base64), … }
  pendingPhotos: null,                                     // 批次指派預覽
  clockPrefs: { show: true, homeTz: null },                // 兩地時間：家鄉時區首次開啟時記下
  themeMode: 'auto',                                       // 日夜模式：auto | light | dark
  weatherPrefs: { show: true },                            // 天氣預報（Open-Meteo）
};

const main = () => document.getElementById('main');
const scrollMemory = new Map();

function activeTrip() {
  return state.trips.find((t) => t.tripId === state.activeTripId) || null;
}

// ---------- DOM 小工具（所有文字以 textContent 輸出，避免 XSS） ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM，符合 CSP（不使用 style 屬性字串）
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (['value', 'checked', 'selected', 'disabled', 'required', 'hidden'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

function btn(label, onClick, cls = 'btn', extra = {}) {
  return h('button', { type: 'button', class: cls, on: { click: onClick }, ...extra }, label);
}

function formatLocalTime(iso, tz) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ---------- 提示訊息（含復原） ----------
let toastTimer = null;
function toast(message, { actionLabel, action, kind = 'info', duration = 6000 } = {}) {
  const box = document.getElementById('toast');
  box.replaceChildren();
  box.className = `toast show ${kind}`;
  box.appendChild(h('span', { class: 'toast-msg', text: message }));
  if (actionLabel && action) {
    box.appendChild(btn(actionLabel, async () => {
      hideToast();
      await action();
    }, 'toast-action'));
  }
  box.appendChild(btn('關閉', hideToast, 'toast-close', { 'aria-label': '關閉提示' }));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, kind === 'error' ? 12000 : duration);
}
function hideToast() {
  const box = document.getElementById('toast');
  box.className = 'toast';
  box.replaceChildren();
}

// ---------- 資料寫入（先寫入成功，才更新畫面） ----------
async function commitTrip(newTrip, { rerender = true } = {}) {
  const t = { ...newTrip, updatedAt: C.nowIso() };
  try {
    await DB.putTrip(t);
  } catch (e) {
    toast(`儲存失敗：${e.message || e}。資料未變更，請再試一次。`, { kind: 'error' });
    return false;
  }
  const idx = state.trips.findIndex((x) => x.tripId === t.tripId);
  if (idx >= 0) state.trips[idx] = t; else state.trips.push(t);
  if (rerender) {
    // 編輯表單開啟中：只更新照片區塊，避免清掉尚未儲存的欄位
    if (['stop', 'new'].includes(state.route.name)) refreshFormPhoto();
    else render();
  }
  return true;
}

async function updateStop(stopId, fn) {
  const trip = activeTrip();
  const stop = trip.stops.find((s) => s.id === stopId);
  if (!stop) return false;
  const next = fn(stop);
  return commitTrip({ ...trip, stops: trip.stops.map((s) => (s.id === stopId ? next : s)) });
}

async function setStatus(stopId, status) {
  const trip = activeTrip();
  const before = trip.stops.find((s) => s.id === stopId);
  if (!before) return;
  const ok = await updateStop(stopId, (s) => C.applyStatus(s, status));
  if (!ok) return;
  const msg = status === 'completed' ? `已完成：${before.title}` : status === 'skipped' ? `已略過：${before.title}` : `已改回待前往：${before.title}`;
  toast(msg, {
    actionLabel: '復原',
    action: async () => {
      const ok2 = await updateStop(stopId, () => ({ ...before, updatedAt: C.nowIso() }));
      if (ok2) toast(`已復原：${before.title}`, { duration: 3000 });
    },
  });
}

async function setViewDate(date) {
  state.viewDate = date;
  saveSession();
  render();
}

// ---------- 工作階段（返回 App 時回到原處） ----------
function saveSession() {
  const payload = {
    tripId: state.activeTripId,
    viewDate: state.viewDate,
    hash: location.hash,
    scrollY: window.scrollY,
    savedAt: Date.now(),
  };
  DB.setMeta('session', payload).catch(() => {});
}

// ---------- 路由 ----------
function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = hash.split('/');
  return { name: name || 'today', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
}
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ---------- 主要渲染 ----------
function render() {
  const prevKey = `${state.route.name}/${state.route.arg || ''}`;
  scrollMemory.set(prevKey, window.scrollY);
  state.route = parseRoute();
  const key = `${state.route.name}/${state.route.arg || ''}`;

  const trip = activeTrip();
  renderStatusBar();
  renderTabBar();

  let view;
  if (!trip && !['tripform', 'trips', 'import', 'settings', 'app', 'maptest', 'guide', 'paste'].includes(state.route.name)) {
    view = viewWelcome();
  } else {
    switch (state.route.name) {
      case 'dates': view = viewDates(trip); break;
      case 'edit': view = viewEditDay(trip); break;
      case 'settings': view = viewSettings(trip); break;
      case 'stop': view = viewStopForm(trip, state.route.arg, null); break;
      case 'new': view = viewStopForm(trip, null, state.route.arg); break;
      case 'tripform': view = viewTripForm(state.route.arg === 'new' ? null : trip); break;
      case 'trips': view = viewTrips(); break;
      case 'import': view = viewImport(); break;
      case 'maptest': view = viewMapTest(trip); break;
      case 'guide': view = viewGuide(); break;
      case 'app': view = viewAppSettings(); break;
      case 'photos': view = viewPhotos(trip); break;
      case 'photoassign': view = viewPhotoAssign(trip); break;
      case 'paste': view = viewPaste(); break;
      default: view = viewToday(trip);
    }
  }
  main().replaceChildren(view);
  const y = key === prevKey ? scrollMemory.get(key) : (scrollMemory.get(key) || 0);
  window.scrollTo(0, y || 0);
}

function renderStatusBar() {
  const bar = document.getElementById('statusbar');
  bar.replaceChildren();
  if (!navigator.onLine) {
    bar.appendChild(h('div', { class: 'banner offline', role: 'status' },
      h('strong', { text: '離線中' }),
      '　行程可照常瀏覽與修改；Apple Maps 能否規劃路線取決於網路與您事先下載的離線地圖。'));
  }
  if (state.updateReady) {
    bar.appendChild(h('div', { class: 'banner update', role: 'status' },
      '有新版本可用。',
      btn('重新載入', () => state.updateReady(), 'btn small')));
  }
}

function renderTabBar() {
  const r = state.route.name;
  const tabs = [
    ['today', '今天', '#today'],
    ['dates', '全部日期', '#dates'],
    ['edit', '編輯行程', '#edit'],
    ['settings', '旅程設定', '#settings'],
  ];
  const nav = document.getElementById('tabbar');
  // 分頁都是針對「目前旅程」；在旅程列表或尚無旅程時隱藏，避免誤入上次使用的旅程
  const standalonePages = ['trips', 'app', 'guide', 'paste', 'import', 'maptest', 'photoassign'];
  const hide = standalonePages.includes(r) || (r === 'tripform' && state.route.arg === 'new') || !activeTrip();
  nav.hidden = hide;
  document.body.classList.toggle('no-tabbar', hide);
  if (hide) { nav.replaceChildren(); return; }
  nav.replaceChildren(...tabs.map(([name, label, href]) => {
    const active = r === name || (name === 'edit' && (r === 'stop' || r === 'new'))
      || (name === 'settings' && (r === 'tripform' || r === 'photos'));
    return h('a', { href, class: `tab${active ? ' active' : ''}`, 'aria-current': active ? 'page' : null }, label);
  }));
}

function versionLine() {
  return h('p', { class: 'version', text: `旅程導航助手 v${APP_VERSION}・資料格式 v${C.SCHEMA_VERSION}・無帳號、無追蹤、資料不離開手機` });
}

// ---------- 共用：回到「我的旅程」 ----------
function tripSwitch(title) {
  return h('a', { class: 'trip-switch', href: '#trips', 'aria-label': `回到我的旅程列表（目前：${title}）` },
    h('span', { class: 'trip-switch-home', text: '‹ 我的旅程' }),
    h('span', { class: 'trip-switch-title', text: title }));
}

// ---------- 日夜模式 ----------
function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function effectiveDark() {
  return state.themeMode === 'dark' || (state.themeMode === 'auto' && systemPrefersDark());
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.themeMode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', effectiveDark() ? '#0d1117' : '#0b2545');
}
function setThemeMode(mode) {
  state.themeMode = ['light', 'dark'].includes(mode) ? mode : 'auto';
  try { localStorage.setItem('tc-theme', state.themeMode); } catch { /* 無法保存時僅本次有效 */ }
  applyTheme();
  render();
}
const THEME_LABELS = { auto: '跟隨系統', light: '淺色', dark: '深色' };

function themeToggle() {
  const dark = effectiveDark();
  return h('button', {
    type: 'button', class: 'theme-toggle',
    'aria-label': dark ? '切換為淺色模式' : '切換為深色模式',
    title: `目前：${THEME_LABELS[state.themeMode]}${state.themeMode === 'auto' ? `（${dark ? '深色' : '淺色'}）` : ''}`,
    on: { click: () => { setThemeMode(dark ? 'light' : 'dark'); toast(`已切換為${dark ? '淺色' : '深色'}模式（可在 App 設定改回「跟隨系統」）`, { duration: 3000 }); } },
  }, dark ? '☀︎ 淺色' : '☾ 深色');
}

// ---------- 兩地時間 ----------
function clockText(trip) {
  const home = state.clockPrefs.homeTz;
  if (!state.clockPrefs.show || !home || !C.isValidTimeZone(home)) return null;
  const c = C.dualClock(trip.timeZone, home);
  if (c.same) return null;
  return c;
}

function clockNode(trip) {
  const c = clockText(trip);
  if (!c) return h('span', { class: 'dual-clock', id: 'dual-clock' });
  return h('span', { class: 'dual-clock', id: 'dual-clock', 'aria-live': 'off', dataset: { tz: trip.timeZone } },
    '當地 ', h('strong', { text: c.localTime }), `・${c.homeLabel} `, h('strong', { text: c.homeTime }),
    c.dayShift ? h('span', { class: 'clock-note', title: c.dayNote, text: `(${c.dayShift > 0 ? '+1' : '-1'})` }) : null);
}

let clockTimer = null;
function refreshClock() {
  const el = document.getElementById('dual-clock');
  const trip = activeTrip();
  if (el && trip && document.visibilityState === 'visible') el.replaceWith(clockNode(trip));
}
function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(refreshClock, 30000);
  // 從地圖 App 返回時立即更新，不等下一次計時
  document.addEventListener('visibilitychange', refreshClock);
}

// ---------- 天氣 ----------
const wxMem = new Map();     // 快取鍵 → { fetchedAt, parsed }
const geoMem = new Map();    // 城市 → { lat, lng }
const wxInflight = new Set();

function agoText(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${Math.max(1, m)} 分鐘前`;
  const hr = Math.round(m / 60);
  return hr < 48 ? `${hr} 小時前` : `${Math.round(hr / 24)} 天前`;
}

async function cityCoordsAsync(trip, date, city) {
  const direct = WX.cityCoords(trip, date, city);
  if (direct) return direct;
  const key = PH.normName(city);
  if (geoMem.has(key)) return geoMem.get(key);
  const saved = await DB.getMeta(`geo:${key}`, null).catch(() => null);
  if (saved) { geoMem.set(key, saved); return saved; }
  if (!navigator.onLine) return null;
  // cache: 'no-store'：App 自有快取；避免沿用瀏覽器中缺少 CORS 標頭的舊快取
  const res = await fetch(WX.geocodeUrl(city), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  if (!res.ok) return null;
  const r = (await res.json()).results?.[0];
  if (!r) return null;
  const c = { lat: Math.round(r.latitude * 100) / 100, lng: Math.round(r.longitude * 100) / 100 };
  geoMem.set(key, c);
  DB.setMeta(`geo:${key}`, c).catch(() => {});
  return c;
}

/** 取得（必要時更新）某城市的預報；回傳 { fetchedAt, parsed } 或 null */
async function ensureWeather(trip, date, city) {
  const coords = await cityCoordsAsync(trip, date, city).catch(() => null);
  if (!coords) return null;
  const key = WX.cacheKey(coords);
  let entry = wxMem.get(key) || await DB.getMeta(key, null).catch(() => null);
  if (entry) wxMem.set(key, entry);
  const stale = !entry || Date.now() - entry.fetchedAt > WX.WEATHER_TTL_MS;
  if (stale && navigator.onLine && !wxInflight.has(key)) {
    wxInflight.add(key);
    try {
      const res = await fetch(WX.forecastUrl(coords.lat, coords.lng, trip.timeZone), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if (res.ok) {
        entry = { fetchedAt: Date.now(), parsed: WX.parseForecast(await res.json()) };
        wxMem.set(key, entry);
        DB.setMeta(key, entry).catch(() => {});
      }
    } catch { /* 沿用舊資料 */ } finally { wxInflight.delete(key); }
  }
  return entry || null;
}

function weatherRow(trip) {
  const row = h('div', { class: 'weather-row', id: 'weather-row' });
  if (!state.weatherPrefs.show) return row;
  const date = state.viewDate;
  const cities = C.citiesForDate(trip, date);
  if (!cities.length) return row;
  const viewing = `${trip.tripId}|${date}`;
  row.dataset.viewing = viewing;
  Promise.all(cities.map((c) => ensureWeather(trip, date, c).then((e) => [c, e]).catch(() => [c, null]))).then((list) => {
    const el = document.getElementById('weather-row');
    if (!el || el.dataset.viewing !== viewing) return; // 已切換日期
    const chips = [];
    let oldest = null;
    const today = C.dateInTimeZone(trip.timeZone);
    for (const [city, entry] of list) {
      if (!entry) continue;
      const d = WX.describeDay(entry.parsed, date, { today });
      if (!d) {
        const lastDay = Object.keys(entry.parsed.daily).sort().pop();
        if (lastDay && date > lastDay) chips.push(h('span', { class: 'wx-chip muted', text: `${city}：約兩週內才有預報` }));
        continue;
      }
      oldest = oldest == null ? entry.fetchedAt : Math.min(oldest, entry.fetchedAt);
      chips.push(h('span', { class: 'wx-chip', title: d.text },
        h('span', { class: 'wx-city', text: city }), ` ${d.icon} `,
        d.now ? h('strong', { text: `${d.now} ` }) : null, d.temp, d.rain ? h('span', { class: 'wx-rain', text: ` ${d.rain}` }) : null));
    }
    if (!chips.length) { el.replaceChildren(); return; }
    const staleNote = oldest && Date.now() - oldest > WX.WEATHER_TTL_MS ? `（${agoText(oldest)}的資料）` : '';
    el.replaceChildren(...chips, h('a', { class: 'wx-src', href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer' }, `Open-Meteo${staleNote}`));
  });
  return row;
}

// ---------- 共用：頁首與日期切換 ----------
function dayHeader(trip, { title } = {}) {
  const dates = C.listDates(trip.startDate, trip.endDate);
  const idx = dates.indexOf(state.viewDate);
  const cities = C.citiesForDate(trip, state.viewDate);
  const isToday = state.viewDate === state.todayInTrip;
  const select = h('select', {
    class: 'date-select', 'aria-label': '選擇日期',
    on: { change: (e) => setViewDate(e.target.value) },
  }, dates.map((d) => h('option', { value: d, selected: d === state.viewDate },
    `${C.formatDateShort(d)}${d === state.todayInTrip ? '・今天' : ''}`)));

  return h('header', { class: 'day-header' },
    tripSwitch(title || trip.title),
    h('div', { class: 'date-row' },
      btn('‹ 前一天', () => setViewDate(dates[idx - 1]), 'btn ghost date-step', { disabled: idx <= 0, 'aria-label': '前一天' }),
      select,
      btn('後一天 ›', () => setViewDate(dates[idx + 1]), 'btn ghost date-step', { disabled: idx < 0 || idx >= dates.length - 1, 'aria-label': '後一天' })),
    h('div', { class: 'clock-row' }, clockNode(trip), themeToggle()),
    weatherRow(trip),
    h('div', { class: 'date-meta' },
      isToday ? h('span', { class: 'chip today', text: '今天' }) : null,
      state.phase === 'before' && !isToday ? h('span', { class: 'chip preview', text: '行前預覽' }) : null,
      cities.map((c) => h('span', { class: 'chip city', text: c }))));
}

// ---------- 導航按鈕 ----------
function mapOpts(trip) {
  return { provider: state.mapPrefs.provider, appleStyle: state.mapPrefs.appleStyle };
}
function providerName(trip) {
  return state.mapPrefs.provider === 'google' ? 'Google 地圖' : 'Apple Maps';
}

function navButton(trip, stop, { big = false } = {}) {
  const mode = state.modeOverride[stop.id] || stop.defaultMode;
  const url = C.buildDirectionsUrl(stop, mode, mapOpts(trip));
  const cls = `btn nav${big ? ' big' : ''}`;
  if (!url) {
    return h('a', { class: `${cls} disabled`, href: `#stop/${encodeURIComponent(stop.id)}`, 'aria-label': `${stop.title}：補上地址才能導航` },
      '補上地址或座標才能導航');
  }
  // 使用真實的 <a href>：讓 iOS 以使用者點擊直接交給地圖 App，不經過任何非同步等待
  return h('a', { class: cls, href: url, rel: 'noopener', 'aria-label': `以 ${providerName(trip)} ${C.MODE_LABELS[mode]}導航至 ${stop.title}` },
    `開啟 ${providerName(trip)} · ${C.MODE_LABELS[mode]}`);
}

function modeSwitcher(stop) {
  const current = state.modeOverride[stop.id] || stop.defaultMode;
  return h('div', { class: 'mode-switch', role: 'group', 'aria-label': '本次交通方式' },
    C.MODES.map((m) => h('button', {
      type: 'button',
      class: `seg${m === current ? ' on' : ''}`,
      'aria-pressed': m === current ? 'true' : 'false',
      on: {
        click: () => {
          if (m === stop.defaultMode) delete state.modeOverride[stop.id];
          else state.modeOverride[stop.id] = m;
          render();
        },
      },
    }, C.MODE_LABELS[m])));
}

function destinationTag(stop) {
  const d = C.resolveDestination(stop);
  if (!d.level) return h('span', { class: 'tag warn', text: '尚未設定可靠導航地點' });
  if (d.level === 'name') return h('span', { class: 'tag warn', text: '定位待確認（僅名稱搜尋）' });
  if (!stop.destinationConfirmed) return h('span', { class: 'tag caution', text: `定位待確認・${C.DESTINATION_LEVEL_LABELS[d.level]}` });
  return h('span', { class: 'tag ok', text: `已確認・${C.DESTINATION_LEVEL_LABELS[d.level]}` });
}

function statusBadge(stop) {
  const icon = stop.status === 'completed' ? '✓ ' : stop.status === 'skipped' ? '⤼ ' : '○ ';
  return h('span', { class: `badge ${stop.status}` }, icon + C.STATUS_LABELS[stop.status]);
}

function timeText(stop) {
  if (stop.startTime && stop.endTime) return `${stop.startTime}–${stop.endTime}`;
  return stop.startTime || '';
}

function stopNames(stop) {
  return [
    h('span', { class: 'stop-title', text: stop.title }),
    stop.localName && stop.localName !== stop.title ? h('span', { class: 'stop-local', lang: 'und', text: stop.localName }) : null,
  ];
}

function fallbackActions(trip, stop) {
  const placeUrl = C.buildPlaceUrl(stop, { provider: state.mapPrefs.provider });
  const text = C.copyableLocation(stop);
  return h('div', { class: 'fallback-row' },
    btn('複製地址／座標', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('已複製', { duration: 2500 });
      } catch {
        window.prompt('請手動複製：', text);
      }
    }, 'btn ghost small'),
    placeUrl ? h('a', { class: 'btn ghost small', href: placeUrl, rel: 'noopener' }, '在地圖中查看地點') : null,
    stop.referenceUrl && C.isSafeHttpsUrl(stop.referenceUrl)
      ? h('a', { class: 'btn ghost small', href: stop.referenceUrl, target: '_blank', rel: 'noopener noreferrer' }, '參考網頁')
      : null);
}

function statusButtons(stop) {
  if (stop.status === 'pending') {
    return h('div', { class: 'status-row' },
      btn('✓ 標記已完成', () => setStatus(stop.id, 'completed'), 'btn done'),
      btn('略過', () => setStatus(stop.id, 'skipped'), 'btn skip'));
  }
  return h('div', { class: 'status-row' },
    btn('改回待前往', () => setStatus(stop.id, 'pending'), 'btn ghost'));
}

// ---------- 今天（日檢視） ----------
function viewToday(trip) {
  const stops = C.stopsForDate(trip, state.viewDate);
  const p = C.progress(stops);
  const next = C.nextStop(trip, state.viewDate);
  const wrap = h('div', { class: 'view today-view' }, dayHeader(trip));

  if (stops.length) {
    wrap.appendChild(h('section', { class: 'progress', 'aria-label': '本日進度' },
      h('div', { class: 'progress-nums' },
        h('span', null, h('strong', { text: `已完成 ${p.completed}` }), ` / 有效行程 ${p.total}`),
        h('span', { class: 'skipped-num', text: `略過 ${p.skipped}` })),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(p.total), 'aria-valuenow': String(p.completed) },
        h('div', { class: 'bar-done', style: `width:${(p.completedRatio * 100).toFixed(1)}%` }),
        h('div', { class: 'bar-skip', style: `width:${((p.handledRatio - p.completedRatio) * 100).toFixed(1)}%` }))));
  }

  if (!stops.length) {
    wrap.appendChild(h('section', { class: 'empty' },
      h('p', { text: '這一天還沒有任何停靠點。' }),
      h('a', { class: 'btn primary', href: `#new/${state.viewDate}` }, '＋ 新增停靠點'),
      C.candidates(trip).length ? h('a', { class: 'btn ghost', href: '#edit' }, `從候選景點排入（${C.candidates(trip).length}）`) : null));
    appendChildren(wrap, [onboardingCard(trip), backupReminder(trip)]);
    return wrap;
  }

  if (next) {
    wrap.appendChild(nextCard(trip, next));
  } else {
    wrap.appendChild(h('section', { class: 'all-done' },
      h('h2', { text: '本日所有行程已處理' }),
      h('p', { text: `完成 ${p.completed} 項，略過 ${p.skipped} 項。` }),
      h('p', { class: 'hint', text: '若當日行程結束，建議到「旅程設定」按「立即完整備份」。' })));
  }

  // 提醒放在下一站之後，讓主要導航按鈕維持在畫面上方
  appendChildren(wrap, [onboardingCard(trip), backupReminder(trip)]);

  const others = stops.filter((s) => !next || s.id !== next.id);
  if (others.length) {
    wrap.appendChild(h('h2', { class: 'section-title', text: next ? '本日其他行程' : '本日行程' }));
    wrap.appendChild(h('ol', { class: 'stop-list' }, others.map((s) => h('li', null, listCard(trip, s, stops.indexOf(s) + 1)))));
  }
  wrap.appendChild(h('div', { class: 'add-row' }, h('a', { class: 'btn ghost', href: `#new/${state.viewDate}` }, '＋ 新增停靠點')));
  return wrap;
}

// ---------- 縮圖 ----------
const photoUrls = new Map();     // thumbUrl → objectURL（避免重複讀取）
const photoLookups = new Set();  // 本次開啟已嘗試查詢的停靠點
const expandedPhotos = new Set();

function safeHttps(u) {
  return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
}

/** 將圖片載入 img：先讀本機快取；允許即時下載且有網路時才連線。 */
async function fillPhoto(img, holder, url) {
  try {
    if (photoUrls.has(url)) { img.src = photoUrls.get(url); return; }
    let blob = await PH.cachedBlob(url);
    if (!blob && state.photoPrefs.allowLive && navigator.onLine) blob = await PH.downloadToCache(url);
    if (!blob) { holder.remove(); return; }
    const ou = URL.createObjectURL(blob);
    photoUrls.set(url, ou);
    img.src = ou;
  } catch {
    holder.remove();
  }
}

async function liveLookup(stopId) {
  const trip = activeTrip();
  const stop = trip && trip.stops.find((x) => x.id === stopId);
  if (!stop || stop.photo) return;
  try {
    const photo = await PH.lookupPhoto(stop);
    if (photo) await updateStop(stopId, (x) => ({ ...x, photo }));
  } catch { /* 查詢失敗不影響行程操作 */ }
}

/**
 * 停靠點實際要顯示的「我的照片」：
 *  - { none: true }：這一站設定為不顯示照片
 *  - { rec, inherited: false }：這一站自己的照片
 *  - { rec, inherited: true, from }：沿用同一地點（例如連住多晚的飯店）其他停靠點的照片
 */
function userPhotoInfo(stop, trip = activeTrip()) {
  if (!stop) return null;
  const up = stop.userPhoto;
  if (up && up.none) return { none: true };
  if (up && up.id && state.images.has(up.id)) return { rec: state.images.get(up.id), inherited: false };
  if (!trip) return null;
  const src = IM.findSamePlaceWithPhoto(trip.stops, stop, (id) => state.images.has(id));
  return src ? { rec: state.images.get(src.userPhoto.id), inherited: true, from: src } : null;
}

function userPhotoOf(stop) {
  const i = userPhotoInfo(stop);
  return i && i.rec ? i.rec : null;
}

function samePlaceLabel(from) {
  return `「${from.title}」${from.date ? `・${C.formatDateShort(from.date)}` : ''}`;
}

function userPhotoBlock(stop, variant) {
  const info = userPhotoInfo(stop);
  const rec = info && info.rec;
  const big = variant === 'wide' || expandedPhotos.has(stop.id);
  return h('figure', { class: `photo ${big ? 'wide' : 'side'}` },
    h('button', {
      type: 'button', class: 'photo-btn', 'aria-label': big ? '縮小照片' : '放大照片',
      on: { click: () => { if (variant === 'side') { if (expandedPhotos.has(stop.id)) expandedPhotos.delete(stop.id); else expandedPhotos.add(stop.id); render(); } } },
    }, h('img', { alt: `${stop.title}（我的照片）`, src: IM.dataUrl(rec), decoding: 'async' })),
    big ? h('figcaption', null, h('span', { class: 'photo-credit', text: info.inherited ? `我的照片（沿用同一地點 ${samePlaceLabel(info.from)}）` : '我的照片' })) : null);
}

function photoBlock(stop, { variant = 'wide' } = {}) {
  // 自己的照片（含沿用同一地點）優先顯示，且不受維基百科照片開關影響（完全本機、不連網）
  const upi = userPhotoInfo(stop);
  if (upi && upi.none) return null;
  if (upi && upi.rec) return userPhotoBlock(stop, variant);
  if (!state.photoPrefs.enabled || !PH.wantsPhoto(stop)) return null;
  const ph = stop.photo;
  if (!ph) {
    if (state.photoPrefs.allowLive && navigator.onLine && !photoLookups.has(stop.id)) {
      photoLookups.add(stop.id);
      liveLookup(stop.id);
    }
    return null;
  }
  if (ph.hidden || !PH.isWikimediaUrl(ph.thumbUrl)) return null;
  const big = variant === 'wide' || expandedPhotos.has(stop.id);
  const img = h('img', { alt: `${stop.title} 的參考照片`, loading: 'lazy', decoding: 'async' });
  const credit = [ph.artist || '作者不詳', ph.license].filter(Boolean).join('・');
  const fig = h('figure', { class: `photo ${big ? 'wide' : 'side'}` },
    h('button', {
      type: 'button', class: 'photo-btn', 'aria-label': big ? '縮小照片' : '放大照片',
      on: { click: () => { if (variant === 'side') { if (expandedPhotos.has(stop.id)) expandedPhotos.delete(stop.id); else expandedPhotos.add(stop.id); render(); } } },
    }, img),
    big ? h('figcaption', null,
      ph.confidence === 'low' ? h('span', { class: 'photo-warn', text: '自動配對，可能不是這個地點' }) : null,
      h('span', { class: 'photo-credit' },
        '圖片：', safeHttps(ph.fileUrl) ? h('a', { href: ph.fileUrl, target: '_blank', rel: 'noopener noreferrer' }, credit) : credit,
        ph.licenseUrl && safeHttps(ph.licenseUrl) ? [' ', h('a', { href: ph.licenseUrl, target: '_blank', rel: 'noopener noreferrer' }, '授權')] : null,
        '・維基百科：', safeHttps(ph.pageUrl) ? h('a', { href: ph.pageUrl, target: '_blank', rel: 'noopener noreferrer' }, ph.title) : ph.title),
      btn('不是這張', () => rejectPhoto(stop.id), 'btn ghost small')) : null);
  fillPhoto(img, fig, ph.thumbUrl);
  return fig;
}

/** 以使用者點擊開啟檔案選擇器（iOS 會提供「照片圖庫／拍照／選擇檔案」） */
function pickImages({ multiple = false } = {}, onFiles) {
  const input = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
  if (multiple) input.multiple = true;
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.remove();
    if (files.length) onFiles(files);
  });
  document.body.appendChild(input);
  input.click();
}

async function saveUserPhoto(stopId, file) {
  let rec;
  try {
    const r = await IM.resizeToJpeg(file);
    rec = { id: C.uuid(), ...r, createdAt: C.nowIso() };
    await DB.putImages([rec]);
  } catch (e) {
    toast(`照片處理失敗：${e.message || e}`, { kind: 'error' });
    return false;
  }
  state.images.set(rec.id, rec);
  const trip = activeTrip();
  const before = trip.stops.find((x) => x.id === stopId);
  const ok = await updateStop(stopId, (x) => ({ ...x, userPhoto: { id: rec.id, addedAt: rec.createdAt } }));
  if (ok) {
    toast(`已加入照片（約 ${Math.round(rec.bytes / 1024)} KB）`, {
      duration: 4000,
      actionLabel: before && before.userPhoto ? '復原' : null,
      action: before && before.userPhoto ? () => updateStop(stopId, (x) => ({ ...x, userPhoto: before.userPhoto })) : null,
    });
  }
  return ok;
}

async function removeUserPhoto(stopId) {
  const trip = activeTrip();
  const before = trip.stops.find((x) => x.id === stopId);
  if (!before || !before.userPhoto) return;
  const ok = await updateStop(stopId, (x) => ({ ...x, userPhoto: null }));
  if (ok) toast('已移除我的照片', { actionLabel: '復原', action: () => updateStop(stopId, (x) => ({ ...x, userPhoto: before.userPhoto })) });
}

async function setNoPhoto(stopId, none) {
  const before = activeTrip().stops.find((x) => x.id === stopId);
  const ok = await updateStop(stopId, (x) => ({ ...x, userPhoto: none ? { none: true } : null }));
  if (ok && none) toast('這一站不再顯示照片', { actionLabel: '復原', action: () => updateStop(stopId, (x) => ({ ...x, userPhoto: before.userPhoto || null })) });
}

/** 刪除不再被任何停靠點引用的照片（啟動時與刪除旅程後執行） */
async function gcImages() {
  const used = C.referencedImageIds(state.trips);
  const orphans = [...state.images.keys()].filter((id) => !used.has(id));
  if (!orphans.length) return;
  try {
    await DB.deleteImages(orphans);
    orphans.forEach((id) => state.images.delete(id));
  } catch { /* 下次再清 */ }
}

async function rejectPhoto(stopId) {
  const trip = activeTrip();
  const before = trip.stops.find((x) => x.id === stopId);
  if (!before || !before.photo) return;
  const ok = await updateStop(stopId, (x) => ({ ...x, photo: { ...x.photo, hidden: true } }));
  if (ok) {
    toast('已隱藏這張照片。可到「編輯」重新搜尋另一張。', {
      actionLabel: '復原',
      action: () => updateStop(stopId, (x) => ({ ...x, photo: before.photo })),
    });
  }
}

function nextCard(trip, stop) {
  const d = C.resolveDestination(stop);
  return h('section', { class: 'next-card', 'aria-label': '下一站' },
    h('div', { class: 'next-label' }, '下一站'),
    h('div', { class: 'next-head' },
      h('h2', { class: 'next-name' }, stopNames(stop)),
      photoBlock(stop, { variant: 'side' })),
    h('div', { class: 'meta-row' },
      timeText(stop) ? h('span', { class: 'meta time', text: timeText(stop) }) : null,
      stop.city ? h('span', { class: 'meta', text: stop.city }) : null,
      h('span', { class: 'meta', text: C.TYPE_LABELS[stop.type] }),
      destinationTag(stop)),
    stop.notes ? h('p', { class: 'notes', text: stop.notes }) : null,
    navButton(trip, stop, { big: true }),
    d.level ? modeSwitcher(stop) : h('a', { class: 'btn ghost', href: `#stop/${encodeURIComponent(stop.id)}` }, '前往編輯，補上地址或座標'),
    statusButtons(stop),
    h('details', { class: 'more' },
      h('summary', null, '備援與編輯'),
      fallbackActions(trip, stop),
      h('a', { class: 'btn ghost small', href: `#stop/${encodeURIComponent(stop.id)}` }, '編輯此停靠點')));
}

function listCard(trip, stop, n) {
  const open = state.expanded.has(stop.id);
  const card = h('article', { class: `stop-card ${stop.status}${open ? ' open' : ''}` },
    h('button', {
      type: 'button', class: 'card-head', 'aria-expanded': open ? 'true' : 'false',
      on: {
        click: () => {
          if (state.expanded.has(stop.id)) state.expanded.delete(stop.id); else state.expanded.add(stop.id);
          render();
        },
      },
    },
    h('span', { class: 'num', text: String(n) }),
    h('span', { class: 'head-main' },
      h('span', { class: 'head-names' }, stopNames(stop)),
      h('span', { class: 'head-meta' },
        [timeText(stop), stop.city, C.MODE_LABELS[stop.defaultMode]].filter(Boolean).join('・'))),
    statusBadge(stop)));

  if (open) {
    card.appendChild(h('div', { class: 'card-body' },
      photoBlock(stop, { variant: 'wide' }),
      h('div', { class: 'meta-row' }, destinationTag(stop)),
      stop.notes ? h('p', { class: 'notes', text: stop.notes }) : null,
      navButton(trip, stop),
      C.resolveDestination(stop).level ? modeSwitcher(stop) : null,
      statusButtons(stop),
      fallbackActions(trip, stop),
      h('a', { class: 'btn ghost small', href: `#stop/${encodeURIComponent(stop.id)}` }, '編輯')));
  } else if (stop.status === 'pending') {
    card.appendChild(h('div', { class: 'card-quick' }, navButton(trip, stop)));
  }
  return card;
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function onboardingCard() {
  if (state.onboardingDismissed) return null;
  const items = [];
  if (!isStandalone()) items.push('用 Safari 開啟本頁 → 分享 → 「加入主畫面」，之後一律從主畫面圖示開啟（主畫面 App 與 Safari 的資料可能分開保存）。');
  items.push('出發前請先在 Apple Maps 下載各城市的離線地圖（設定在 Apple Maps 內，本網頁無法代勞）。');
  items.push('資料只存在這支手機。請在出發前與每天結束後，到「旅程設定」或首頁的「App 設定／備份」匯出備份。');
  items.push('開啟地圖不會自動標記完成；到達或放棄後，請回到這裡手動標記。');
  return h('section', { class: 'onboarding' },
    h('h2', { text: '使用前提醒' }),
    h('ul', null, items.map((t) => h('li', { text: t }))),
    btn('我知道了', async () => {
      state.onboardingDismissed = true;
      await DB.setMeta('onboardingDismissed', true).catch(() => {});
      render();
    }, 'btn ghost small'));
}

function backupReminder(trip) {
  if (!trip.stops.length) return null;
  const last = state.lastExportAt ? new Date(state.lastExportAt) : null;
  const stale = !last || (Date.now() - last.getTime()) > 24 * 3600 * 1000;
  if (!stale) return null;
  return h('section', { class: 'reminder' },
    h('span', { text: last ? `上次備份：${formatLocalTime(state.lastExportAt, trip.timeZone)}（超過一天）` : '尚未匯出過備份' }),
    btn('立即備份', () => exportBackup(), 'btn small'));
}

// ---------- 全部日期 ----------
function viewDates(trip) {
  const dates = C.listDates(trip.startDate, trip.endDate);
  const cands = C.candidates(trip);
  const all = C.progress(trip.stops.filter((s) => s.date !== null));
  return h('div', { class: 'view dates-view' },
    h('header', { class: 'page-header' },
      tripSwitch(trip.title),
      h('p', { class: 'sub', text: `${C.formatDateShort(trip.startDate)} – ${C.formatDateShort(trip.endDate)}・時區 ${trip.timeZone}` }),
      h('p', { class: 'sub', text: `全程：完成 ${all.completed} / ${all.total}，略過 ${all.skipped}` })),
    h('ul', { class: 'date-list' }, dates.map((d) => {
      const stops = C.stopsForDate(trip, d);
      const p = C.progress(stops);
      const next = C.nextStop(trip, d);
      const cities = C.citiesForDate(trip, d);
      return h('li', null, h('button', {
        type: 'button', class: `date-item${d === state.todayInTrip ? ' is-today' : ''}`,
        on: { click: () => { state.viewDate = d; saveSession(); go('#today'); } },
      },
      h('span', { class: 'date-item-top' },
        h('strong', { text: C.formatDateShort(d) }),
        d === state.todayInTrip ? h('span', { class: 'chip today', text: '今天' }) : null,
        cities.map((c) => h('span', { class: 'chip city', text: c }))),
      h('span', { class: 'date-item-sub', text: stops.length ? `完成 ${p.completed} / ${p.total}・略過 ${p.skipped}${next ? `・下一站：${next.title}` : '・已全部處理'}` : '尚無停靠點' })));
    })),
    h('section', { class: 'cand-summary' },
      h('h2', { class: 'section-title', text: `候選景點（${cands.length}）` }),
      cands.length
        ? h('ul', { class: 'plain-list' }, cands.map((s) => h('li', null, h('a', { href: `#stop/${encodeURIComponent(s.id)}` }, s.title), s.city ? `（${s.city}）` : '')))
        : h('p', { class: 'hint', text: '尚未確定日期的地點可以先放在這裡，之後再排入某一天。' }),
      h('a', { class: 'btn ghost', href: '#new/candidates' }, '＋ 新增候選景點')));
}

// ---------- 編輯行程（排序、刪除、候選） ----------
function viewEditDay(trip) {
  const stops = C.stopsForDate(trip, state.viewDate);
  const cands = C.candidates(trip);
  const wrap = h('div', { class: 'view edit-view' }, dayHeader(trip, { title: `編輯行程・${trip.title}` }));
  wrap.appendChild(h('div', { class: 'btn-row edit-top' },
    h('a', { class: 'btn ghost small', href: '#photos' }, '照片整理')));
  wrap.appendChild(h('p', { class: 'hint', text: '用「上移／下移」調整順序；下一站依此順序決定，不會依時間自動重排。' }));

  if (!stops.length) wrap.appendChild(h('p', { class: 'empty-line', text: '這一天沒有停靠點。' }));
  wrap.appendChild(h('ol', { class: 'edit-list' }, stops.map((s, i) => h('li', { class: `edit-item ${s.status}` },
    h('div', { class: 'edit-info' },
      h('span', { class: 'num', text: String(i + 1) }),
      h('span', { class: 'edit-names' }, stopNames(s), h('span', { class: 'head-meta', text: [timeText(s), s.city, C.STATUS_LABELS[s.status]].filter(Boolean).join('・') }))),
    h('div', { class: 'edit-actions' },
      btn('↑ 上移', () => reorder(s.id, -1), 'btn ghost small', { disabled: i === 0, 'aria-label': `上移 ${s.title}` }),
      btn('↓ 下移', () => reorder(s.id, 1), 'btn ghost small', { disabled: i === stops.length - 1, 'aria-label': `下移 ${s.title}` }),
      h('a', { class: 'btn ghost small', href: `#stop/${encodeURIComponent(s.id)}` }, '編輯'),
      btn('移到候選', () => moveToDate(s.id, null), 'btn ghost small'),
      btn('刪除', () => deleteStop(s.id), 'btn danger small'))))));

  wrap.appendChild(h('div', { class: 'add-row' }, h('a', { class: 'btn primary', href: `#new/${state.viewDate}` }, `＋ 在 ${C.formatDateShort(state.viewDate)} 新增停靠點`)));

  wrap.appendChild(h('h2', { class: 'section-title', text: `候選景點（${cands.length}）` }));
  wrap.appendChild(h('p', { class: 'hint', text: '尚未決定日期的地點；按「排入本日」會加到目前所選日期的最後。' }));
  wrap.appendChild(h('ul', { class: 'edit-list' }, cands.map((s) => h('li', { class: 'edit-item' },
    h('div', { class: 'edit-info' }, h('span', { class: 'edit-names' }, stopNames(s), s.city ? h('span', { class: 'head-meta', text: s.city }) : null)),
    h('div', { class: 'edit-actions' },
      btn(`排入 ${C.formatDateShort(state.viewDate)}`, () => moveToDate(s.id, state.viewDate), 'btn small'),
      h('a', { class: 'btn ghost small', href: `#stop/${encodeURIComponent(s.id)}` }, '編輯'),
      btn('刪除', () => deleteStop(s.id), 'btn danger small'))))));
  wrap.appendChild(h('div', { class: 'add-row' }, h('a', { class: 'btn ghost', href: '#new/candidates' }, '＋ 新增候選景點')));
  return wrap;
}

async function reorder(stopId, delta) {
  const trip = activeTrip();
  const stops = C.moveStop(trip.stops, stopId, delta);
  if (stops !== trip.stops) await commitTrip({ ...trip, stops });
}

async function moveToDate(stopId, date) {
  const trip = activeTrip();
  const before = trip.stops;
  const ok = await commitTrip({ ...trip, stops: C.moveStopToDate(trip, stopId, date) });
  if (ok) {
    const s = trip.stops.find((x) => x.id === stopId);
    toast(date ? `已排入 ${C.formatDateShort(date)}：${s.title}` : `已移到候選：${s.title}`, {
      actionLabel: '復原',
      action: () => commitTrip({ ...activeTrip(), stops: before }),
    });
  }
}

async function deleteStop(stopId) {
  const trip = activeTrip();
  const s = trip.stops.find((x) => x.id === stopId);
  if (!s) return;
  if (!window.confirm(`確定刪除「${s.title}」？`)) return;
  const before = trip.stops;
  let stops = trip.stops.filter((x) => x.id !== stopId);
  stops = C.normalizeOrders(stops, s.date);
  const ok = await commitTrip({ ...trip, stops });
  if (ok) {
    if (state.route.name === 'stop') go('#edit');
    toast(`已刪除：${s.title}`, {
      actionLabel: '復原',
      action: () => commitTrip({ ...activeTrip(), stops: before }),
      duration: 10000,
    });
  }
}

// ---------- 停靠點表單 ----------
function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input, hint ? h('span', { class: 'field-hint', text: hint }) : null);
}

function viewStopForm(trip, stopId, newDateArg) {
  const existing = stopId ? trip.stops.find((s) => s.id === stopId) : null;
  if (stopId && !existing) {
    return h('div', { class: 'view' }, h('p', { text: '找不到這個停靠點（可能已刪除）。' }), h('a', { class: 'btn', href: '#edit' }, '回到編輯行程'));
  }
  const initDate = existing ? existing.date : (newDateArg === 'candidates' ? null : (C.isValidDateString(newDateArg) ? newDateArg : state.viewDate));
  const s = existing || C.createStop(trip, { date: initDate });
  const dates = C.listDates(trip.startDate, trip.endDate);

  const inp = {
    title: h('input', { type: 'text', value: s.title || '', required: true, autocomplete: 'off', placeholder: '例：卡爾教堂' }),
    localName: h('input', { type: 'text', value: s.localName || '', autocomplete: 'off', placeholder: '例：Karlskirche', lang: 'und' }),
    city: h('input', { type: 'text', value: s.city || '', autocomplete: 'off', placeholder: '例：Vienna / Budapest', list: 'city-list' }),
    type: h('select', null, C.STOP_TYPES.map((t) => h('option', { value: t, selected: t === s.type }, C.TYPE_LABELS[t]))),
    date: h('select', null,
      h('option', { value: '', selected: s.date === null }, '候選景點（未排日期）'),
      dates.map((d) => h('option', { value: d, selected: d === s.date }, C.formatDateShort(d)))),
    startTime: h('input', { type: 'time', value: s.startTime || '' }),
    endTime: h('input', { type: 'time', value: s.endTime || '' }),
    address: h('textarea', { rows: '2', placeholder: '完整地址（含郵遞區號與城市）', lang: 'und' }),
    coordinates: h('input', { type: 'text', inputmode: 'decimal', value: C.formatCoords(s.coordinates), placeholder: '緯度, 經度（例：48.1982, 16.3719）', autocomplete: 'off' }),
    entrance: h('input', { type: 'text', inputmode: 'decimal', value: C.formatCoords(s.entranceCoordinates), placeholder: '入口的 緯度, 經度（選填，優先使用）', autocomplete: 'off' }),
    confirmed: h('input', { type: 'checkbox', checked: !!s.destinationConfirmed }),
    mode: h('select', null, C.MODES.map((m) => h('option', { value: m, selected: m === s.defaultMode }, C.MODE_LABELS[m]))),
    url: h('input', { type: 'url', value: s.referenceUrl || '', placeholder: 'https://（選填，例如官方網站或票券查詢頁）', autocomplete: 'off' }),
    notes: h('textarea', { rows: '3', placeholder: '純文字備註（請勿填入票證密碼）' }),
  };
  inp.address.value = s.address || '';
  inp.notes.value = s.notes || '';

  const errorBox = h('div', { class: 'form-errors', role: 'alert' });
  const preview = h('div', { class: 'dest-preview' });

  function collect() {
    const errors = [];
    const title = inp.title.value.trim();
    if (!title) errors.push('請填寫名稱。');
    const coordsText = inp.coordinates.value.trim();
    const entText = inp.entrance.value.trim();
    const coordinates = coordsText ? C.parseCoordsInput(coordsText) : null;
    const entranceCoordinates = entText ? C.parseCoordsInput(entText) : null;
    if (coordsText && !coordinates) errors.push('地點座標格式應為「緯度, 經度」，且在合理範圍內。');
    if (entText && !entranceCoordinates) errors.push('入口座標格式應為「緯度, 經度」，且在合理範圍內。');
    const url = inp.url.value.trim();
    if (url && !C.isSafeHttpsUrl(url)) errors.push('參考網址只接受 https:// 開頭。');
    const st = inp.startTime.value || null;
    const et = inp.endTime.value || null;
    if (st && et && et < st) errors.push('結束時間早於開始時間。');
    const draft = {
      ...s,
      title,
      localName: inp.localName.value.trim() || null,
      city: inp.city.value.trim(),
      type: inp.type.value,
      date: inp.date.value || null,
      startTime: st,
      endTime: et,
      address: inp.address.value.trim() || null,
      coordinates,
      entranceCoordinates,
      destinationConfirmed: inp.confirmed.checked,
      defaultMode: inp.mode.value,
      referenceUrl: url || null,
      notes: inp.notes.value.trim() || null,
      // 照片（維基百科與我的照片）可能在表單開啟期間被更新，以資料庫中最新的為準
      photo: ((activeTrip().stops.find((x) => x.id === s.id)) || s).photo || null,
      userPhoto: ((activeTrip().stops.find((x) => x.id === s.id)) || s).userPhoto || null,
      updatedAt: C.nowIso(),
    };
    return { errors, draft };
  }

  function updatePreview() {
    const { draft } = collect();
    const d = C.resolveDestination(draft);
    preview.replaceChildren(
      h('strong', { text: '導航目的地：' }),
      d.level ? `${C.DESTINATION_LEVEL_LABELS[d.level]} → ${d.value}` : '尚無（需要地址、座標，或名稱＋城市）');
    preview.className = `dest-preview ${d.level ? (d.level === 'name' ? 'warn' : 'ok') : 'none'}`;
  }
  Object.values(inp).forEach((el) => el.addEventListener('input', updatePreview));
  updatePreview();

  async function save() {
    const { errors, draft } = collect();
    errorBox.replaceChildren(...errors.map((e) => h('p', { text: e })));
    if (errors.length) {
      errorBox.scrollIntoView({ block: 'center' });
      return;
    }
    let stops;
    if (existing) {
      if (existing.date !== draft.date) {
        // 改日期：排到新日期的最後，並整理舊日期順序
        draft.order = C.nextOrder(trip, draft.date);
        stops = trip.stops.map((x) => (x.id === draft.id ? draft : x));
        stops = C.normalizeOrders(stops, existing.date);
      } else {
        stops = trip.stops.map((x) => (x.id === draft.id ? draft : x));
      }
    } else {
      draft.order = C.nextOrder(trip, draft.date);
      stops = [...trip.stops, draft];
    }
    const ok = await commitTrip({ ...trip, stops }, { rerender: false });
    if (!ok) return; // 表單內容保留，可直接重試
    toast(existing ? `已儲存：${draft.title}` : `已新增：${draft.title}`, { duration: 2500 });
    if (draft.date) state.viewDate = draft.date;
    history.length > 1 && existing ? history.back() : go(draft.date ? '#today' : '#dates');
  }

  return h('div', { class: 'view form-view' },
    h('header', { class: 'page-header' }, h('h1', { text: existing ? '編輯停靠點' : '新增停靠點' })),
    h('form', { class: 'stop-form', novalidate: true, on: { submit: (e) => { e.preventDefault(); save(); } } },
      errorBox,
      h('fieldset', null, h('legend', { text: '基本資料' }),
        field('名稱（必填）', inp.title),
        field('當地語言原名', inp.localName, '導航時優先以原名搜尋，較準確'),
        field('城市', inp.city),
        h('datalist', { id: 'city-list' }, ['Vienna', 'Budapest', 'Bratislava'].map((c) => h('option', { value: c }))),
        field('類型', inp.type),
        field('日期', inp.date),
        h('div', { class: 'two-col' }, field('開始時間', inp.startTime), field('結束時間', inp.endTime)),
        field('預設交通方式', inp.mode)),
      h('fieldset', null, h('legend', { text: '導航目的地' }),
        h('p', { class: 'hint', text: '優先順序：入口座標 → 地點座標 → 地址 → 名稱＋城市。不確定的資料請留空，不要猜。' }),
        field('地址', inp.address),
        field('地點座標', inp.coordinates, '可在 Apple Maps 或 Google 地圖長按地點後複製座標'),
        field('入口座標', inp.entrance, '火車站、大型景點、飯店建議填入口，避免導到建築中心'),
        h('label', { class: 'check' }, inp.confirmed, h('span', { text: '我已實際確認這個目的地正確' })),
        preview),
      h('fieldset', null, h('legend', { text: '其他' }),
        field('參考網址', inp.url),
        field('備註', inp.notes)),
      existing ? photoFormSection(existing) : null,
      h('div', { class: 'form-actions' },
        h('button', { type: 'submit', class: 'btn primary' }, '儲存'),
        btn('取消', () => (history.length > 1 ? history.back() : go('#today')), 'btn ghost'),
        existing ? btn('刪除此停靠點', () => deleteStop(existing.id), 'btn danger') : null)));
}

// ---------- 設定／備份 ----------
function backLink(label = '‹ 我的旅程', href = '#trips') {
  return h('a', { class: 'trip-switch', href },
    h('span', { class: 'trip-switch-home', text: label }));
}

// 旅程設定（只針對目前旅程；保留底部分頁）
function viewSettings(trip) {
  if (!trip) return viewAppSettings();
  return h('div', { class: 'view settings-view' },
    h('header', { class: 'page-header' }, tripSwitch(trip.title), h('h1', { text: '旅程設定' })),
    h('section', { class: 'card' },
      h('h2', { text: '旅程資訊' }),
      h('p', { class: 'big-line', text: trip.title }),
      h('p', { class: 'sub', text: `${trip.startDate} – ${trip.endDate}・時區 ${trip.timeZone}・預設${C.MODE_LABELS[trip.settings.defaultMode]}` }),
      h('a', { class: 'btn ghost', href: '#tripform/edit' }, '編輯名稱、日期與時區')),
    h('section', { class: 'card' },
      h('h2', { text: '照片' }),
      h('p', { class: 'hint', text: '為停靠點加上自己的照片（例如飯店門口、車站入口截圖），可一次選取多張自動配對。' }),
      h('a', { class: 'btn', href: '#photos' }, '照片整理')),
    h('section', { class: 'card' },
      h('h2', { text: '分享這趟行程' }),
      h('p', { class: 'hint', text: '產生不含完成紀錄與備註的檔案，朋友匯入後即可使用。若含住宿等私人地點，請先確認是否適合分享。' }),
      btn('匯出分享範本', () => exportTemplate(trip), 'btn')),
    h('section', { class: 'card' },
      h('h2', { text: '備份、地圖與 App 設定' }),
      h('p', { class: 'hint', text: state.lastExportAt ? `上次完整備份：${formatLocalTime(state.lastExportAt, trip.timeZone)}` : '尚未匯出過完整備份。' }),
      h('div', { class: 'btn-row' },
        btn('立即完整備份', () => exportBackup(), 'btn primary'),
        h('a', { class: 'btn ghost', href: '#app' }, '前往 App 設定／備份'))),
    h('section', { class: 'card danger-zone' },
      h('h2', { text: '刪除旅程' }),
      h('p', { class: 'hint', text: '會刪除此旅程的所有停靠點與紀錄。建議先匯出備份。' }),
      btn(`刪除「${trip.title}」`, () => removeTrip(trip), 'btn danger')));
}

// App 設定／備份（跨所有旅程；不顯示底部分頁）
function viewAppSettings() {
  const fileInput = h('input', {
    type: 'file', accept: '.json,.csv,.xlsx,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'visually-hidden', id: 'import-file',
    on: { change: (e) => handleImportFile(e.target.files && e.target.files[0], e.target) },
  });
  const mp = state.mapPrefs;
  const sections = [];

  sections.push(h('section', { class: 'card' },
    h('h2', { text: '備份與還原（所有旅程）' }),
    h('p', { class: 'sub', text: state.lastExportAt ? `上次成功匯出：${formatLocalTime(state.lastExportAt)}` : '尚未匯出過備份' }),
    h('p', { class: 'hint', text: '資料只保存在這支手機的這個 App 中，可能因清除網站資料或系統清理而消失。備份是必要的保險：建議出發前一次、每天結束後一次。備份檔含私人行程，請妥善保存。' }),
    h('div', { class: 'btn-row' },
      btn('匯出完整備份（含照片）', () => exportBackup(), 'btn primary', { disabled: !state.trips.length }),
      btn('匯出備份（不含照片，檔案較小）', () => exportBackup({ withPhotos: false }), 'btn ghost', { disabled: !state.trips.length }),
      h('label', { class: 'btn ghost', for: 'import-file', role: 'button', tabindex: '0' }, '匯入檔案（Excel／CSV／JSON）…'),
      h('a', { class: 'btn ghost', href: '#paste' }, '貼上行程內容'),
      fileInput)));

  sections.push(h('section', { class: 'card' },
    h('h2', { text: '地圖（本機設定，所有旅程共用）' }),
    field('預設地圖 App', h('select', { on: { change: (e) => setMapPrefs({ provider: e.target.value }) } },
      h('option', { value: 'apple', selected: mp.provider !== 'google' }, 'Apple Maps（建議 iPhone 使用）'),
      h('option', { value: 'google', selected: mp.provider === 'google' }, 'Google 地圖（Android 或需要時）'))),
    mp.provider !== 'google' ? field('Apple Maps 連結格式', h('select', { on: { change: (e) => setMapPrefs({ appleStyle: e.target.value }) } },
      h('option', { value: 'unified', selected: mp.appleStyle === 'unified' }, '官方統一網址（iOS 18.4 以上，預設）'),
      h('option', { value: 'legacy', selected: mp.appleStyle === 'legacy' }, '舊式網址（相容性備援，無自行車）'),
      h('option', { value: 'scheme', selected: mp.appleStyle === 'scheme' }, 'maps:// 直接開啟 App（若連結停留在網頁內時使用）')),
    '請先用「導航測試」確認哪一種在您的 iPhone 上能直接跳到 Apple Maps。') : null,
    h('a', { class: 'btn', href: '#maptest' }, '導航測試（實機驗證用）')));

  sections.push(appearanceCard());
  sections.push(photoSettingsCard());

  sections.push(h('section', { class: 'card' },
    h('h2', { text: '建立行程檔（自己用或分享給朋友）' }),
    h('p', { class: 'hint', text: '除了在 App 內逐筆新增，也可以用 Excel／CSV 範本填寫，或請 AI 依提示詞把行程轉成 JSON，再匯入。' }),
    h('div', { class: 'btn-row' },
      h('a', { class: 'btn', href: '#guide' }, '查看說明與 AI 提示詞'),
      h('a', { class: 'btn ghost', href: './data/trip-template.xlsx', download: 'trip-template.xlsx' }, '下載 Excel 範本'),
      h('a', { class: 'btn ghost', href: './data/trip-template.csv', download: 'trip-template.csv' }, '下載 CSV 範本'),
      h('a', { class: 'btn ghost', href: './data/trip-template.json', download: 'trip-template.json' }, '下載 JSON 範本'))));

  sections.push(h('section', { class: 'card' },
    h('h2', { text: '離線與儲存狀態' }),
    h('ul', { class: 'plain-list' },
      h('li', { text: `網路：${navigator.onLine ? '連線中' : '離線'}` }),
      h('li', { text: `離線網站資料：${state.swState === 'ready' ? '已就緒（可離線開啟）' : state.swState === 'unsupported' ? '此瀏覽器不支援' : '尚未就緒——請連網開啟一次並稍候'}` }),
      h('li', { text: `持久儲存：${state.persisted === true ? '已取得' : state.persisted === false ? '未取得（仍可使用，請定期備份）' : '檢查中'}` }),
      h('li', { text: `開啟方式：${isStandalone() ? '主畫面 App' : 'Safari 分頁（建議改從主畫面開啟）'}` })),
    h('p', { class: 'hint', text: '有網路不代表離線資料已準備好；請在出發前以飛航模式從主畫面重新開啟一次確認。Apple Maps 的離線地圖需在 Apple Maps 內自行下載。' }),
    state.onboardingDismissed ? btn('重新顯示使用前提醒', async () => {
      state.onboardingDismissed = false;
      await DB.setMeta('onboardingDismissed', false).catch(() => {});
      toast('進入旅程時會再顯示使用前提醒', { duration: 3000 });
    }, 'btn ghost small') : null));

  sections.push(versionLine());
  return h('div', { class: 'view settings-view' },
    h('header', { class: 'page-header' }, backLink(), h('h1', { text: 'App 設定／備份' })), sections);
}

function refreshFormPhoto() {
  const fs = document.getElementById('photo-fs');
  if (!fs) return;
  const trip = activeTrip();
  const st = trip && trip.stops.find((x) => x.id === fs.dataset.stopId);
  if (st) fs.replaceWith(photoFormSection(st));
}

function photoFormSection(stop) {
  const cur = activeTrip().stops.find((x) => x.id === stop.id) || stop;
  const info = userPhotoInfo(cur);
  const none = !!(info && info.none);
  const own = !!(info && info.rec && !info.inherited);
  const inherited = !!(info && info.rec && info.inherited);
  const mine = info && info.rec;
  const ph = cur.photo;
  const wikiOn = state.photoPrefs.enabled;
  const status = !ph ? '尚未配對維基百科照片。' : ph.hidden ? `維基百科照片已隱藏（${ph.title}）。` : `維基百科：${ph.title}${ph.confidence === 'low' ? '（自動配對，可能不準確）' : ''}`;
  async function research() {
    if (!navigator.onLine) { toast('需要網路才能搜尋', { duration: 3000 }); return; }
    const rejected = ph ? [...(ph.rejected || []), ph.title] : [];
    try {
      const photo = await PH.lookupPhoto(activeTrip().stops.find((x) => x.id === stop.id), { rejected });
      if (photo) photo.rejected = rejected;
      await updateStop(stop.id, (x) => ({ ...x, photo: photo || (ph ? { ...ph, hidden: true, rejected } : null) }));
      if (photo) {
        await PH.downloadToCache(photo.thumbUrl).catch(() => {});
        toast(`找到：${photo.title}`, { duration: 3000 });
      } else toast('沒有找到其他照片', { duration: 3000 });
    } catch (e) {
      toast(`搜尋失敗：${e.message || e}`, { kind: 'error' });
    }
  }
  return h('fieldset', { id: 'photo-fs', dataset: { stopId: stop.id } }, h('legend', { text: '照片' }),
    h('p', { class: 'hint', text: none ? '已設定這一站不顯示照片。'
      : own ? '目前顯示「我的照片」（優先於維基百科照片）。同一地點的其他停靠點會自動沿用這張。'
        : inherited ? `沿用同一地點 ${samePlaceLabel(info.from)} 的照片。要改用不同照片，直接上傳即可。`
          : '可上傳自己的照片（例如飯店門口或入口的截圖），會自動縮小後保存在手機中；同一地點的其他停靠點會自動沿用。' }),
    mine ? userPhotoBlock(cur, 'wide') : null,
    h('div', { class: 'btn-row' },
      btn(own ? '更換我的照片' : inherited ? '上傳不同的照片' : '上傳自己的照片', () => pickImages({}, (files) => saveUserPhoto(stop.id, files[0])), 'btn small'),
      own ? btn('移除我的照片', () => removeUserPhoto(stop.id), 'btn ghost small') : null,
      inherited || (!none && !own) ? btn('這一站不顯示照片', () => setNoPhoto(stop.id, true), 'btn ghost small') : null,
      none ? btn('恢復顯示照片', () => setNoPhoto(stop.id, false), 'btn ghost small') : null),
    wikiOn && !none ? [
      h('p', { class: 'hint', text: status }),
      !mine && ph && !ph.hidden ? photoBlock(cur, { variant: 'wide' }) : null,
      h('div', { class: 'btn-row' },
        btn(ph ? '重新搜尋（排除目前這張）' : '搜尋維基百科照片', research, 'btn ghost small'),
        ph && ph.hidden ? btn('恢復顯示', () => updateStop(stop.id, (x) => ({ ...x, photo: { ...x.photo, hidden: false } })), 'btn ghost small') : null,
        ph ? btn('移除維基百科照片', () => updateStop(stop.id, (x) => ({ ...x, photo: null })), 'btn ghost small') : null),
    ] : null);
}

async function setPhotoPrefs(patch) {
  const next = { ...state.photoPrefs, ...patch };
  if (!next.enabled) next.allowLive = false;
  try {
    await DB.setMeta('photoPrefs', next);
  } catch (e) {
    toast(`儲存失敗：${e.message || e}`, { kind: 'error' });
    return;
  }
  state.photoPrefs = next;
  render();
}

/** 預先下載所有旅程的縮圖（建議在臺灣用 Wi‑Fi 執行）。 */
async function prefetchPhotos({ redo = false } = {}) {
  if (state.photoJob && state.photoJob.running) return;
  if (redo && !window.confirm('重新配對會清除所有維基百科照片並重新搜尋（您標記「不是這張」的仍會排除；自己的照片不受影響）。確定繼續？')) return;
  if (!navigator.onLine) { toast('目前沒有網路，請連上 Wi‑Fi 後再試', { duration: 4000 }); return; }
  const targets = [];
  for (const t of state.trips) for (const st of t.stops) {
    // 已有自己照片的停靠點不需要維基百科照片
    if (PH.wantsPhoto(st) && !userPhotoInfo(st, t) && !(st.photo && st.photo.hidden)) targets.push({ tripId: t.tripId, stopId: st.id, title: st.title });
  }
  const job = { running: true, cancel: false, done: 0, total: targets.length, found: 0, failed: 0, notFound: 0, log: [] };
  state.photoJob = job;
  render();
  const resolved = []; // 已處理的 { st, photo }：同一地點直接沿用，不重複查詢
  for (const { tripId, stopId, title } of targets) {
    if (job.cancel) break;
    const trip = state.trips.find((t) => t.tripId === tripId);
    const st = trip && trip.stops.find((x) => x.id === stopId);
    let stage = '搜尋';
    let twinUsed = false;
    try {
      let photo = st && st.photo;
      const rejected = (photo && photo.rejected) || [];
      if (redo && photo && !photo.hidden) photo = null;
      const needLookup = st && !photo;
      const twin = needLookup ? resolved.find((d) => d.tripId === tripId && IM.samePlace(d.st, st)) : null;
      twinUsed = !!twin || !needLookup;
      if (needLookup) {
        if (twin) {
          // 同一地點：沿用已查到的結果（但排除這一站曾標記「不是這張」的條目）
          photo = twin.photo && !rejected.includes(twin.photo.title) ? { ...twin.photo, rejected } : null;
        } else {
          photo = await PH.lookupPhoto(st, { rejected });
          if (photo) photo.rejected = rejected;
        }
        if (photo || redo) {
          const t2 = state.trips.find((t) => t.tripId === tripId);
          await commitTrip({ ...t2, stops: t2.stops.map((x) => (x.id === stopId ? { ...x, photo: photo || null } : x)) }, { rerender: false });
        }
      }
      if (st) resolved.push({ tripId, st, photo: photo || null });
      if (!photo) {
        job.notFound += 1;
        job.log.push({ title, result: 'notfound', detail: '維基百科找不到對應條目' });
      } else {
        stage = '下載';
        if (!(await PH.cachedBlob(photo.thumbUrl))) await PH.downloadToCache(photo.thumbUrl);
        job.found += 1;
        job.log.push({ title, result: 'ok', detail: photo.title + (photo.confidence === 'low' ? '（可能不準確）' : '') });
      }
    } catch (e) {
      job.failed += 1;
      job.log.push({ title, result: 'failed', detail: `${stage}失敗：${(e && e.message) || e}` });
    }
    job.done += 1;
    updatePhotoProgress();
    await new Promise((r) => setTimeout(r, twinUsed ? 0 : 900)); // 放慢請求，避免被維基百科限流（HTTP 429）
  }
  job.running = false;
  render();
  toast(job.cancel ? `已停止：完成 ${job.done}/${job.total}` : `完成：找到 ${job.found} 張、找不到 ${job.notFound} 筆${job.failed ? `、失敗 ${job.failed} 筆` : ''}。明細在設定頁。`, { duration: 6000 });
}

function photoJobReport(job) {
  if (!job || job.running || !job.log.length) return null;
  const group = (k) => job.log.filter((x) => x.result === k);
  const section = (label, list) => (list.length ? h('details', { class: 'job-log' },
    h('summary', null, `${label}（${list.length}）`),
    h('ul', { class: 'plain-list' }, list.map((x) => h('li', { text: `${x.title}：${x.detail}` })))) : null);
  return h('div', { class: 'job-report' },
    h('p', { class: 'sub', text: `上次下載：找到 ${job.found}、找不到 ${job.notFound}、失敗 ${job.failed}（共 ${job.done}/${job.total}）` }),
    section('下載失敗', group('failed')),
    section('找不到條目（飯店、餐廳等常見，可改用自己的照片）', group('notfound')),
    section('成功', group('ok')));
}

function updatePhotoProgress() {
  const el = document.getElementById('photo-progress');
  const j = state.photoJob;
  if (el && j) el.textContent = `處理中 ${j.done}/${j.total}・找到 ${j.found}・找不到 ${j.notFound}${j.failed ? `・失敗 ${j.failed}` : ''}`;
}

function appearanceCard() {
  const cp = state.clockPrefs;
  const tzList = C.HOME_TIME_ZONES.includes(cp.homeTz) || !cp.homeTz ? C.HOME_TIME_ZONES : [cp.homeTz, ...C.HOME_TIME_ZONES];
  const custom = h('input', { type: 'text', placeholder: 'IANA 時區，例：Europe/Lisbon', hidden: true });
  const sel = h('select', {
    on: {
      change: (e) => {
        if (e.target.value === '__custom') { custom.hidden = false; custom.focus(); return; }
        setClockPrefs({ homeTz: e.target.value });
      },
    },
  }, tzList.map((z) => h('option', { value: z, selected: z === cp.homeTz }, `${C.tzLabel(z)}（${z}）`)), h('option', { value: '__custom' }, '其他（自行輸入）…'));
  custom.addEventListener('change', () => {
    const v = custom.value.trim();
    if (C.isValidTimeZone(v)) setClockPrefs({ homeTz: v }); else toast('時區名稱不正確', { kind: 'error' });
  });
  return h('section', { class: 'card' },
    h('h2', { text: '外觀、時間與天氣' }),
    field('日夜模式', h('select', { on: { change: (e) => setThemeMode(e.target.value) } },
      ['auto', 'light', 'dark'].map((m) => h('option', { value: m, selected: state.themeMode === m }, m === 'auto' ? '跟隨系統（預設）' : THEME_LABELS[m])))),
    h('p', { class: 'hint', text: '「今天」頁頂端的 ☾／☀︎ 按鈕可快速切換；選「跟隨系統」會依 iPhone 的外觀設定自動變化。' }),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: cp.show, on: { change: (e) => setClockPrefs({ show: e.target.checked }) } }),
      h('span', { text: '在「今天」頁顯示兩地時間' })),
    field('家鄉時區', sel, '到國外後 iPhone 會自動改成當地時間，所以家鄉時區另外記在這裡；與旅行地時差為 0 時不顯示。'),
    custom,
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.weatherPrefs.show, on: { change: (e) => setWeatherPrefs({ show: e.target.checked }) } }),
      h('span', { text: '在「今天」頁顯示天氣預報' })),
    h('p', { class: 'hint' }, '資料來源：', h('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer' }, 'Open-Meteo'),
      '（CC BY 4.0）。只傳送城市的大略座標（約 1 公里），不含您的位置或行程；每次約數 KB，3 小時內不重抓，離線時顯示上次的資料。預報約涵蓋 16 天。'));
}

async function setWeatherPrefs(patch) {
  const next = { ...state.weatherPrefs, ...patch };
  try { await DB.setMeta('weatherPrefs', next); } catch (e) { toast(`儲存失敗：${e.message || e}`, { kind: 'error' }); return; }
  state.weatherPrefs = next;
  render();
}

async function setClockPrefs(patch) {
  const next = { ...state.clockPrefs, ...patch };
  try { await DB.setMeta('clockPrefs', next); } catch (e) { toast(`儲存失敗：${e.message || e}`, { kind: 'error' }); return; }
  state.clockPrefs = next;
  render();
}

function photoSettingsCard() {
  const pp = state.photoPrefs;
  const j = state.photoJob;
  const statsEl = h('p', { class: 'sub', id: 'photo-stats', text: '' });
  if (pp.enabled) {
    PH.cacheStats().then((st) => {
      statsEl.textContent = `本機已保存 ${st.count} 張（約 ${(st.bytes / 1024 / 1024).toFixed(1)} MB）`;
    }).catch(() => {});
  }
  return h('section', { class: 'card' },
    h('h2', { text: '景點參考照片（選用）' }),
    h('p', { class: 'hint', text: '從維基百科／Wikimedia Commons 取得景點照片，讓您先看看大概長什麼樣子；每張都附作者與授權。照片可能配錯，可隨時按「不是這張」。開啟後，維基百科會收到查詢的地點名稱。' }),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: pp.enabled, on: { change: (e) => setPhotoPrefs({ enabled: e.target.checked }) } }),
      h('span', { text: '顯示參考照片' })),
    pp.enabled ? [
      h('div', { class: 'btn-row' },
        j && j.running
          ? btn('停止下載', () => { j.cancel = true; }, 'btn danger')
          : [btn('預先下載所有旅程的照片', () => prefetchPhotos(), 'btn primary'),
            btn('重新配對全部', () => prefetchPhotos({ redo: true }), 'btn ghost')]),
      h('p', { class: 'sub', id: 'photo-progress', text: j && j.running ? `處理中 ${j.done}/${j.total}…` : '' }),
      photoJobReport(j),
      h('p', { class: 'hint', text: '建議出發前在 Wi‑Fi 下執行一次：照片會保存在手機中，之後離線或在國外都能看，不會用到國外流量。' }),
      statsEl,
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: pp.allowLive, on: { change: (e) => setPhotoPrefs({ allowLive: e.target.checked }) } }),
        h('span', { text: '允許隨時自動下載新照片（會使用行動數據）' })),
      h('p', { class: 'hint', text: 'iPhone 網頁 App 無法分辨 Wi‑Fi 與行動網路；關閉此項時，只會顯示已預先下載的照片。' }),
      btn('清除已下載的照片', async () => {
        if (!window.confirm('確定清除手機中已下載的照片？（行程資料不受影響）')) return;
        await PH.clearCache();
        photoUrls.forEach((u) => URL.revokeObjectURL(u));
        photoUrls.clear();
        render();
      }, 'btn ghost small'),
    ] : null);
}

async function setMapPrefs(patch) {
  const next = { ...state.mapPrefs, ...patch };
  try {
    await DB.setMeta('mapPrefs', next);
  } catch (e) {
    toast(`儲存失敗：${e.message || e}`, { kind: 'error' });
    return;
  }
  state.mapPrefs = next;
  render();
}

// ---------- 照片整理（批次） ----------
function photoTargets(trip, { onlyMissing = false } = {}) {
  const dates = C.listDates(trip.startDate, trip.endDate);
  const out = [];
  for (const d of [...dates, null]) {
    C.stopsForDate(trip, d).forEach((s, i) => {
      if (s.type === 'transfer') return;
      if (onlyMissing && userPhotoInfo(s, trip)) return; // 已有、沿用同一地點，或設定不顯示
      out.push({ ...s, position: i + 1 });
    });
  }
  return out;
}

function photoThumb(stop) {
  const mine = userPhotoOf(stop);
  if (mine) return h('img', { class: 'pm-thumb', src: IM.dataUrl(mine), alt: '' });
  if (state.photoPrefs.enabled && stop.photo && !stop.photo.hidden && PH.isWikimediaUrl(stop.photo.thumbUrl)) {
    const img = h('img', { class: 'pm-thumb wiki', alt: '' });
    const holder = h('span', { class: 'pm-thumb-wrap' }, img);
    fillPhoto(img, { remove: () => holder.replaceWith(h('span', { class: 'pm-thumb empty', text: '無' })) }, stop.photo.thumbUrl);
    return holder;
  }
  return h('span', { class: 'pm-thumb empty', text: '無' });
}

function viewPhotos(trip) {
  const onlyMissing = state.photoFilterMissing === true;
  const list = photoTargets(trip, { onlyMissing });
  const allT = photoTargets(trip);
  const ownIds = new Set(allT.map((s) => s.userPhoto && s.userPhoto.id).filter((id) => id && state.images.has(id)));
  const mineCount = ownIds.size;
  const covered = allT.filter((s) => userPhotoInfo(s, trip)).length;
  const bytes = [...ownIds].reduce((a, id) => a + IM.imageBytes(state.images.get(id)), 0);
  let lastDate;
  const rows = [];
  for (const s of list) {
    if (s.date !== lastDate) {
      rows.push(h('li', { class: 'pm-date', text: s.date ? C.formatDateShort(s.date) : '候選景點' }));
      lastDate = s.date;
    }
    const info = userPhotoInfo(s, trip);
    const own = info && info.rec && !info.inherited;
    const kind = info && info.none ? '不顯示照片' : own ? '我的照片' : info && info.inherited ? `沿用同一地點（${info.from.date ? C.formatDateShort(info.from.date) : '候選'}）` : (s.photo && !s.photo.hidden && state.photoPrefs.enabled ? '維基百科' : '');
    rows.push(h('li', { class: 'pm-row' },
      info && info.none ? h('span', { class: 'pm-thumb empty', text: '—' }) : photoThumb(s),
      h('span', { class: 'pm-info' },
        h('span', { class: 'stop-title', text: s.title }),
        h('span', { class: 'head-meta', text: [s.date ? `第 ${s.position} 站` : '', s.city, kind].filter(Boolean).join('・') })),
      h('span', { class: 'pm-actions' },
        btn(own ? '更換' : info && info.inherited ? '改用別張' : '選照片', () => pickImages({}, (files) => saveUserPhoto(s.id, files[0])), 'btn small'),
        own ? btn('移除', () => removeUserPhoto(s.id), 'btn ghost small') : null,
        info && info.none ? btn('恢復', () => setNoPhoto(s.id, false), 'btn ghost small') : null)));
  }
  return h('div', { class: 'view photos-view' },
    h('header', { class: 'page-header' }, tripSwitch(trip.title), h('h1', { text: '照片整理' })),
    h('p', { class: 'sub', text: `自己的照片 ${mineCount} 張（約 ${Math.max(1, Math.round(bytes / 1024))} KB），涵蓋 ${covered} 個停靠點。同一地點（例如連住多晚的飯店）只需上傳一次。照片會自動縮小（長邊 640px），原始照片仍留在您的相簿。` }),
    h('section', { class: 'card' },
      h('h2', { text: '一次加入多張' }),
      h('p', { class: 'hint', text: '一次選取多張照片：檔名含地點名稱（例：Karlskirche.jpg、卡爾教堂.png）或「日期＿第幾站」（例：11-12_2.jpg、D1-2.jpg）會自動配對；其餘依選取順序配給下方「尚無照片」的停靠點。確認前都可以修改，不會直接寫入。' }),
      btn('選取多張照片…', () => pickImages({ multiple: true }, (files) => startBatchAssign(trip, files)), 'btn primary')),
    h('div', { class: 'seg-row', role: 'group', 'aria-label': '篩選' },
      h('button', { type: 'button', class: `seg${!onlyMissing ? ' on' : ''}`, 'aria-pressed': String(!onlyMissing), on: { click: () => { state.photoFilterMissing = false; render(); } } }, `全部（${allT.length}）`),
      h('button', { type: 'button', class: `seg${onlyMissing ? ' on' : ''}`, 'aria-pressed': String(onlyMissing), on: { click: () => { state.photoFilterMissing = true; render(); } } }, `尚無照片（${allT.length - covered}）`)),
    list.length ? h('ul', { class: 'pm-list' }, rows) : h('p', { class: 'empty-line', text: onlyMissing ? '每個停靠點都已有自己的照片。' : '沒有停靠點。' }),
    h('p', { class: 'hint', text: '交通移動類的停靠點不列入。維基百科照片可在「App 設定／備份」開啟並批次下載。' }));
}

function startBatchAssign(trip, files) {
  const targets = photoTargets(trip, { onlyMissing: true });
  const guess = IM.guessAssignments(files.map((f) => ({ name: f.name })), targets, { dates: C.listDates(trip.startDate, trip.endDate) });
  if (state.pendingPhotos) state.pendingPhotos.items.forEach((it) => URL.revokeObjectURL(it.preview));
  state.pendingPhotos = {
    tripId: trip.tripId,
    items: files.map((f, i) => ({ file: f, name: f.name, preview: URL.createObjectURL(f), stopId: guess[i].stopId, source: guess[i].source })),
  };
  go('#photoassign');
}

function viewPhotoAssign(trip) {
  const pp = state.pendingPhotos;
  if (!pp || pp.tripId !== trip.tripId) {
    return h('div', { class: 'view' }, h('p', { text: '沒有待指派的照片。' }), h('a', { class: 'btn', href: '#photos' }, '回到照片整理'));
  }
  const all = photoTargets(trip);
  const counts = new Map();
  pp.items.forEach((it) => { if (it.stopId) counts.set(it.stopId, (counts.get(it.stopId) || 0) + 1); });
  const assigned = pp.items.filter((it) => it.stopId).length;
  const dup = [...counts.values()].some((n) => n > 1);
  const label = (s) => {
    const i = userPhotoInfo(s, trip);
    const note = i && i.rec && !i.inherited ? '（已有照片，將取代）' : i && i.inherited ? '（目前沿用同一地點）' : '';
    return `${s.date ? C.formatDateShort(s.date) : '候選'} ${s.date ? `#${s.position} ` : ''}${s.title}${note}`;
  };
  const cancel = () => { pp.items.forEach((it) => URL.revokeObjectURL(it.preview)); state.pendingPhotos = null; go('#photos'); };
  const progress = h('p', { class: 'sub', id: 'assign-progress' });

  async function confirmAssign() {
    if (dup) { toast('有兩張以上的照片指派到同一個停靠點，請先調整。', { kind: 'error' }); return; }
    const todo = pp.items.filter((it) => it.stopId);
    if (!todo.length) { toast('尚未指派任何照片', { duration: 3000 }); return; }
    const recs = [];
    const updates = new Map();
    let failed = 0;
    for (let i = 0; i < todo.length; i += 1) {
      progress.textContent = `處理中 ${i + 1}/${todo.length}…`;
      try {
        const r = await IM.resizeToJpeg(todo[i].file);
        const rec = { id: C.uuid(), ...r, createdAt: C.nowIso() };
        recs.push(rec);
        updates.set(todo[i].stopId, { id: rec.id, addedAt: rec.createdAt });
      } catch { failed += 1; }
    }
    try {
      await DB.putImages(recs);
    } catch (e) {
      toast(`儲存照片失敗：${e.message || e}`, { kind: 'error' });
      return;
    }
    recs.forEach((r) => state.images.set(r.id, r));
    const t = activeTrip();
    const before = t.stops;
    const ok = await commitTrip({ ...t, stops: t.stops.map((x) => (updates.has(x.id) ? { ...x, userPhoto: updates.get(x.id) } : x)) }, { rerender: false });
    if (!ok) return;
    const kb = Math.round(recs.reduce((a, r) => a + r.bytes, 0) / 1024);
    pp.items.forEach((it) => URL.revokeObjectURL(it.preview));
    state.pendingPhotos = null;
    go('#photos');
    toast(`已加入 ${recs.length} 張照片（約 ${kb} KB）${failed ? `，${failed} 張無法讀取` : ''}`, {
      duration: 8000, actionLabel: '復原', action: () => commitTrip({ ...activeTrip(), stops: before }),
    });
  }

  return h('div', { class: 'view assign-view' },
    h('header', { class: 'page-header' }, h('h1', { text: '指派照片' })),
    h('p', { text: `共 ${pp.items.length} 張，已指派 ${assigned} 張。請確認每張照片對應的停靠點。` }),
    dup ? h('div', { class: 'form-errors' }, h('p', { text: '有兩張以上的照片指派到同一個停靠點（標示為紅框），請調整。' })) : null,
    h('ul', { class: 'assign-list' }, pp.items.map((it, i) => {
      const sel = h('select', {
        'aria-label': `${it.name} 對應的停靠點`,
        on: { change: (e) => { it.stopId = e.target.value || null; it.source = it.stopId ? 'manual' : null; render(); } },
      },
      h('option', { value: '', selected: !it.stopId }, '（不使用這張）'),
      all.map((s) => h('option', { value: s.id, selected: s.id === it.stopId }, label(s))));
      const src = { filename: '依檔名配對', order: '依選取順序', manual: '手動指派' }[it.source] || '未指派';
      return h('li', { class: `assign-item${it.stopId && counts.get(it.stopId) > 1 ? ' dup' : ''}` },
        h('img', { src: it.preview, alt: `第 ${i + 1} 張` }),
        h('div', { class: 'assign-meta' },
          h('span', { class: 'head-meta', text: `${i + 1}. ${it.name}` }),
          h('span', { class: `chip${it.source === 'filename' ? ' today' : ''}`, text: src }),
          sel));
    })),
    progress,
    h('div', { class: 'form-actions' },
      btn(`確認加入 ${assigned} 張`, confirmAssign, 'btn primary', { disabled: !assigned }),
      btn('取消', cancel, 'btn ghost')));
}

// ---------- 匯出 ----------
function downloadOrShare(obj, filename, onDone) {
  const json = JSON.stringify(obj, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  let file = null;
  try {
    file = new File([blob], filename, { type: 'application/json' });
  } catch { /* 舊環境 */ }
  // 必須在使用者點擊的同步流程中呼叫 share
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: filename })
      .then(() => onDone(true))
      .catch((e) => {
        if (e && e.name === 'AbortError') toast('已取消匯出', { duration: 2500 });
        else fallbackDownload(blob, filename, onDone);
      });
    return;
  }
  fallbackDownload(blob, filename, onDone);
}

function fallbackDownload(blob, filename, onDone) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, class: 'visually-hidden' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  onDone(true);
}

function exportBackup({ withPhotos = true } = {}) {
  const trip = activeTrip();
  // 照片已在記憶體中，可同步組出備份（iOS 分享面板必須在點擊當下呼叫）
  const backup = C.buildBackup(state.trips, undefined, withPhotos ? [...state.images.values()] : null);
  const slug = state.trips.length === 1 ? C.slugForFile(state.trips[0].title) : 'trip';
  const name = C.backupFileName(slug === 'trip' ? 'travel-companion-backup' : `${slug}-backup`, new Date(), trip ? trip.timeZone : undefined);
  downloadOrShare(backup, name, async (ok) => {
    if (!ok) return;
    state.lastExportAt = backup.exportedAt;
    await DB.setMeta('lastExportAt', backup.exportedAt).catch(() => {});
    const n = backup.images ? backup.images.length : 0;
    toast(`已匯出備份：${name}${withPhotos ? `（含 ${n} 張照片）` : '（不含照片）'}。請存到「檔案」或可靠位置。`, { duration: 5000 });
    render();
  });
}

function exportTemplate(trip) {
  const tpl = C.buildTemplate(trip);
  const name = C.backupFileName(`${C.slugForFile(trip.title)}-template`, new Date(), trip.timeZone);
  downloadOrShare(tpl, name, () => toast('已匯出分享範本（已移除完成紀錄與備註）', { duration: 4000 }));
}

// ---------- 匯入 ----------
async function handleImportFile(file, inputEl) {
  if (!file) return;
  try {
    if (file.size > C.MAX_IMPORT_BYTES) {
      toast('檔案過大，無法匯入。', { kind: 'error' });
      return;
    }
    // 依內容判斷格式（iOS「檔案」有時不保留副檔名）：ZIP 檔頭＝Excel；以 { 開頭＝JSON；其餘＝CSV／表格
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (X.isXlsxBytes(bytes)) {
      try {
        const { table, sheetName } = await X.readXlsx(bytes);
        state.pendingImport = { ...V.tableToDrafts(table, { source: 'xlsx' }), kind: 'csv', encoding: `Excel（分頁：${sheetName}）`, fileName: file.name };
      } catch (e) {
        state.pendingImport = { ok: false, kind: 'csv', rows: [], warnings: [], errors: [`無法讀取 Excel 檔：${e.message || e}`], fileName: file.name };
      }
      go('#import');
      return;
    }
    const { text, encoding } = V.decodeCsvBytes(bytes);
    if (text.trim().startsWith('{')) {
      state.pendingImport = { ...C.parseImport(text, file.size), fileName: file.name };
    } else {
      state.pendingImport = { ...V.csvToDrafts(text), kind: 'csv', encoding, fileName: file.name };
    }
    go('#import');
  } catch (e) {
    toast(`讀取檔案失敗：${e.message || e}`, { kind: 'error' });
  } finally {
    if (inputEl) inputEl.value = '';
  }
}

function viewImport() {
  const pi = state.pendingImport;
  if (!pi) {
    return h('div', { class: 'view' }, h('p', { text: '沒有待匯入的檔案。' }), h('a', { class: 'btn', href: '#app' }, '回到 App 設定'));
  }
  const cancel = () => { state.pendingImport = null; go(activeTrip() ? '#app' : '#trips'); };
  if (pi.kind === 'csv') return viewImportCsv(pi, cancel);
  if (!pi.ok) {
    return h('div', { class: 'view import-view' },
      h('header', { class: 'page-header' }, h('h1', { text: '無法匯入' })),
      h('p', { text: `檔案「${pi.fileName}」沒有通過檢查，目前的資料完全沒有被更動。` }),
      h('div', { class: 'form-errors' }, pi.errors.slice(0, 15).map((e) => h('p', { text: e })),
        pi.errors.length > 15 ? h('p', { text: `……另有 ${pi.errors.length - 15} 項錯誤` }) : null),
      btn('返回', cancel, 'btn'));
  }

  const isBackup = pi.kind === 'backup';
  const existingIds = new Set(state.trips.map((t) => t.tripId));
  const single = !isBackup ? pi.trips[0] : null;
  const willReplaceSame = single && existingIds.has(single.tripId);

  async function confirmImport() {
    try {
      if (isBackup) {
        if (state.trips.length && !window.confirm('這會以備份檔「整份取代」目前手機中的所有旅程資料。確定繼續？')) return;
        await DB.replaceAllTrips(pi.trips, pi.images);
        state.trips = pi.trips;
        if (pi.images) state.images = new Map(pi.images.map((im) => [im.id, im]));
      } else {
        if (willReplaceSame && !window.confirm(`這會取代手機中同一個旅程「${single.title}」的資料。確定繼續？`)) return;
        await DB.putTrip(single);
        const idx = state.trips.findIndex((t) => t.tripId === single.tripId);
        if (idx >= 0) state.trips[idx] = single; else state.trips.push(single);
      }
    } catch (e) {
      toast(`匯入失敗：${e.message || e}。原有資料保持不變。`, { kind: 'error' });
      return;
    }
    const target = isBackup ? (pi.trips.find((t) => t.tripId === state.activeTripId) || pi.trips[0]) : single;
    state.pendingImport = null;
    await switchTrip(target ? target.tripId : null);
    toast('匯入完成', { duration: 3000 });
    go('#today');
  }

  return h('div', { class: 'view import-view' },
    h('header', { class: 'page-header' }, h('h1', { text: '確認匯入' })),
    h('p', { class: 'sub', text: `檔案：${pi.fileName}` }),
    h('p', { text: isBackup ? `這是完整備份檔${pi.images ? `，含 ${pi.images.length} 張自己的照片` : '（不含照片；手機中既有的照片會保留）'}。` : '這是單一旅程檔（或分享範本）。' }),
    pi.exportedAt ? h('p', { class: 'sub', text: `匯出時間：${formatLocalTime(pi.exportedAt)}` }) : null,
    pi.summary.map((s) => h('section', { class: 'card' },
      h('p', { class: 'big-line', text: s.title }),
      h('ul', { class: 'plain-list' },
        h('li', { text: `日期：${s.startDate} – ${s.endDate}（${s.timeZone}）` }),
        h('li', { text: `已排日期的停靠點：${s.total}（完成 ${s.completed}、略過 ${s.skipped}）` }),
        h('li', { text: `候選景點：${s.candidates}` }),
        existingIds.has(s.tripId) ? h('li', { class: 'warn-text', text: '手機中已有同一個旅程，將被取代。' }) : null))),
    isBackup && state.trips.length
      ? h('div', { class: 'warn-box' },
        h('p', { text: `注意：匯入備份會整份取代手機中目前的 ${state.trips.length} 個旅程。建議先匯出現有資料。` }),
        btn('先匯出目前資料', () => exportBackup(), 'btn ghost'))
      : null,
    h('div', { class: 'form-actions' },
      btn(isBackup ? '確認整份取代' : (willReplaceSame ? '確認取代此旅程' : '加入為新旅程'), confirmImport, 'btn primary'),
      btn('取消', cancel, 'btn ghost')));
}

// ---------- CSV 匯入預覽 ----------
function viewImportCsv(pi, cancel) {
  if (!pi.ok) {
    return h('div', { class: 'view import-view' },
      h('header', { class: 'page-header' }, h('h1', { text: '無法匯入表格' })),
      h('p', { text: `檔案「${pi.fileName}」有以下問題，目前的資料完全沒有被更動。請在試算表修正後重新存檔再匯入。` }),
      h('div', { class: 'form-errors' }, pi.errors.slice(0, 20).map((e) => h('p', { text: e })),
        pi.errors.length > 20 ? h('p', { text: `……另有 ${pi.errors.length - 20} 項錯誤` }) : null),
      h('div', { class: 'btn-row' }, btn('返回', cancel, 'btn'), h('a', { class: 'btn ghost', href: '#guide' }, '查看欄位說明')));
  }
  const trip = activeTrip();
  const dated = pi.rows.filter((r) => r.date);
  const errorBox = h('div', { class: 'form-errors', role: 'alert' });
  const showErrors = (errs) => {
    errorBox.replaceChildren(...errs.slice(0, 12).map((e) => h('p', { text: e })));
    if (errs.length) errorBox.scrollIntoView({ block: 'center' });
  };

  const defaultTz = trip ? trip.timeZone : 'Europe/Vienna';
  const inp = {
    title: h('input', { type: 'text', value: pi.fileName.replace(/\.[^.]+$/, '') }),
    start: h('input', { type: 'date', value: pi.dateRange ? pi.dateRange.min : '' }),
    end: h('input', { type: 'date', value: pi.dateRange ? pi.dateRange.max : '' }),
    tz: h('select', null, (C.COMMON_TIME_ZONES.includes(defaultTz) ? C.COMMON_TIME_ZONES : [defaultTz, ...C.COMMON_TIME_ZONES])
      .map((z) => h('option', { value: z, selected: z === defaultTz }, z))),
  };

  async function asNewTrip() {
    const errs = [];
    const title = inp.title.value.trim();
    if (!title) errs.push('請填寫旅程名稱。');
    if (!C.isValidDateString(inp.start.value) || !C.isValidDateString(inp.end.value)) errs.push('請填寫起訖日期。');
    else if (inp.start.value > inp.end.value) errs.push('起始日不可晚於結束日。');
    if (errs.length) return showErrors(errs);
    const t = C.createTrip({ title, timeZone: inp.tz.value, startDate: inp.start.value, endDate: inp.end.value });
    const res = V.appendDrafts(t, pi.rows);
    if (!res.ok) return showErrors(res.errors);
    const nt = { ...t, stops: res.stops };
    const v = C.validateTrip(nt);
    if (v.length) return showErrors(v);
    const ok = await commitTrip(nt, { rerender: false });
    if (!ok) return;
    state.pendingImport = null;
    await switchTrip(nt.tripId);
    toast(`已建立旅程並匯入 ${res.addedCount} 筆`, { duration: 3500 });
    go('#today');
  }

  async function intoCurrent() {
    const res = V.appendDrafts(trip, pi.rows);
    if (!res.ok) return showErrors(res.errors);
    const nt = { ...trip, stops: res.stops };
    const v = C.validateTrip(nt);
    if (v.length) return showErrors(v);
    const ok = await commitTrip(nt, { rerender: false });
    if (!ok) return;
    state.pendingImport = null;
    toast(`已加入 ${res.addedCount} 筆到「${trip.title}」`, { duration: 3500 });
    go('#edit');
  }

  return h('div', { class: 'view import-view' },
    h('header', { class: 'page-header' }, h('h1', { text: '確認匯入表格' })),
    h('p', { class: 'sub', text: `檔案：${pi.fileName}・格式：${pi.encoding}` }),
    h('p', { text: `共 ${pi.rows.length} 筆：已排日期 ${dated.length} 筆、候選景點 ${pi.rows.length - dated.length} 筆${pi.dateRange ? `；日期 ${pi.dateRange.min}～${pi.dateRange.max}` : ''}。` }),
    pi.warnings.length ? h('div', { class: 'warn-box' }, pi.warnings.map((w) => h('p', { text: w }))) : null,
    h('ol', { class: 'plain-list preview-list' }, pi.rows.slice(0, 30).map((r) => h('li', {
      text: `${r.date ? C.formatDateShort(r.date) : '候選'}・${r.title}${r.city ? `（${r.city}）` : ''}${r.address || r.coordinates ? '' : '・無地址'}`,
    }))),
    pi.rows.length > 30 ? h('p', { class: 'hint', text: `……另有 ${pi.rows.length - 30} 筆` }) : null,
    errorBox,
    h('section', { class: 'card' },
      h('h2', { text: '建立為新旅程' }),
      field('旅程名稱', inp.title),
      h('div', { class: 'two-col' }, field('起始日', inp.start), field('結束日', inp.end)),
      field('旅行地時區', inp.tz),
      btn('建立新旅程並匯入', asNewTrip, 'btn primary')),
    trip ? h('section', { class: 'card' },
      h('h2', { text: '或加入目前旅程' }),
      h('p', { class: 'hint', text: `「${trip.title}」（${trip.startDate}～${trip.endDate}）。新資料會接在各日既有停靠點之後，不會覆蓋任何資料。` }),
      btn(`加入「${trip.title}」`, intoCurrent, 'btn')) : null,
    h('div', { class: 'form-actions' }, btn('取消', cancel, 'btn ghost')));
}

// ---------- 貼上行程內容 ----------
function viewPaste() {
  const ta = h('textarea', { rows: '10', class: 'paste-box', placeholder: '貼上 AI 產生的 JSON，或從試算表複製的表格（含第一列欄名）', 'aria-label': '行程內容', spellcheck: 'false', autocapitalize: 'off' });
  const errorBox = h('div', { class: 'form-errors', role: 'alert' });
  function check() {
    let text = ta.value.trim();
    if (!text) {
      errorBox.replaceChildren(h('p', { text: '請先貼上內容。' }));
      return;
    }
    // 去掉 AI 常附帶的 ``` 程式碼框
    text = text.replace(/^```(?:json|csv)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (text.startsWith('{')) {
      state.pendingImport = { ...C.parseImport(text), fileName: '貼上的內容' };
    } else {
      state.pendingImport = { ...V.csvToDrafts(text), kind: 'csv', encoding: '文字', fileName: '貼上的表格' };
    }
    go('#import');
  }
  return h('div', { class: 'view form-view' },
    h('header', { class: 'page-header' }, h('h1', { text: '貼上行程內容' })),
    h('p', { class: 'hint', text: '支援兩種內容：AI 依提示詞產生的 JSON，或從 Excel／Numbers／Google 試算表直接複製的表格。下一步會先預覽，確認後才寫入。' }),
    navigator.clipboard && navigator.clipboard.readText ? btn('從剪貼簿貼上', async () => {
      try { ta.value = await navigator.clipboard.readText(); } catch { toast('無法讀取剪貼簿，請長按文字框手動貼上', { duration: 4000 }); }
    }, 'btn ghost') : null,
    ta,
    errorBox,
    h('div', { class: 'form-actions' },
      btn('檢查並預覽', check, 'btn primary'),
      h('a', { class: 'btn ghost', href: '#guide' }, '查看說明'),
      btn('取消', () => (history.length > 1 ? history.back() : go('#app')), 'btn ghost')));
}

// ---------- 說明：如何建立行程檔 ----------
function viewGuide() {
  const appUrl = `${location.origin}${location.pathname}`;
  const colRows = [
    ['日期', '2026-11-12；留空＝候選景點'],
    ['順序', '同一天的先後（數字，可留空＝依列的順序）'],
    ['城市', 'Vienna、Budapest…；只有名稱時，導航需要城市'],
    ['名稱', '必填'],
    ['當地名稱', '例：Karlskirche；導航會優先用原名搜尋'],
    ['類型', '景點、住宿、會議、車站、交通、用餐、其他'],
    ['開始時間／結束時間', '09:30（24 小時制）'],
    ['地址', '完整地址最可靠'],
    ['座標／入口座標', '「緯度, 經度」，例：48.1982, 16.3719'],
    ['交通方式', '步行、大眾運輸、開車、自行車'],
    ['已確認地點', '填「是」表示已實際確認目的地'],
    ['參考網址', 'https:// 開頭'],
    ['備註', '純文字；請勿填訂位代碼或密碼'],
  ];
  return h('div', { class: 'view guide-view' },
    h('header', { class: 'page-header' },
      h('h1', { text: '如何建立行程' }),
      h('p', { class: 'sub', text: '三種方式擇一即可；資料都只存在您自己的手機。' })),

    h('section', { class: 'card' },
      h('h2', { text: '方式一：在 App 內逐筆新增' }),
      h('p', { text: '在首頁「我的旅程」按「建立新旅程」，進入旅程後到「編輯行程」按「新增停靠點」。適合停靠點不多、或臨時增加。' })),

    h('section', { class: 'card' },
      h('h2', { text: '方式二：用試算表填寫（Excel／Numbers／Google 試算表）' }),
      h('ol', null,
        h('li', null, '下載 Excel 範本（建議）：「行程」分頁有下拉選單，「填寫說明」分頁有完整規則。照範例填寫，範例列可刪除，第一列欄名請勿修改。'),
        h('li', null, '存檔後把 .xlsx 傳到手機，在首頁「我的旅程 → 匯入檔案」直接選取，不需要另存 CSV。'),
        h('li', null, '使用 Google 試算表或 Numbers 者，可下載 CSV 範本，填好後匯出 CSV 再匯入；也可以選取整個表格複製，到「貼上行程內容」貼上。')),
      h('p', { class: 'hint', text: 'Excel 與 CSV 範本的欄名與規則完全相同，兩種檔案都能匯入。' }),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn primary', href: './data/trip-template.xlsx', download: 'trip-template.xlsx' }, '下載 Excel 範本'),
        h('a', { class: 'btn ghost', href: './data/trip-template.csv', download: 'trip-template.csv' }, '下載 CSV 範本')),
      h('table', { class: 'col-table' },
        h('thead', null, h('tr', null, h('th', { text: '欄位' }), h('th', { text: '填寫方式' }))),
        h('tbody', null, colRows.map(([a, b]) => h('tr', null, h('td', { text: a }), h('td', { text: b })))))),

    h('section', { class: 'card' },
      h('h2', { text: '方式三：請 AI 幫忙轉換（ChatGPT／Claude／Gemini）' }),
      h('ol', null,
        h('li', null, '複製下方提示詞，貼到 AI 對話中。'),
        h('li', null, '在提示詞最後的「我的行程」貼上您的行程（文字、表格、訂位信內容皆可；請先刪除訂位代碼與付款資訊）。'),
        h('li', null, '複製 AI 回覆的 JSON，到本 App「貼上行程內容」貼上並預覽，確認後匯入。')),
      h('p', { class: 'hint', text: 'AI 可能出錯：匯入前的檢查會擋下格式錯誤；地址與座標請務必自行確認，App 會把未確認的地點標示「定位待確認」。' }),
      h('div', { class: 'btn-row' },
        btn('複製提示詞', async () => {
          try {
            await navigator.clipboard.writeText(V.AI_PROMPT);
            toast('已複製提示詞', { duration: 2500 });
          } catch {
            toast('無法自動複製，請長按下方文字全選複製', { duration: 4000 });
          }
        }, 'btn primary'),
        h('a', { class: 'btn ghost', href: '#paste' }, '貼上 AI 結果'),
        h('a', { class: 'btn ghost', href: './data/trip-template.json', download: 'trip-template.json' }, '下載 JSON 範本')),
      h('pre', { class: 'prompt-box', text: V.AI_PROMPT })),

    h('section', { class: 'card' },
      h('h2', { text: '分享給朋友' }),
      h('p', null, '請朋友用 iPhone Safari 開啟 ', h('strong', { text: appUrl }), '，加入主畫面後依上面任一方式建立行程。每個人的資料只在自己的手機裡，彼此看不到。'),
      h('p', { class: 'hint', text: '若想把自己規劃好的行程給朋友參考，可在該旅程的「旅程設定 → 匯出分享範本」，會移除完成紀錄與備註。Android 手機請到「App 設定／備份」把地圖改為 Google 地圖。' })),
    btn('返回', () => (history.length > 1 ? history.back() : go('#trips')), 'btn ghost'));
}

// ---------- 旅程管理 ----------
async function switchTrip(tripId) {
  state.activeTripId = tripId;
  await DB.setMeta('activeTripId', tripId).catch(() => {});
  const trip = activeTrip();
  if (trip) {
    const r = C.resolveDefaultDate(trip);
    state.viewDate = r.date;
    state.phase = r.phase;
    state.todayInTrip = r.today;
  }
  state.expanded.clear();
  state.modeOverride = {};
}

function viewTrips() {
  const sorted = state.trips.slice().sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  return h('div', { class: 'view trips-view' },
    h('header', { class: 'page-header' },
      h('h1', { text: '我的旅程' }),
      h('p', { class: 'sub', text: '點選旅程即可進入；資料只存在這支手機。' })),
    sorted.length ? h('ul', { class: 'date-list' }, sorted.map((t) => {
      const p = C.progress(t.stops.filter((s) => s.date !== null));
      const r = C.resolveDefaultDate(t);
      const phase = r.phase === 'during' ? '進行中' : r.phase === 'before' ? '尚未出發' : '已結束';
      return h('li', null, h('button', {
        type: 'button', class: `date-item${t.tripId === state.activeTripId ? ' is-today' : ''}`,
        on: { click: async () => { await switchTrip(t.tripId); go('#today'); } },
      },
      h('span', { class: 'date-item-top' },
        h('strong', { text: t.title }),
        h('span', { class: `chip${r.phase === 'during' ? ' today' : ''}`, text: phase }),
        t.tripId === state.activeTripId ? h('span', { class: 'chip city', text: '上次使用' }) : null),
      h('span', { class: 'date-item-sub', text: `${C.formatDateShort(t.startDate)} – ${C.formatDateShort(t.endDate)}・完成 ${p.completed}/${p.total}・略過 ${p.skipped}` })));
    })) : h('p', { class: 'empty-line', text: '目前沒有旅程。' }),
    h('section', { class: 'card' },
      h('h2', { text: '新增旅程' }),
      h('div', { class: 'btn-col' },
        h('a', { class: 'btn primary', href: '#tripform/new' }, '＋ 建立新旅程'),
        h('label', { class: 'btn ghost', for: 'trips-import', role: 'button', tabindex: '0' }, '匯入檔案（Excel／CSV／JSON）…'),
        h('input', { type: 'file', accept: '.json,.csv,.xlsx,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'visually-hidden', id: 'trips-import', on: { change: (e) => handleImportFile(e.target.files && e.target.files[0], e.target) } }),
        h('a', { class: 'btn ghost', href: '#paste' }, '貼上行程內容（例如 AI 產生的 JSON）'),
        h('a', { class: 'btn ghost', href: '#guide' }, '如何建立行程？'),
        btn('載入示範旅程', loadDemo, 'btn ghost'))),
    state.trips.length ? h('section', { class: 'card' },
      h('h2', { text: '備份與還原' }),
      h('p', { class: 'hint', text: state.lastExportAt ? `上次備份：${formatLocalTime(state.lastExportAt)}。完整備份包含所有旅程。` : '尚未備份。完整備份包含所有旅程。' }),
      h('div', { class: 'btn-row' },
        btn('匯出完整備份', () => exportBackup(), 'btn'),
        h('a', { class: 'btn ghost', href: '#app' }, '備份、地圖與 App 設定'))) : null,
    versionLine());
}

function viewTripForm(trip) {
  const isNew = !trip;
  const tz0 = trip ? trip.timeZone : 'Europe/Vienna';
  const tzOptions = C.COMMON_TIME_ZONES.includes(tz0) ? C.COMMON_TIME_ZONES : [tz0, ...C.COMMON_TIME_ZONES];
  const inp = {
    title: h('input', { type: 'text', value: trip ? trip.title : '', placeholder: '例：2026 中歐旅行', required: true }),
    start: h('input', { type: 'date', value: trip ? trip.startDate : '' }),
    end: h('input', { type: 'date', value: trip ? trip.endDate : '' }),
    tz: h('select', null, tzOptions.map((z) => h('option', { value: z, selected: z === tz0 }, z)), h('option', { value: '__custom' }, '其他（自行輸入）…')),
    tzCustom: h('input', { type: 'text', placeholder: 'IANA 時區，例：Europe/Lisbon', hidden: true }),
    mode: h('select', null, C.MODES.map((m) => h('option', { value: m, selected: m === (trip ? trip.settings.defaultMode : 'walking') }, C.MODE_LABELS[m]))),
  };
  inp.tz.addEventListener('change', () => { inp.tzCustom.hidden = inp.tz.value !== '__custom'; });
  const errorBox = h('div', { class: 'form-errors', role: 'alert' });

  async function save() {
    const errors = [];
    const title = inp.title.value.trim();
    const startDate = inp.start.value;
    const endDate = inp.end.value;
    const timeZone = inp.tz.value === '__custom' ? inp.tzCustom.value.trim() : inp.tz.value;
    if (!title) errors.push('請填寫旅程名稱。');
    if (!C.isValidDateString(startDate) || !C.isValidDateString(endDate)) errors.push('請填寫起訖日期。');
    else if (startDate > endDate) errors.push('起始日不可晚於結束日。');
    if (!C.isValidTimeZone(timeZone)) errors.push('時區名稱不正確。');
    if (trip && !errors.length) {
      const outside = trip.stops.filter((s) => s.date !== null && (s.date < startDate || s.date > endDate));
      if (outside.length) errors.push(`有 ${outside.length} 個停靠點的日期會落在新期間之外（例如「${outside[0].title}」），請先改期或移到候選。`);
    }
    errorBox.replaceChildren(...errors.map((e) => h('p', { text: e })));
    if (errors.length) return;
    if (isNew) {
      const t = C.createTrip({ title, timeZone, startDate, endDate, defaultMode: inp.mode.value });
      const ok = await commitTrip(t, { rerender: false });
      if (!ok) return;
      await switchTrip(t.tripId);
      go('#today');
    } else {
      const ok = await commitTrip({ ...trip, title, startDate, endDate, timeZone, settings: { ...trip.settings, defaultMode: inp.mode.value } }, { rerender: false });
      if (!ok) return;
      await switchTrip(trip.tripId);
      go('#settings');
    }
  }

  return h('div', { class: 'view form-view' },
    h('header', { class: 'page-header' }, h('h1', { text: isNew ? '建立新旅程' : '編輯旅程資訊' })),
    h('form', { class: 'stop-form', novalidate: true, on: { submit: (e) => { e.preventDefault(); save(); } } },
      errorBox,
      field('旅程名稱', inp.title),
      h('div', { class: 'two-col' }, field('起始日（當地）', inp.start), field('結束日（當地）', inp.end)),
      field('旅行地時區', inp.tz, '「今天」依此時區判斷，不受手機所在時區影響'),
      inp.tzCustom,
      field('預設交通方式', inp.mode),
      h('div', { class: 'form-actions' },
        h('button', { type: 'submit', class: 'btn primary' }, isNew ? '建立' : '儲存'),
        btn('取消', () => (history.length > 1 ? history.back() : go('#today')), 'btn ghost'))));
}

async function removeTrip(trip) {
  if (!window.confirm(`確定刪除「${trip.title}」與其所有紀錄？此動作無法復原（除非您有備份）。`)) return;
  try {
    await DB.deleteTrip(trip.tripId);
  } catch (e) {
    toast(`刪除失敗：${e.message || e}`, { kind: 'error' });
    return;
  }
  state.trips = state.trips.filter((t) => t.tripId !== trip.tripId);
  gcImages();
  await switchTrip(state.trips[0] ? state.trips[0].tripId : null);
  toast(`已刪除旅程：${trip.title}`);
  go(state.trips.length ? '#today' : '#welcome');
}

// ---------- 歡迎（尚無旅程） ----------
function viewWelcome() {
  return h('div', { class: 'view welcome' },
    h('header', { class: 'page-header' },
      h('h1', { text: '旅程導航助手' }),
      h('p', { class: 'sub', text: '已規劃行程的執行介面：看下一站 → 一按開啟 Apple Maps → 回來手動標記完成。' })),
    h('div', { class: 'btn-col' },
      h('a', { class: 'btn primary big', href: '#tripform/new' }, '建立新旅程'),
      h('label', { class: 'btn big', for: 'welcome-import', role: 'button', tabindex: '0' }, '匯入檔案（Excel／CSV／JSON）…'),
      h('a', { class: 'btn ghost', href: '#paste' }, '貼上行程內容（例如 AI 產生的 JSON）'),
      h('a', { class: 'btn ghost', href: '#guide' }, '如何建立行程檔？'),
      h('input', { type: 'file', accept: '.json,.csv,.xlsx,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'visually-hidden', id: 'welcome-import', on: { change: (e) => handleImportFile(e.target.files && e.target.files[0], e.target) } }),
      btn('先看看示範旅程', loadDemo, 'btn ghost'),
      h('a', { class: 'btn ghost', href: '#app' }, 'App 設定與導航測試')),
    h('section', { class: 'card' },
      h('h2', { text: '開始之前' }),
      h('ul', null,
        h('li', { text: '請用 Safari 開啟，並「加入主畫面」，之後都從主畫面圖示開啟。' }),
        h('li', { text: '不需要帳號；資料只存在這支手機，請定期匯出備份。' }),
        h('li', { text: '本 App 不做即時路線規劃，路線由 Apple Maps 負責；離線地圖請在 Apple Maps 中事先下載。' }))),
    versionLine());
}

async function loadDemo() {
  try {
    const res = await fetch('./data/demo-trip.json', { cache: 'no-cache' });
    const text = await res.text();
    const r = C.parseImport(text);
    if (!r.ok) throw new Error(r.errors[0]);
    const t = r.trips[0];
    // 示範旅程每次載入都用新的 id，避免覆蓋
    t.tripId = C.uuid();
    t.stops = t.stops.map((s) => ({ ...s, id: C.uuid() }));
    const ok = await commitTrip(t, { rerender: false });
    if (!ok) return;
    await switchTrip(t.tripId);
    toast('已載入示範旅程（虛構資料，可隨時刪除）', { duration: 4000 });
    go('#today');
  } catch (e) {
    toast(`無法載入示範旅程：${e.message || e}`, { kind: 'error' });
  }
}

// ---------- 導航測試 ----------
function viewMapTest(trip) {
  const sample = {
    title: '卡爾教堂', localName: 'Karlskirche', city: 'Vienna', address: null,
    coordinates: null, entranceCoordinates: null, defaultMode: 'walking',
  };
  const sampleHu = { title: '漁人堡', localName: 'Halászbástya', city: 'Budapest' };
  const rows = [];
  for (const [label, opts] of [
    ['官方統一網址', { provider: 'apple', appleStyle: 'unified' }],
    ['舊式網址', { provider: 'apple', appleStyle: 'legacy' }],
    ['maps:// 直接開 App', { provider: 'apple', appleStyle: 'scheme' }],
    ['Google 地圖', { provider: 'google' }],
  ]) {
    rows.push(h('section', { class: 'card' },
      h('h2', { text: label }),
      h('div', { class: 'btn-col' },
        h('a', { class: 'btn nav', href: C.buildDirectionsUrl(sample, 'walking', opts), rel: 'noopener' }, 'Karlskirche · 步行'),
        h('a', { class: 'btn nav', href: C.buildDirectionsUrl(sample, 'transit', opts), rel: 'noopener' }, 'Karlskirche · 大眾運輸'),
        h('a', { class: 'btn ghost', href: C.buildDirectionsUrl(sampleHu, 'walking', opts), rel: 'noopener' }, 'Halászbástya（匈牙利文字元）· 步行')),
      h('code', { class: 'url', text: C.buildDirectionsUrl(sample, 'walking', opts) })));
  }
  return h('div', { class: 'view' },
    h('header', { class: 'page-header' }, h('h1', { text: '導航測試' })),
    h('p', { class: 'hint', text: '請在 iPhone 主畫面 App 中逐一點擊，記錄：是否直接切到地圖 App、目的地是否正確、交通方式是否正確、返回後本頁是否還在。若官方統一網址停留在網頁內，請到設定改用「maps:// 直接開啟 App」。' }),
    rows,
    h('a', { class: 'btn ghost', href: '#app' }, '返回 App 設定'));
}

// ---------- 啟動 ----------
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    state.swState = 'unsupported';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    const markReady = async () => {
      const keys = await caches.keys();
      state.swState = keys.some((k) => k.startsWith('tc-shell-')) ? 'ready' : 'unknown';
      if (state.route.name === 'settings') render();
    };
    navigator.serviceWorker.ready.then(markReady);
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'CACHED') markReady();
    });
    const onWaiting = (worker) => {
      state.updateReady = () => {
        worker.postMessage({ type: 'SKIP_WAITING' });
      };
      renderStatusBar();
    };
    if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) onWaiting(nw);
        if (nw.state === 'activated') markReady();
      });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !state.updateReady) return;
      reloading = true;
      saveSession();
      location.reload();
    });
  } catch (e) {
    state.swState = 'unknown';
    console.warn('Service Worker 註冊失敗', e);
  }
}

async function init() {
  try {
    state.trips = await DB.getAllTrips();
    try {
      state.images = new Map((await DB.getAllImages()).map((im) => [im.id, im]));
    } catch { state.images = new Map(); }
    state.lastExportAt = await DB.getMeta('lastExportAt', null);
    state.onboardingDismissed = await DB.getMeta('onboardingDismissed', false);
    try { state.themeMode = localStorage.getItem('tc-theme') || 'auto'; } catch { state.themeMode = 'auto'; }
    if (!['auto', 'light', 'dark'].includes(state.themeMode)) state.themeMode = 'auto';
    const savedWx = await DB.getMeta('weatherPrefs', null);
    if (savedWx) state.weatherPrefs = { ...state.weatherPrefs, ...savedWx };
    const savedClock = await DB.getMeta('clockPrefs', null);
    if (savedClock) state.clockPrefs = { ...state.clockPrefs, ...savedClock };
    if (!state.clockPrefs.homeTz) {
      // 第一次開啟：記下手機目前的時區作為家鄉時區（之後出國不會跟著變）
      let tz = 'Asia/Taipei';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* 使用預設 */ }
      state.clockPrefs.homeTz = tz;
      DB.setMeta('clockPrefs', state.clockPrefs).catch(() => {});
    }
    const savedPhoto = await DB.getMeta('photoPrefs', null);
    if (savedPhoto) state.photoPrefs = { ...state.photoPrefs, ...savedPhoto };
    const savedMap = await DB.getMeta('mapPrefs', null);
    if (savedMap) state.mapPrefs = { ...state.mapPrefs, ...savedMap };
    const savedActive = await DB.getMeta('activeTripId', null);
    const session = await DB.getMeta('session', null);
    const activeId = state.trips.some((t) => t.tripId === savedActive) ? savedActive : (state.trips[0] && state.trips[0].tripId);
    await switchTrip(activeId || null);
    // 兩小時內重新開啟：回到原本的日期與頁面（例如從地圖 App 返回而 App 被系統重載）
    if (session && Date.now() - session.savedAt < 2 * 3600 * 1000 && session.tripId === state.activeTripId) {
      const trip = activeTrip();
      if (trip && C.listDates(trip.startDate, trip.endDate).includes(session.viewDate)) state.viewDate = session.viewDate;
      if (!location.hash && session.hash) history.replaceState(null, '', session.hash);
      if (session.scrollY) scrollMemory.set(`${parseRoute().name}/${parseRoute().arg || ''}`, session.scrollY);
    }
  } catch (e) {
    document.getElementById('main').replaceChildren(h('div', { class: 'view' },
      h('h1', { text: '無法開啟本機資料庫' }),
      h('p', { text: String(e.message || e) }),
      h('p', { text: '若使用私密瀏覽模式，請改用一般模式或主畫面 App。' })));
    return;
  }

  window.addEventListener('hashchange', () => { render(); saveSession(); });
  window.addEventListener('online', renderStatusBar);
  window.addEventListener('offline', renderStatusBar);
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveSession, 400);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSession();
    else {
      // 回到前景時重新判斷「今天」（例如跨過午夜）
      const trip = activeTrip();
      if (trip) {
        const r = C.resolveDefaultDate(trip);
        const dayChanged = r.today !== state.todayInTrip;
        state.todayInTrip = r.today;
        state.phase = r.phase;
        if (dayChanged && r.phase === 'during' && !['stop', 'new', 'tripform', 'import'].includes(state.route.name)) {
          state.viewDate = r.date;
          render();
        }
      }
    }
  });

  applyTheme();
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (state.themeMode === 'auto') { applyTheme(); render(); } };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  render();
  startClock();
  registerServiceWorker();
  setTimeout(gcImages, 3000);
  DB.requestPersistence().then((p) => { state.persisted = p; });
}

init();
