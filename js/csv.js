// csv.js — CSV（Excel／Numbers／Google 試算表）匯入與範本
import * as C from './core.js?v=2.0.0';
import { excelSerialToDate, excelFractionToTime } from './xlsx.js?v=2.0.0';

// 欄位定義：key、範本欄名（中文）、可接受的別名
export const CSV_COLUMNS = [
  { key: 'date', header: '日期', aliases: ['date', '日期'] },
  { key: 'order', header: '順序', aliases: ['order', '順序', '序號'] },
  { key: 'city', header: '城市', aliases: ['city', '城市'] },
  { key: 'title', header: '名稱', aliases: ['title', 'name', '名稱', '地點', '景點'] },
  { key: 'localName', header: '當地名稱', aliases: ['localname', 'local name', 'local_name', '當地名稱', '原文名稱', '原文'] },
  { key: 'type', header: '類型', aliases: ['type', '類型'] },
  { key: 'startTime', header: '開始時間', aliases: ['start', 'starttime', 'start time', 'start_time', '開始時間', '時間'] },
  { key: 'endTime', header: '結束時間', aliases: ['end', 'endtime', 'end time', 'end_time', '結束時間'] },
  { key: 'address', header: '地址', aliases: ['address', '地址'] },
  { key: 'coordinates', header: '座標', aliases: ['coordinates', 'coords', 'latlng', '座標', '坐標'] },
  { key: 'entrance', header: '入口座標', aliases: ['entrance', 'entrancecoordinates', '入口座標', '入口坐標'] },
  { key: 'mode', header: '交通方式', aliases: ['mode', 'defaultmode', '交通方式', '交通'] },
  { key: 'confirmed', header: '已確認地點', aliases: ['confirmed', 'destinationconfirmed', '已確認', '已確認地點'] },
  { key: 'url', header: '參考網址', aliases: ['url', 'referenceurl', '網址', '參考網址'] },
  { key: 'notes', header: '備註', aliases: ['notes', 'note', '備註', '說明'] },
];

const TYPE_ALIASES = {
  attraction: ['attraction', '景點', '參觀', '博物館'],
  hotel: ['hotel', '住宿', '飯店', '旅館'],
  conference: ['conference', '會議', '研討會'],
  station: ['station', '車站', '機場'],
  transfer: ['transfer', '交通', '交通轉乘', '轉乘', '移動'],
  meal: ['meal', '用餐', '餐廳', '咖啡'],
  other: ['other', '其他'],
};
const MODE_ALIASES = {
  walking: ['walking', 'walk', '步行', '走路'],
  transit: ['transit', '大眾運輸', '公車', '捷運', '地鐵', '電車', '火車'],
  driving: ['driving', 'drive', 'car', '開車', '計程車', '自駕'],
  cycling: ['cycling', 'bike', 'bicycle', '自行車', '腳踏車', '單車'],
};
const TRUE_WORDS = ['true', 'yes', 'y', '1', '是', '已確認', 'v', '✓', 'ok'];

function norm(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchAlias(value, table) {
  const v = norm(value);
  if (!v) return null;
  for (const [key, list] of Object.entries(table)) {
    if (list.some((a) => norm(a) === v)) return key;
  }
  return undefined; // 有值但無法辨識
}

/** 以 UTF-8 解碼；失敗時改用 Big5（Windows 繁中 Excel 另存 CSV 的預設編碼）。 */
export function decodeCsvBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''), encoding: 'UTF-8' };
  } catch {
    try {
      return { text: new TextDecoder('big5').decode(bytes), encoding: 'Big5' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, ''), encoding: 'UTF-8（含無法辨識字元）' };
    }
  }
}

/** RFC 4180 CSV 解析（支援引號、引號內逗號與換行、"" 跳脫）。自動偵測逗號／分號／Tab。 */
export function parseCsvText(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch] += 1;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // 去除完全空白的列
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** 接受 2026-11-12、2026/11/12、2026/1/5、2026.11.12 */
export function normalizeDate(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return undefined;
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return C.isValidDateString(d) ? d : undefined;
}

/** 接受 9:00、09:00、09:00:00、0900 */
export function normalizeTime(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  let m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) m = t.match(/^(\d{2})(\d{2})$/);
  if (!m) return undefined;
  const v = `${m[1].padStart(2, '0')}:${m[2]}`;
  return C.isValidTime(v) ? v : undefined;
}

/**
 * 將 CSV 文字轉為停靠點草稿。
 * 回傳 { ok, rows: [...草稿], errors, warnings, dateRange: {min,max}|null, columns }
 * 草稿尚未指定 order（同日依檔案順序或「順序」欄）。
 */
export function csvToDrafts(text) {
  return tableToDrafts(parseCsvText(text));
}

const NUMERIC_RE = /^\d+(?:\.\d+)?$/;

