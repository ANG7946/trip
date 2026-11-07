// tools.js — 工具分頁的純邏輯：緊急資訊、國家判斷、幣別、匯率、花費
import { normName } from './photos.js?v=2.0.0';

// ---------- 緊急資訊（資料來源：外交部領事事務局 www.boca.gov.tw；查證日期如下） ----------
export const EMERGENCY_VERIFIED = '2026-11-07';
export const BOCA_URL = 'https://www.boca.gov.tw/';
export const BOCA_MISSIONS_URL = 'https://www.boca.gov.tw/sp-foof-areacp-1.html';

export const MOFA_HOTLINE = {
  name: '外交部緊急聯絡中心（24 小時）',
  overseas: '+886-800-085-095',   // 自海外撥打須付費
  domestic: '0800-085-095',        // 臺灣國內免付費（可請親友代撥）
};

// 「旅外國人急難救助全球免付費專線」800-0885-0885 只適用下列國家或地區（撥號字首不同）
const TOLL_FREE_PREFIX = {
  JP: '001-010', AU: '0011', IL: '014', US: '011', CA: '011',
  KR: '001', HK: '001', SG: '001', TH: '001',
  GB: '00', FR: '00', DE: '00', CH: '00', IT: '00', BE: '00', NL: '00', SE: '00',
  AR: '00', NZ: '00', MY: '00', PH: '00', MO: '00',
};
export function tollFreeDial(cc) {
  const p = TOLL_FREE_PREFIX[cc];
  return p ? `${p}-800-0885-0885` : null;
}

// 駐外館處（只收錄已查證者；其他國家請連到領事事務局查詢）
export const MISSIONS = {
  AT: {
    name: '駐奧地利臺北經濟文化代表處',
    address: 'Wagramer Str. 19/11. OG, A-1220 Vienna, Austria',
    url: 'https://www.taiwanembassy.org/at/',
    emergency: { intl: '+43-664-345-0455', local: '0664-345-0455' },
  },
  HU: {
    name: '駐匈牙利台北代表處',
    address: '1088 Budapest, Rákóczi út 1-3/II, Hungary',
    url: 'https://www.taiwanembassy.org/hu/',
    office: { intl: '+36-1-266-2884', local: '06-1-266-2884' },
    emergency: { intl: '+36-30-964-1546', local: '06-30-964-1546' },
    email: 'hng@mofa.gov.tw',
  },
  SK: {
    name: '駐斯洛伐克台北代表處',
    address: 'Mostova 2, 81102 Bratislava, Slovak Republic',
    url: 'https://www.roc-taiwan.org/sk/',
    office: { intl: '+421-2-5825-3220' },
    emergency: { intl: '+421-915-108-489' },
  },
  JP: {
    name: '台北駐日經濟文化代表處',
    address: '東京都港区白金台5-20-2',
    url: 'https://www.roc-taiwan.org/jp',
    office: { intl: '+81-3-3280-7811', local: '03-3280-7811' },
    emergency: { intl: '+81-80-1009-7179', local: '080-1009-7179' },
  },
};

// 國家基本資料：中文名稱、幣別、當地緊急電話
const EU112 = [{ label: '緊急電話（警察・消防・救護）', number: '112' }];
export const COUNTRIES = {
  AT: { name: '奧地利', currency: 'EUR', local: EU112 },
  HU: { name: '匈牙利', currency: 'HUF', local: EU112 },
  SK: { name: '斯洛伐克', currency: 'EUR', local: EU112 },
  CZ: { name: '捷克', currency: 'CZK', local: EU112 },
  DE: { name: '德國', currency: 'EUR', local: EU112 },
  FR: { name: '法國', currency: 'EUR', local: EU112 },
  IT: { name: '義大利', currency: 'EUR', local: EU112 },
  ES: { name: '西班牙', currency: 'EUR', local: EU112 },
  NL: { name: '荷蘭', currency: 'EUR', local: EU112 },
  BE: { name: '比利時', currency: 'EUR', local: EU112 },
  PL: { name: '波蘭', currency: 'PLN', local: EU112 },
  SI: { name: '斯洛維尼亞', currency: 'EUR', local: EU112 },
  HR: { name: '克羅埃西亞', currency: 'EUR', local: EU112 },
  CH: { name: '瑞士', currency: 'CHF', local: EU112 },
  GB: { name: '英國', currency: 'GBP', local: [{ label: '緊急電話', number: '999' }, { label: '緊急電話（亦可）', number: '112' }] },
  JP: { name: '日本', currency: 'JPY', local: [{ label: '警察', number: '110' }, { label: '消防・救護', number: '119' }] },
  KR: { name: '南韓', currency: 'KRW', local: [{ label: '警察', number: '112' }, { label: '消防・救護', number: '119' }] },
  US: { name: '美國', currency: 'USD', local: [{ label: '緊急電話', number: '911' }] },
  CA: { name: '加拿大', currency: 'CAD', local: [{ label: '緊急電話', number: '911' }] },
  TH: { name: '泰國', currency: 'THB', local: [{ label: '觀光警察', number: '1155' }, { label: '警察', number: '191' }] },
  HK: { name: '香港', currency: 'HKD', local: [{ label: '緊急電話', number: '999' }] },
  SG: { name: '新加坡', currency: 'SGD', local: [{ label: '警察', number: '999' }, { label: '消防・救護', number: '995' }] },
  AU: { name: '澳洲', currency: 'AUD', local: [{ label: '緊急電話', number: '000' }] },
  TW: { name: '臺灣', currency: 'TWD', local: [{ label: '警察', number: '110' }, { label: '消防・救護', number: '119' }] },
};

