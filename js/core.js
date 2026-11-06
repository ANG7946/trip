// core.js — 純邏輯模組（不依賴 DOM，可在 Node 測試）
// 資料模型、驗證、地圖網址、旅行時區日期、下一站與進度計算

export const SCHEMA_VERSION = 1;
export const BACKUP_FORMAT = 'travel-companion-backup';
export const TEMPLATE_FORMAT = 'travel-companion-trip';
export const MAX_IMPORT_BYTES = 60 * 1024 * 1024; // 含照片的備份可能數 MB 至數十 MB
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BASE64 = 3 * 1024 * 1024; // 單張上限（縮圖後通常 < 100 KB）

export const STATUSES = ['pending', 'completed', 'skipped'];
export const MODES = ['walking', 'transit', 'driving', 'cycling'];
export const STOP_TYPES = ['attraction', 'hotel', 'conference', 'station', 'transfer', 'meal', 'other'];
export const MAP_PROVIDERS = ['apple', 'google'];
export const APPLE_LINK_STYLES = ['unified', 'legacy', 'scheme'];

export const MODE_LABELS = { walking: '步行', transit: '大眾運輸', driving: '開車', cycling: '自行車' };
export const STATUS_LABELS = { pending: '待前往', completed: '已完成', skipped: '已略過' };
export const TYPE_LABELS = {
  attraction: '景點', hotel: '住宿', conference: '會議', station: '車站',
  transfer: '交通轉乘', meal: '用餐', other: '其他',
};

// 常用時區（可於設定中自行輸入其他 IANA 時區）
export const COMMON_TIME_ZONES = [
  'Europe/Vienna', 'Europe/Budapest', 'Europe/Prague', 'Europe/Berlin', 'Europe/Paris',
  'Europe/London', 'Europe/Rome', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Taipei',
  'Asia/Bangkok', 'Asia/Singapore', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney',
];

// ---------- 基本工具 ----------

export function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // 備援（舊環境）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function nowIso() {
  return new Date().toISOString();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidCoords(c) {
  return !!c && typeof c === 'object'
    && typeof c.lat === 'number' && Number.isFinite(c.lat) && c.lat >= -90 && c.lat <= 90
    && typeof c.lng === 'number' && Number.isFinite(c.lng) && c.lng >= -180 && c.lng <= 180;
}