/**
 * 共用的表格轉換（CSV 與 Excel 都經過這裡，規則完全相同）。
 * source: 'csv' | 'xlsx'。Excel 會把日期、時間存成序號，僅在 xlsx 來源時換算。
 */
export function tableToDrafts(table, { source = 'csv' } = {}) {
  const errors = [];
  const warnings = [];
  if (!table.length) return { ok: false, rows: [], errors: ['檔案是空的'], warnings, dateRange: null, columns: [] };

  const header = table[0].map((h) => norm(h));
  const colIndex = {};
  const unknown = [];
  header.forEach((h, i) => {
    if (!h) return;
    const def = CSV_COLUMNS.find((c) => c.aliases.some((a) => norm(a) === h));
    if (def && colIndex[def.key] === undefined) colIndex[def.key] = i;
    else if (!def) unknown.push(table[0][i]);
  });
  if (colIndex.title === undefined) {
    return { ok: false, rows: [], errors: ['找不到「名稱」欄。第一列必須是欄位名稱，請使用範本的欄名。'], warnings, dateRange: null, columns: [] };
  }
  if (unknown.length) warnings.push(`以下欄位無法辨識，已忽略：${unknown.join('、')}`);

  const raw = (r, key) => (colIndex[key] === undefined ? '' : String(r[colIndex[key]] ?? '').trim());
  const get = (r, key) => {
    const v = raw(r, key);
    if (source === 'xlsx' && NUMERIC_RE.test(v)) {
      if (key === 'date') return excelSerialToDate(v) || v;
      if (key === 'startTime' || key === 'endTime') return Number(v) < 1 ? (excelFractionToTime(v) || v) : v;
    }
    return v;
  };
  const rows = [];
  let min = null;
  let max = null;
  table.slice(1).forEach((r, idx) => {
    const line = idx + 2; // 試算表上的列號
    const e = (m) => errors.push(`第 ${line} 列：${m}`);
    const title = get(r, 'title');
    if (!title) {
      // 有其他內容卻沒有名稱 → 錯誤；完全空白列已在解析時移除
      e('缺少名稱');
      return;
    }
    const dateRaw = get(r, 'date');
    const date = normalizeDate(dateRaw);
    if (date === undefined) e(`日期「${dateRaw}」格式錯誤，請用 2026-11-12`);
    const st = normalizeTime(get(r, 'startTime'));
    const et = normalizeTime(get(r, 'endTime'));
    if (st === undefined) e(`開始時間「${get(r, 'startTime')}」格式錯誤，請用 09:30`);
    if (et === undefined) e(`結束時間「${get(r, 'endTime')}」格式錯誤，請用 15:30`);
    const coordRaw = get(r, 'coordinates');
    const entRaw = get(r, 'entrance');
    const coordinates = coordRaw ? C.parseCoordsInput(coordRaw) : null;
    const entranceCoordinates = entRaw ? C.parseCoordsInput(entRaw) : null;
    if (coordRaw && !coordinates) e(`座標「${coordRaw}」格式錯誤，請用「緯度, 經度」`);
    if (entRaw && !entranceCoordinates) e(`入口座標「${entRaw}」格式錯誤，請用「緯度, 經度」`);
    const typeRaw = get(r, 'type');
    const type = typeRaw ? matchAlias(typeRaw, TYPE_ALIASES) : 'attraction';
    if (type === undefined) e(`類型「${typeRaw}」無法辨識（可用：景點、住宿、會議、車站、交通、用餐、其他）`);
    const modeRaw = get(r, 'mode');
    const mode = modeRaw ? matchAlias(modeRaw, MODE_ALIASES) : null;
    if (mode === undefined) e(`交通方式「${modeRaw}」無法辨識（可用：步行、大眾運輸、開車、自行車）`);
    const url = get(r, 'url');
    if (url && !C.isSafeHttpsUrl(url)) e('參考網址只接受 https:// 開頭');
    const orderRaw = get(r, 'order');
    const order = orderRaw ? Number(orderRaw) : null;
    if (orderRaw && !Number.isFinite(order)) e(`順序「${orderRaw}」必須是數字`);

    if (date) {
      if (!min || date < min) min = date;
      if (!max || date > max) max = date;
    }
    rows.push({
      line,
      date: date || null,
      order: Number.isFinite(order) ? order : null,
      city: get(r, 'city'),
      title,
      localName: get(r, 'localName') || null,
      type: type || 'attraction',
      startTime: st || null,
      endTime: et || null,
      address: get(r, 'address') || null,
      coordinates: coordinates || null,
      entranceCoordinates: entranceCoordinates || null,
      defaultMode: mode || null,
      destinationConfirmed: TRUE_WORDS.includes(norm(get(r, 'confirmed'))),
      referenceUrl: url || null,
      notes: get(r, 'notes') || null,
    });
  });
  if (!rows.length && !errors.length) errors.push('除了欄位名稱外，沒有任何資料列');
  return { ok: errors.length === 0, rows, errors, warnings, dateRange: min ? { min, max } : null };
}