// 城市 → 國家（含常見中文、英文與當地寫法；比對前以 normName 正規化）
const CITY_COUNTRY_RAW = {
  AT: ['vienna', 'wien', '維也納', 'salzburg', '薩爾斯堡', 'hallstatt', '哈修塔特', '哈爾施塔特', 'innsbruck', '因斯布魯克', 'graz', '格拉茲', 'linz', '林茲', 'melk', '梅爾克', 'durnstein', 'krems'],
  HU: ['budapest', '布達佩斯', 'szentendre', '聖安德烈', 'eger', '艾格爾', 'debrecen', 'gyor', 'pecs', 'visegrad', 'esztergom'],
  SK: ['bratislava', '布拉提斯拉瓦', '布拉迪斯拉發', 'kosice', 'devin'],
  CZ: ['prague', 'praha', '布拉格', 'cesky krumlov', '庫倫洛夫', '克倫洛夫', 'brno', '布爾諾', 'karlovy vary'],
  DE: ['munich', 'munchen', '慕尼黑', 'berlin', '柏林', 'frankfurt', '法蘭克福', 'hamburg', 'cologne', 'koln', 'dresden'],
  FR: ['paris', '巴黎', 'nice', 'lyon'],
  IT: ['rome', 'roma', '羅馬', 'venice', 'venezia', '威尼斯', 'florence', 'firenze', '佛羅倫斯', 'milan', 'milano', '米蘭'],
  GB: ['london', '倫敦', 'edinburgh', '愛丁堡'],
  CH: ['zurich', '蘇黎世', 'geneva', '日內瓦', 'lucerne', 'luzern', '琉森'],
  JP: ['tokyo', '東京', 'kyoto', '京都', 'osaka', '大阪', 'nara', '奈良', 'sapporo', '札幌', 'fukuoka', '福岡', 'okinawa', '沖繩', 'naha', '那霸'],
  KR: ['seoul', '首爾', 'busan', '釜山'],
  TW: ['taipei', '臺北', '台北', 'kaohsiung', '高雄', 'taichung', '臺中', '台中', 'tainan', '臺南', '台南', 'taoyuan', '桃園'],
};
const CITY_COUNTRY = new Map();
for (const [cc, names] of Object.entries(CITY_COUNTRY_RAW)) for (const n of names) CITY_COUNTRY.set(normName(n), cc);

const TZ_COUNTRY = {
  'Europe/Vienna': 'AT', 'Europe/Budapest': 'HU', 'Europe/Bratislava': 'SK', 'Europe/Prague': 'CZ',
  'Europe/Berlin': 'DE', 'Europe/Paris': 'FR', 'Europe/Rome': 'IT', 'Europe/Madrid': 'ES', 'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE', 'Europe/Warsaw': 'PL', 'Europe/Ljubljana': 'SI', 'Europe/Zagreb': 'HR', 'Europe/Zurich': 'CH',
  'Europe/London': 'GB', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Bangkok': 'TH', 'Asia/Hong_Kong': 'HK',
  'Asia/Singapore': 'SG', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Asia/Taipei': 'TW',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA',
};

export function countryForCity(city, geoCC = {}) {
  const key = normName(city);
  if (!key) return null;
  if (CITY_COUNTRY.has(key)) return CITY_COUNTRY.get(key);
  const g = geoCC[key];
  return g ? String(g).toUpperCase() : null;
}