export function isSafeHttpsUrl(s) {
  if (typeof s !== 'string' || !s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 解析使用者輸入的座標字串，如 "48.1982, 16.3719"（緯度,經度）。
 * 也接受 Google Maps 複製的 "48.1982,16.3719"。回傳 null 表示格式不正確。
 */
export function parseCoordsInput(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const c = { lat: Number(m[1]), lng: Number(m[2]) };
  return isValidCoords(c) ? c : null;
}

export function formatCoords(c) {
  return isValidCoords(c) ? `${c.lat},${c.lng}` : '';
}

// ---------- 旅行時區日期 ----------

/** 以指定時區取得某時間點的日期 YYYY-MM-DD（不依賴瀏覽器本地時區）。 */
export function dateInTimeZone(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 以指定時區取得 HH:mm */
export function timeInTimeZone(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('hour')}:${get('minute')}`;
}

/** 列出起訖之間所有日期（含頭尾）。 */
export function listDates(startDate, endDate) {
  if (!isValidDateString(startDate) || !isValidDateString(endDate) || startDate > endDate) return [];
  const out = [];
  const [y, m, d] = startDate.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  let guard = 0;
  while (guard++ < 400) {
    const s = cur.toISOString().slice(0, 10);
    out.push(s);
    if (s === endDate) break;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** "11/12（四）" 這類短格式；日期字串本身即旅行當地日期，故以 UTC 解讀避免位移。 */
export function formatDateShort(dateStr) {
  if (!isValidDateString(dateStr)) return dateStr || '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m}/${d}（${WEEKDAYS[wd]}）`;
}

export function formatDateLong(dateStr) {
  if (!isValidDateString(dateStr)) return dateStr || '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${y} 年 ${m} 月 ${d} 日 星期${WEEKDAYS[wd]}`;
}

/**
 * 決定預設顯示的日期：
 *  1. 旅行當地「今天」在旅程範圍內 → 今天（phase: 'during'）
 *  2. 尚未出發 → 起始日（phase: 'before'，行前預覽）
 *  3. 已結束 → 最後一天（phase: 'after'）
 */
export function resolveDefaultDate(trip, at = new Date()) {
  const today = dateInTimeZone(trip.timeZone, at);
  if (today < trip.startDate) return { date: trip.startDate, today, phase: 'before' };
  if (today > trip.endDate) return { date: trip.endDate, today, phase: 'after' };
  return { date: today, today, phase: 'during' };
}

// ---------- 建立物件 ----------

export function createTrip({ title, timeZone, startDate, endDate, defaultMode = 'walking' }) {
  const ts = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    tripId: uuid(),
    title: title || '我的旅程',
    timeZone: timeZone || 'Europe/Vienna',
    startDate,
    endDate,
    stops: [],
    settings: {
      defaultMode,
      mapProvider: 'apple',
      appleLinkStyle: 'unified',
      lastViewedDate: null,
      preferredLanguage: 'zh-TW',
    },
    createdAt: ts,
    updatedAt: ts,
  };
}

/** date 為 null 代表「候選景點」（尚未排入任何日期）。 */
export function createStop(trip, partial = {}) {
  const date = partial.date === undefined ? null : partial.date;
  return {
    id: uuid(),
    date,
    order: nextOrder(trip, date),
    city: '',
    title: '',
    localName: null,
    type: 'attraction',
    startTime: null,
    endTime: null,
    address: null,
    coordinates: null,
    entranceCoordinates: null,
    destinationConfirmed: false,
    defaultMode: trip.settings?.defaultMode || 'walking',
    notes: null,
    referenceUrl: null,
    status: 'pending',
    completedAt: null,
    skippedAt: null,
    updatedAt: nowIso(),
    ...partial,
  };
}

export function nextOrder(trip, date) {
  const same = trip.stops.filter((s) => s.date === date);
  return same.length ? Math.max(...same.map((s) => s.order)) + 1 : 1;
}

// ---------- 狀態變更（回傳新物件，不改動原物件） ----------

export function applyStatus(stop, status, at = nowIso()) {
  if (!STATUSES.includes(status)) throw new Error(`未知狀態：${status}`);
  const next = { ...stop, status, updatedAt: at, completedAt: null, skippedAt: null };
  if (status === 'completed') next.completedAt = at;
  if (status === 'skipped') next.skippedAt = at;
  return next;
}

/** 依 order 排序同日停靠點（order 相同時以 id 穩定排序）。 */
export function stopsForDate(trip, date) {
  return trip.stops
    .filter((s) => s.date === date)
    .sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function candidates(trip) {
  return stopsForDate(trip, null);
}

/** 將同日停靠點重新編號為 1..n（保持目前順序）。回傳新的 stops 陣列。 */
export function normalizeOrders(stops, date) {
  const sameDay = stops
    .filter((s) => s.date === date)
    .sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1));
  const map = new Map(sameDay.map((s, i) => [s.id, i + 1]));
  return stops.map((s) => (map.has(s.id) && map.get(s.id) !== s.order ? { ...s, order: map.get(s.id) } : s));
}

/** 上移（delta=-1）或下移（delta=+1）。回傳新的 stops 陣列；無法移動時回傳原陣列。 */
export function moveStop(stops, stopId, delta, at = nowIso()) {
  const target = stops.find((s) => s.id === stopId);
  if (!target) return stops;
  const normalized = normalizeOrders(stops, target.date);
  const day = normalized.filter((s) => s.date === target.date).sort((a, b) => a.order - b.order);
  const idx = day.findIndex((s) => s.id === stopId);
  const swapIdx = idx + delta;
  if (idx < 0 || swapIdx < 0 || swapIdx >= day.length) return stops;
  const a = day[idx];
  const b = day[swapIdx];
  return normalized.map((s) => {
    if (s.id === a.id) return { ...s, order: b.order, updatedAt: at };
    if (s.id === b.id) return { ...s, order: a.order, updatedAt: at };
    return s;
  });
}