/**
 * 把草稿加入旅程（回傳新的 stops 陣列，不改動原旅程）。
 * 同日排序：有「順序」者依數值，其餘依檔案順序，接在該日既有停靠點之後。
 */
export function appendDrafts(trip, drafts) {
  const errors = [];
  for (const d of drafts) {
    if (d.date && (d.date < trip.startDate || d.date > trip.endDate)) {
      errors.push(`第 ${d.line} 列：日期 ${d.date} 不在旅程期間（${trip.startDate}～${trip.endDate}）內`);
    }
  }
  if (errors.length) return { ok: false, errors, stops: trip.stops };
  const byDate = new Map();
  drafts.forEach((d, i) => {
    const k = d.date;
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push({ d, i });
  });
  const ts = C.nowIso();
  const added = [];
  for (const [date, list] of byDate) {
    list.sort((a, b) => {
      const ao = a.d.order ?? Infinity;
      const bo = b.d.order ?? Infinity;
      return ao === bo ? a.i - b.i : ao - bo;
    });
    let next = C.nextOrder(trip, date);
    for (const { d } of list) {
      const { line, order, ...rest } = d;
      added.push({
        ...C.createStop(trip, { date }),
        ...rest,
        defaultMode: rest.defaultMode || trip.settings.defaultMode || 'walking',
        order: next,
        updatedAt: ts,
      });
      next += 1;
    }
  }
  return { ok: true, errors: [], stops: [...trip.stops, ...added], addedCount: added.length };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 範本列：取自公開景點的示範內容（不含住宿、會議等私人資訊）。 */
export const TEMPLATE_ROWS = [
  ['2026-11-12', '1', 'Vienna', '卡爾教堂', 'Karlskirche', '景點', '10:00', '', '', '', '', '步行', '', '', '只填名稱＋城市也能導航，但會標示「定位待確認」'],
  ['2026-11-12', '2', 'Vienna', '美景宮', 'Schloss Belvedere', '景點', '13:00', '15:30', '', '', '', '大眾運輸', '', '', '確認入口後，可填入口座標'],
  ['2026-11-13', '1', 'Budapest', '漁人堡', 'Halászbástya', '景點', '', '', '', '', '', '步行', '', '', ''],
  ['2026-11-14', '1', 'Bratislava', '布拉提斯拉瓦城堡', 'Bratislavský hrad', '景點', '', '', '', '', '', '大眾運輸', '', '', '同一天可以有不同城市'],
  ['', '', 'Vienna', '聖史蒂芬大教堂', 'Stephansdom', '景點', '', '', '', '', '', '步行', '', '', '日期留空 = 候選景點'],
];

export function buildCsvTemplate() {
  const lines = [CSV_COLUMNS.map((c) => c.header), ...TEMPLATE_ROWS].map((r) => r.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** 給 ChatGPT／Claude／Gemini 的轉換提示詞。 */
export const AI_PROMPT = `請把我下面提供的旅行行程，轉換成「旅程導航助手」可以匯入的 JSON 檔。

【輸出規則】
1. 只輸出一個 JSON 物件，不要任何說明文字，也不要 Markdown 程式碼框。
2. 不要自行猜測或補上我沒有提供的地址、座標、時間或交通班次；不確定的欄位一律填 null。
3. 地名的 title 用中文（若我給的是中文），localName 填當地語言原名（例如 Karlskirche、Halászbástya）。
4. 日期格式 YYYY-MM-DD，時間格式 HH:mm（24 小時制），皆為旅行當地時間。
5. 還沒決定日期的地點，date 填 null（會成為「候選景點」）。
6. 同一天的停靠點依我給的先後順序，order 從 1 開始編號。
7. 座標格式 {"lat": 緯度, "lng": 經度}；只有在我提供時才填。
8. 不要放入訂位代碼、護照號碼、付款資訊或任何密碼。

【JSON 結構】
{
  "schemaVersion": 1,
  "title": "旅程名稱",
  "timeZone": "旅行地的 IANA 時區，例如 Europe/Vienna、Asia/Tokyo",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "settings": { "defaultMode": "walking" },
  "stops": [
    {
      "date": "YYYY-MM-DD 或 null",
      "order": 1,
      "city": "城市（英文或當地拼法）",
      "title": "名稱",
      "localName": "當地語言原名或 null",
      "type": "attraction | hotel | conference | station | transfer | meal | other 之一",
      "startTime": "HH:mm 或 null",
      "endTime": "HH:mm 或 null",
      "address": "完整地址或 null",
      "coordinates": null,
      "entranceCoordinates": null,
      "destinationConfirmed": false,
      "defaultMode": "walking | transit | driving | cycling 之一",
      "notes": "備註或 null",
      "referenceUrl": "https:// 開頭的網址或 null"
    }
  ]
}

【我的行程】
（請把行程貼在這裡：文字、表格、訂位確認信內容皆可）
`;