/**
 * 依行程判斷涉及的國家（依城市出現順序）。
 * geoCC：城市（normName 後）→ 國碼，來自天氣地理編碼的快取；extra：使用者手動加入的國家。
 * 家鄉國家（homeCC）不列入。
 */
export function detectCountries(trip, { geoCC = {}, extra = [], homeCC = null } = {}) {
  const out = [];
  const add = (cc) => { if (cc && cc !== homeCC && !out.includes(cc)) out.push(cc); };
  const stops = [...(trip?.stops || [])].sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || (a.order - b.order));
  for (const s of stops) add(countryForCity(s.city, geoCC));
  if (!out.length) add(TZ_COUNTRY[trip?.timeZone]);
  for (const cc of extra) add(cc);
  return out;
}

export function countryName(cc) {
  return COUNTRIES[cc]?.name || cc;
}

/** tel: 連結：只保留 + 與數字 */
export function telHref(number) {
  const n = String(number || '').replace(/[^\d+]/g, '');
  return n ? `tel:${n}` : null;
}

// ---------- 幣別 ----------
const HOME_TZ_CURRENCY = {
  'Asia/Taipei': 'TWD', 'Asia/Tokyo': 'JPY', 'Asia/Hong_Kong': 'HKD', 'Asia/Macau': 'MOP', 'Asia/Shanghai': 'CNY',
  'Asia/Singapore': 'SGD', 'Asia/Seoul': 'KRW', 'Asia/Bangkok': 'THB', 'Asia/Kuala_Lumpur': 'MYR',
  'Australia/Sydney': 'AUD', 'Australia/Melbourne': 'AUD', 'Europe/London': 'GBP',
  'America/New_York': 'USD', 'America/Chicago': 'USD', 'America/Denver': 'USD', 'America/Los_Angeles': 'USD',
  'America/Toronto': 'CAD', 'America/Vancouver': 'CAD',
};
export function homeCurrencyFor(homeTz) {
  if (HOME_TZ_CURRENCY[homeTz]) return HOME_TZ_CURRENCY[homeTz];
  const cc = TZ_COUNTRY[homeTz];
  return (cc && COUNTRIES[cc]?.currency) || 'TWD';
}
export function homeCountryFor(homeTz) {
  return TZ_COUNTRY[homeTz] || null;
}