/** 將停靠點改到另一天（或 null = 候選），排在該日最後。 */
export function moveStopToDate(trip, stopId, newDate, at = nowIso()) {
  const stop = trip.stops.find((s) => s.id === stopId);
  if (!stop || stop.date === newDate) return trip.stops;
  const order = nextOrder(trip, newDate);
  let stops = trip.stops.map((s) => (s.id === stopId ? { ...s, date: newDate, order, updatedAt: at } : s));
  stops = normalizeOrders(stops, stop.date);
  return stops;
}

// ---------- 進度與下一站 ----------

export function progress(stops) {
  const completed = stops.filter((s) => s.status === 'completed').length;
  const skipped = stops.filter((s) => s.status === 'skipped').length;
  const pending = stops.filter((s) => s.status === 'pending').length;
  const total = completed + skipped + pending;
  return {
    completed, skipped, pending, total,
    completedRatio: total === 0 ? 0 : completed / total,
    handledRatio: total === 0 ? 0 : (completed + skipped) / total,
  };
}

/** 下一站 = 依使用者 order 排序後第一個 pending（即使缺少目的地也不跳過）。 */
export function nextStop(trip, date) {
  return stopsForDate(trip, date).find((s) => s.status === 'pending') || null;
}

/** 當日涉及的城市（依出現順序，不重複）。 */
export function citiesForDate(trip, date) {
  const out = [];
  for (const s of stopsForDate(trip, date)) {
    const c = (s.city || '').trim();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

// ---------- 目的地與地圖網址 ----------

/**
 * 決定導航目的地。優先序：入口座標 → 地點座標 → 地址 → 名稱＋城市。
 * level: 'entrance' | 'coords' | 'address' | 'name' | null
 *  - 'name' 屬於「定位待確認」等級：可導航但介面須提示風險。
 *  - null 代表沒有足夠資訊，不產生連結。
 */
export function resolveDestination(stop) {
  if (isValidCoords(stop.entranceCoordinates)) {
    return { level: 'entrance', value: formatCoords(stop.entranceCoordinates), coords: stop.entranceCoordinates };
  }
  if (isValidCoords(stop.coordinates)) {
    return { level: 'coords', value: formatCoords(stop.coordinates), coords: stop.coordinates };
  }
  const address = (stop.address || '').trim();
  if (address) return { level: 'address', value: address, coords: null };
  const name = ((stop.localName || '').trim() || (stop.title || '').trim());
  const city = (stop.city || '').trim();
  if (name && city) {
    const value = name.toLowerCase().includes(city.toLowerCase()) ? name : `${name}, ${city}`;
    return { level: 'name', value, coords: null };
  }
  return { level: null, value: null, coords: null };
}

export const DESTINATION_LEVEL_LABELS = {
  entrance: '入口座標',
  coords: '地點座標',
  address: '地址',
  name: '僅名稱（定位待確認）',
};

const LEGACY_DIRFLG = { walking: 'w', transit: 'r', driving: 'd' }; // 舊格式不支援自行車
const GOOGLE_MODE = { walking: 'walking', transit: 'transit', driving: 'driving', cycling: 'bicycling' };

/**
 * 產生導航網址。沒有有效目的地時回傳 null。
 * provider: 'apple' | 'google'
 * appleStyle: 'unified'（iOS 18.4+ 官方統一網址）| 'legacy'（舊式 maps.apple.com/?daddr=）| 'scheme'（maps:// 直接開 App）
 */
export function buildDirectionsUrl(stop, mode, { provider = 'apple', appleStyle = 'unified' } = {}) {
  const dest = resolveDestination(stop);
  if (!dest.level) return null;
  const m = MODES.includes(mode) ? mode : 'walking';

  if (provider === 'google') {
    const u = new URL('https://www.google.com/maps/dir/');
    u.searchParams.set('api', '1');
    u.searchParams.set('destination', dest.value);
    u.searchParams.set('travelmode', GOOGLE_MODE[m]);
    return u.toString();
  }

  if (appleStyle === 'legacy' || appleStyle === 'scheme') {
    const base = appleStyle === 'scheme' ? 'maps://' : 'https://maps.apple.com/';
    const params = new URLSearchParams();
    params.set('daddr', dest.value);
    if (LEGACY_DIRFLG[m]) params.set('dirflg', LEGACY_DIRFLG[m]);
    return `${base}?${params.toString()}`;
  }

  const u = new URL('https://maps.apple.com/directions');
  u.searchParams.set('destination', dest.value);
  u.searchParams.set('mode', m);
  return u.toString();
}

/** 「在地圖中查看地點」備援網址（不規劃路線）。 */
export function buildPlaceUrl(stop, { provider = 'apple' } = {}) {
  const dest = resolveDestination(stop);
  if (!dest.level) return null;
  if (provider === 'google') {
    const u = new URL('https://www.google.com/maps/search/');
    u.searchParams.set('api', '1');
    u.searchParams.set('query', dest.value);
    return u.toString();
  }
  if (dest.coords) {
    const u = new URL('https://maps.apple.com/place');
    u.searchParams.set('coordinate', dest.value);
    const name = (stop.localName || stop.title || '').trim();
    if (name) u.searchParams.set('name', name);
    return u.toString();
  }
  const u = new URL('https://maps.apple.com/search');
  u.searchParams.set('query', dest.value);
  return u.toString();
}

/** 供「複製」使用的文字：地址與座標並列，方便貼到任何地圖。 */
export function copyableLocation(stop) {
  const lines = [];
  const name = [stop.title, stop.localName].filter(Boolean).join(' / ');
  if (name) lines.push(name);
  if (stop.address) lines.push(stop.address);
  if (isValidCoords(stop.entranceCoordinates)) lines.push(`入口：${formatCoords(stop.entranceCoordinates)}`);
  if (isValidCoords(stop.coordinates)) lines.push(`座標：${formatCoords(stop.coordinates)}`);
  if (lines.length <= 1 && stop.city) lines.push(stop.city);
  return lines.join('\n');
}

// ---------- 驗證 ----------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function optString(v) {
  return v === undefined || v === null || typeof v === 'string';
}

/**
 * 驗證單一旅程。回傳錯誤訊息陣列（空陣列表示通過）。
 * 規則依規格 §8.2；匯入資料不做任何「自動修正」，有問題就回報。
 */
export function validateTrip(trip, label = '旅程') {
  const errors = [];
  const err = (m) => errors.push(`${label}：${m}`);
  if (typeOf(trip) !== 'object') {
    err('不是物件');
    return errors;
  }
  if (trip.schemaVersion !== SCHEMA_VERSION) err(`schemaVersion 必須為 ${SCHEMA_VERSION}（目前為 ${JSON.stringify(trip.schemaVersion)}）`);
  if (typeof trip.tripId !== 'string' || !trip.tripId) err('缺少 tripId');
  if (typeof trip.title !== 'string' || !trip.title.trim()) err('缺少旅程名稱 title');
  if (!isValidTimeZone(trip.timeZone)) err(`時區 timeZone 不正確：${JSON.stringify(trip.timeZone)}`);
  if (!isValidDateString(trip.startDate)) err(`起始日 startDate 格式錯誤：${JSON.stringify(trip.startDate)}`);
  if (!isValidDateString(trip.endDate)) err(`結束日 endDate 格式錯誤：${JSON.stringify(trip.endDate)}`);
  if (isValidDateString(trip.startDate) && isValidDateString(trip.endDate)) {
    if (trip.startDate > trip.endDate) err('起始日晚於結束日');
    if (listDates(trip.startDate, trip.endDate).length > 366) err('旅程期間超過一年');
  }
  if (typeOf(trip.settings) !== 'object') err('缺少 settings');
  else {
    if (!MODES.includes(trip.settings.defaultMode)) err('settings.defaultMode 不正確');
    if (trip.settings.mapProvider !== undefined && !MAP_PROVIDERS.includes(trip.settings.mapProvider)) err('settings.mapProvider 不正確');
    if (trip.settings.appleLinkStyle !== undefined && !APPLE_LINK_STYLES.includes(trip.settings.appleLinkStyle)) err('settings.appleLinkStyle 不正確');
  }
  if (!Array.isArray(trip.stops)) {
    err('stops 必須是陣列');
    return errors;
  }
  const ids = new Set();
  trip.stops.forEach((s, i) => {
    const sl = `第 ${i + 1} 個停靠點${s && typeof s.title === 'string' && s.title ? `「${s.title}」` : ''}`;
    const e = (m) => err(`${sl} ${m}`);
    if (typeOf(s) !== 'object') {
      e('不是物件');
      return;
    }
    if (typeof s.id !== 'string' || !s.id) e('缺少 id');
    else if (ids.has(s.id)) e(`id 重複：${s.id}`);
    else ids.add(s.id);
    if (s.date !== null) {
      if (!isValidDateString(s.date)) e(`日期格式錯誤：${JSON.stringify(s.date)}`);
      else if (isValidDateString(trip.startDate) && isValidDateString(trip.endDate)
        && (s.date < trip.startDate || s.date > trip.endDate)) e(`日期 ${s.date} 不在旅程期間內`);
    }
    if (typeof s.order !== 'number' || !Number.isFinite(s.order)) e('order 必須是數字');
    if (typeof s.title !== 'string' || !s.title.trim()) e('缺少名稱 title');
    if (typeof s.city !== 'string') e('city 必須是文字（可為空字串）');
    if (!STOP_TYPES.includes(s.type)) e(`類型 type 不正確：${JSON.stringify(s.type)}`);
    if (!MODES.includes(s.defaultMode)) e(`交通方式 defaultMode 不正確：${JSON.stringify(s.defaultMode)}`);
    if (!STATUSES.includes(s.status)) e(`狀態 status 不正確：${JSON.stringify(s.status)}`);
    for (const k of ['localName', 'address', 'notes', 'completedAt', 'skippedAt']) {
      if (!optString(s[k])) e(`${k} 必須是文字或 null`);
    }
    for (const k of ['startTime', 'endTime']) {
      if (s[k] !== undefined && s[k] !== null && !isValidTime(s[k])) e(`${k} 必須是 HH:mm`);
    }
    for (const k of ['coordinates', 'entranceCoordinates']) {
      if (s[k] !== undefined && s[k] !== null && !isValidCoords(s[k])) e(`${k} 座標超出範圍或格式錯誤`);
    }
    if (typeof s.destinationConfirmed !== 'boolean') e('destinationConfirmed 必須是 true/false');
    if (s.referenceUrl !== undefined && s.referenceUrl !== null && !isSafeHttpsUrl(s.referenceUrl)) e('參考網址只接受 https://');
    if (s.status === 'completed' && !s.completedAt) e('已完成但缺少 completedAt');
    if (s.status !== 'completed' && s.completedAt) e('非完成狀態卻有 completedAt');
    if (s.status === 'skipped' && !s.skippedAt) e('已略過但缺少 skippedAt');
    if (s.status !== 'skipped' && s.skippedAt) e('非略過狀態卻有 skippedAt');
    if (typeof s.updatedAt !== 'string') e('缺少 updatedAt');
    if (s.userPhoto !== undefined && s.userPhoto !== null && !(typeOf(s.userPhoto) === 'object' && typeof s.userPhoto.id === 'string' && s.userPhoto.id)) e('userPhoto 格式錯誤');
  });
  return errors;
}

/**
 * 解析匯入檔案文字。支援兩種格式：
 *  - 完整備份 { format: 'travel-companion-backup', trips: [...] }
 *  - 單一旅程（含範本）{ schemaVersion, tripId, ... }
 * 回傳 { ok, kind: 'backup'|'trip', trips, errors, summary }
 */
export function parseImport(text, byteLength = text ? text.length : 0) {
  const fail = (errors) => ({ ok: false, kind: null, trips: [], errors, summary: null });
  if (byteLength > MAX_IMPORT_BYTES) return fail([`檔案過大（上限 ${MAX_IMPORT_BYTES / 1024 / 1024} MB）`]);
  if (typeof text !== 'string' || !text.trim()) return fail(['檔案是空的']);
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return fail([`不是合法的 JSON：${e.message}`]);
  }
  if (typeOf(data) !== 'object') return fail(['JSON 最外層必須是物件']);

  let kind;
  let trips;
  if (data.format === BACKUP_FORMAT) {
    if (data.schemaVersion !== SCHEMA_VERSION) return fail([`備份 schemaVersion ${JSON.stringify(data.schemaVersion)} 與本版（${SCHEMA_VERSION}）不相容`]);
    if (!Array.isArray(data.trips)) return fail(['備份缺少 trips 陣列']);
    kind = 'backup';
    trips = data.trips;
  } else if ('tripId' in data || 'stops' in data) {
    kind = 'trip';
    trips = [normalizeIncomingTrip(data)];
  } else {
    return fail(['無法辨識的檔案格式（不是本 App 的備份或行程檔）']);
  }

  const errors = [];
  let images = null;
  if (kind === 'backup' && data.images !== undefined) {
    images = validateImages(data.images, errors);
  }
  const tripIds = new Set();
  trips.forEach((t, i) => {
    errors.push(...validateTrip(t, trips.length > 1 ? `旅程 ${i + 1}` : '旅程'));
    if (t && typeof t.tripId === 'string') {
      if (tripIds.has(t.tripId)) errors.push(`旅程 tripId 重複：${t.tripId}`);
      tripIds.add(t.tripId);
    }
  });
  if (errors.length) return fail(errors);

  const summary = trips.map((t) => {
    const scheduled = t.stops.filter((s) => s.date !== null);
    const p = progress(scheduled);
    return {
      tripId: t.tripId, title: t.title, startDate: t.startDate, endDate: t.endDate,
      timeZone: t.timeZone, total: p.total, completed: p.completed, skipped: p.skipped,
      candidates: t.stops.length - scheduled.length,
    };
  });
  // 回傳深拷貝並補齊選填設定的預設值
  const clean = trips.map((t) => fillDefaults(JSON.parse(JSON.stringify(t))));
  return { ok: true, kind, trips: clean, images, errors: [], summary, exportedAt: data.exportedAt || null };
}

/**
 * 單一旅程檔（含 AI 產生的檔案）：只補上「缺少的」系統欄位（id、狀態、時間戳等），
 * 不修改任何已存在的值、不補任何旅遊資料；已存在但錯誤的值仍交由 validateTrip 回報。
 * 完整備份不經過這一步（必須完全符合格式）。
 */
export function normalizeIncomingTrip(data) {
  if (typeOf(data) !== 'object') return data;
  const missing = (v) => v === undefined || v === null;
  const t = { ...data };
  if (missing(t.schemaVersion)) t.schemaVersion = SCHEMA_VERSION;
  if (missing(t.tripId) || t.tripId === '') t.tripId = uuid();
  if (missing(t.settings)) t.settings = {};
  if (typeOf(t.settings) === 'object') {
    t.settings = { ...t.settings };
    if (missing(t.settings.defaultMode)) t.settings.defaultMode = 'walking';
  }
  if (Array.isArray(t.stops)) {
    const counters = new Map();
    const ts = nowIso();
    t.stops = t.stops.map((s) => {
      if (typeOf(s) !== 'object') return s;
      const x = { ...s };
      if (x.date === undefined || x.date === '') x.date = null;
      if (missing(x.id) || x.id === '') x.id = uuid();
      const n = (counters.get(x.date) || 0) + 1;
      counters.set(x.date, n);
      if (missing(x.order)) x.order = n;
      if (missing(x.city)) x.city = '';
      if (missing(x.type)) x.type = 'attraction';
      if (missing(x.defaultMode)) x.defaultMode = (typeOf(t.settings) === 'object' && MODES.includes(t.settings.defaultMode)) ? t.settings.defaultMode : 'walking';
      if (missing(x.status)) x.status = 'pending';
      if (missing(x.destinationConfirmed)) x.destinationConfirmed = false;
      for (const k of ['startTime', 'endTime', 'referenceUrl', 'address', 'localName', 'notes']) if (x[k] === '') x[k] = null;
      if (missing(x.updatedAt)) x.updatedAt = ts;
      return x;
    });
  }
  return t;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 驗證備份中的照片；回傳乾淨的照片陣列（錯誤寫入 errors）。 */
export function validateImages(list, errors) {
  if (!Array.isArray(list)) { errors.push('備份的 images 必須是陣列'); return null; }
  const ids = new Set();
  const out = [];
  list.forEach((im, i) => {
    const e = (m) => errors.push(`第 ${i + 1} 張照片：${m}`);
    if (typeOf(im) !== 'object') return e('格式錯誤');
    if (typeof im.id !== 'string' || !im.id) return e('缺少 id');
    if (ids.has(im.id)) return e(`id 重複：${im.id}`);
    ids.add(im.id);
    if (!IMAGE_MIMES.includes(im.mime)) return e(`不支援的格式：${JSON.stringify(im.mime)}`);
    if (typeof im.data !== 'string' || !im.data || im.data.length > MAX_IMAGE_BASE64 || !BASE64_RE.test(im.data)) return e('照片內容損壞或過大');
    out.push({ id: im.id, mime: im.mime, data: im.data, width: Number(im.width) || null, height: Number(im.height) || null, createdAt: typeof im.createdAt === 'string' ? im.createdAt : nowIso() });
  });
  return out;
}

/** 補齊選填欄位（不改動任何已存在的值）。 */
export function fillDefaults(trip) {
  trip.settings = {
    mapProvider: 'apple', appleLinkStyle: 'unified', lastViewedDate: null, preferredLanguage: 'zh-TW',
    ...trip.settings,
  };
  trip.createdAt = trip.createdAt || nowIso();
  trip.updatedAt = trip.updatedAt || nowIso();
  trip.stops = trip.stops.map((s) => ({
    localName: null, startTime: null, endTime: null, address: null, coordinates: null,
    entranceCoordinates: null, notes: null, referenceUrl: null, completedAt: null, skippedAt: null,
    ...s,
  }));
  return trip;
}

// ---------- 匯出 ----------

/** images 為 null 表示「不含照片」的備份（還原時保留手機中既有照片）。 */
export function buildBackup(trips, at = nowIso(), images = null) {
  const b = {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: at,
    app: 'Travel Companion',
    trips,
  };
  if (images) {
    const used = new Set(trips.flatMap((t) => t.stops.map((s) => s.userPhoto && s.userPhoto.id).filter(Boolean)));
    b.images = images.filter((im) => used.has(im.id));
  }
  return b;
}

/** 所有旅程中仍被引用的照片 id */
export function referencedImageIds(trips) {
  return new Set(trips.flatMap((t) => t.stops.map((s) => s.userPhoto && s.userPhoto.id).filter(Boolean)));
}

/** 分享用範本：移除完成狀態、時間戳與備註，產生新的 tripId 與停靠點 id。 */
export function buildTemplate(trip, { keepNotes = false } = {}) {
  const ts = nowIso();
  return {
    format: TEMPLATE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    tripId: uuid(),
    title: trip.title,
    timeZone: trip.timeZone,
    startDate: trip.startDate,
    endDate: trip.endDate,
    settings: { ...trip.settings, lastViewedDate: null },
    stops: trip.stops.map((s) => ({
      ...s,
      id: uuid(),
      status: 'pending',
      completedAt: null,
      skippedAt: null,
      notes: keepNotes ? s.notes : null,
      userPhoto: null, // 自己的照片不放進分享範本（可能有版權或私人內容）
      updatedAt: ts,
    })),
    createdAt: ts,
    updatedAt: ts,
  };
}

export function backupFileName(prefix = 'travel-backup', at = new Date(), timeZone) {
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${prefix}-${g('year')}${g('month')}${g('day')}-${g('hour')}${g('minute')}.json`;
}

/** 把旅程名稱轉成安全的檔名前綴 */
export function slugForFile(title) {
  const ascii = String(title || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return ascii || 'trip';
}

// ---------- 資料遷移 ----------

/**
 * 資料庫內容遷移。目前只有 v1；未來新版本在此依序升級。
 * 原則：只新增欄位或轉換格式，不刪除使用者資料。
 */
export function migrateTrip(trip) {
  if (!trip || typeof trip !== 'object') return trip;
  if (trip.schemaVersion === SCHEMA_VERSION) return fillDefaults(trip);
  // 例：if (trip.schemaVersion === 1) { ...升級至 2...; trip.schemaVersion = 2; }
  throw new Error(`不支援的資料版本：${trip.schemaVersion}`);
}