/** 行程用到的當地幣別（依國家順序，不重複） */
export function tripCurrencies(countries) {
  const out = [];
  for (const cc of countries) {
    const c = COUNTRIES[cc]?.currency;
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export const CURRENCY_NAMES = {
  TWD: '新臺幣', EUR: '歐元', HUF: '匈牙利福林', CZK: '捷克克朗', PLN: '波蘭茲羅提', CHF: '瑞士法郎', GBP: '英鎊',
  USD: '美元', JPY: '日圓', KRW: '韓元', HKD: '港幣', SGD: '新加坡幣', THB: '泰銖', AUD: '澳幣', CAD: '加幣', CNY: '人民幣',
};
// 小數位數（福林、日圓、韓元通常不用小數）
const ZERO_DECIMALS = new Set(['HUF', 'JPY', 'KRW', 'TWD', 'CLP', 'ISK', 'IDR', 'VND']);
export function decimalsFor(cur) { return ZERO_DECIMALS.has(cur) ? 0 : 2; }

export function formatMoney(amount, cur) {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const d = decimalsFor(cur);
  return `${amount.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d })} ${cur}`;
}

// ---------- 匯率（ExchangeRate-API 開放端點：免金鑰、每日更新、需標示來源） ----------
export const FX_ATTRIBUTION_URL = 'https://www.exchangerate-api.com';
export function ratesUrl(base) {
  return `https://open.er-api.com/v6/latest/${encodeURIComponent(String(base).toUpperCase())}`;
}

/** 解析 API 回應 → { base, rates, updatedAt, nextAt }；格式不符回傳 null */
export function parseRates(json) {
  if (!json || json.result !== 'success' || typeof json.base_code !== 'string' || !json.rates || typeof json.rates !== 'object') return null;
  const rates = {};
  for (const [k, v] of Object.entries(json.rates)) if (/^[A-Z]{3}$/.test(k) && Number.isFinite(v) && v > 0) rates[k] = v;
  if (!rates[json.base_code]) rates[json.base_code] = 1;
  return {
    base: json.base_code,
    rates,
    updatedAt: Number.isFinite(json.time_last_update_unix) ? json.time_last_update_unix * 1000 : null,
    nextAt: Number.isFinite(json.time_next_update_unix) ? json.time_next_update_unix * 1000 : null,
  };
}

/** 是否該重新下載：沒有資料、基準不同、已超過下次更新時間（並至少間隔 1 小時，避免被限流） */
export function ratesStale(table, base, now = Date.now(), fetchedAt = 0) {
  if (!table || table.base !== base) return true;
  if (fetchedAt && now - fetchedAt < 3600e3) return false;
  const next = table.nextAt || (table.updatedAt ? table.updatedAt + 24 * 3600e3 : 0);
  return now >= next;
}

/** 以同一張匯率表做交叉換算；無法換算回傳 null */
export function convert(amount, from, to, table) {
  if (!Number.isFinite(amount) || !table) return null;
  if (from === to) return amount;
  const rf = table.rates[from], rt = table.rates[to];
  if (!rf || !rt) return null;
  return amount / rf * rt;
}

/** 1 單位 from 等於多少 to */
export function unitRate(from, to, table) {
  return convert(1, from, to, table);
}

// ---------- 花費紀錄 ----------
export const EXPENSE_CATEGORIES = ['food', 'transport', 'ticket', 'lodging', 'shopping', 'other'];
export const CATEGORY_LABELS = { food: '餐飲', transport: '交通', ticket: '門票', lodging: '住宿', shopping: '購物', other: '其他' };
export const PAY_METHODS = ['cash', 'card'];
export const PAY_LABELS = { cash: '現金', card: '刷卡' };

export function createExpense(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: partial.id || `x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    tripId: partial.tripId || null,
    date: partial.date || null,
    amount: Number(partial.amount) || 0,
    currency: partial.currency || 'EUR',
    category: EXPENSE_CATEGORIES.includes(partial.category) ? partial.category : 'other',
    pay: PAY_METHODS.includes(partial.pay) ? partial.pay : 'cash',
    note: String(partial.note || '').slice(0, 300),
    stopId: partial.stopId || null,
    stopTitle: partial.stopTitle || '',
    receiptId: partial.receiptId || null,
    createdAt: partial.createdAt || now,
    updatedAt: now,
  };
}

/** 驗證單筆花費（匯入備份時使用）。回傳錯誤訊息陣列 */
export function validateExpense(x) {
  const e = [];
  if (!x || typeof x !== 'object') return ['不是物件'];
  if (typeof x.id !== 'string' || !x.id) e.push('缺少 id');
  if (typeof x.tripId !== 'string' || !x.tripId) e.push('缺少 tripId');
  if (!Number.isFinite(x.amount) || x.amount < 0 || x.amount > 1e9) e.push('金額不正確');
  if (typeof x.currency !== 'string' || !/^[A-Z]{3}$/.test(x.currency)) e.push('幣別不正確');
  if (x.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) e.push('日期格式不正確');
  return e;
}

/** 依日期分組並排序（新日期在前；同日依建立時間） */
export function groupByDate(expenses) {
  const map = new Map();
  for (const x of expenses) {
    const k = x.date || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => ({ date, items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }));
}

/** 合計：各幣別原始金額，以及換算為 home 的總額（無法換算者計入 missing） */
export function totals(expenses, home, table) {
  const byCurrency = {};
  let homeTotal = 0, missing = 0;
  for (const x of expenses) {
    byCurrency[x.currency] = (byCurrency[x.currency] || 0) + x.amount;
    const v = convert(x.amount, x.currency, home, table);
    if (v == null) missing += 1; else homeTotal += v;
  }
  return { byCurrency, homeTotal, missing };
}

/** 匯出用的表格列（第一列為標題） */
export function expenseRows(expenses, home, table) {
  const head = ['日期', '類別', '項目／備註', '停靠點', '付款方式', '金額', '幣別', `約合 ${home}`, '收據照片'];
  const rows = [...expenses]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.createdAt.localeCompare(b.createdAt))
    .map((x) => {
      const v = convert(x.amount, x.currency, home, table);
      return [x.date || '', CATEGORY_LABELS[x.category] || x.category, x.note || '', x.stopTitle || '', PAY_LABELS[x.pay] || '',
        x.amount, x.currency, v == null ? '' : Math.round(v * 100) / 100, x.receiptId ? '有' : ''];
    });
  return [head, ...rows];
}
