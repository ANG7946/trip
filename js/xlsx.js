// xlsx.js — 讀取 Excel（.xlsx）工作表，轉成與 CSV 相同的二維表格
// 不依賴外部套件：以 DecompressionStream 解壓縮 ZIP，以正規表示式解析 XML（可在 Node 測試）

const TEXT_DECODER = new TextDecoder('utf-8');

export function isXlsxBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; // "PK\x03\x04"
}

// ---------- ZIP ----------
async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 讀出 ZIP 內所有檔案的名稱與（延遲）內容讀取函式。 */
function listZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 從檔尾往前找 End of Central Directory（0x06054b50）
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Excel 檔（找不到 ZIP 目錄）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Excel 檔的 ZIP 目錄損壞');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = TEXT_DECODER.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const lh = e.localOffset;
    if (dv.getUint32(lh, true) !== 0x04034b50) throw new Error('Excel 檔內容損壞');
    const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
    const data = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) return TEXT_DECODER.decode(data);
    if (e.method === 8) return TEXT_DECODER.decode(await inflateRaw(data));
    throw new Error(`不支援的壓縮方式（${e.method}）`);
  }
  return { entries, read };
}

// ---------- XML 小工具 ----------
// 標籤可能帶命名空間前綴（例如 Open XML SDK 產生的 <x:row>、<x:c>），一律接受
const P = '(?:[A-Za-z_][\\w.-]*:)?';

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

/** 取出一段 XML 內所有 <t> 文字並串接（處理 rich text 的多個 <r>） */
function allText(xml) {
  let out = '';
  const re = new RegExp(`<${P}t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${P}t>|<${P}t(?:\\s[^>]*)?\\/>`, 'g');
  let m;
  while ((m = re.exec(xml))) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || ['A'])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------- 工作簿 ----------
/** 讀取工作表清單 [{ name, path }] */
async function listSheets(zip) {
  const wb = await zip.read('xl/workbook.xml');
  const rels = await zip.read('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('不是有效的 Excel 檔（缺少 workbook）');
  const relMap = new Map();
  for (const m of rels.matchAll(new RegExp(`<${P}Relationship\\b[^>]*>`, 'g'))) {
    relMap.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  }
  const sheets = [];
  for (const m of wb.matchAll(new RegExp(`<${P}sheet\\b[^>]*>`, 'g'))) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'r:id');
    let target = relMap.get(rid) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    sheets.push({ name, path: target });
  }
  return sheets;
}

async function sharedStrings(zip) {
  const xml = await zip.read('xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.matchAll(new RegExp(`<${P}si(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${P}si>`, 'g'))].map((m) => allText(m[1]));
}

/**
 * 讀取 .xlsx，回傳 { sheetName, sheetNames, table }。
 * table 為二維字串陣列；數值以原始字串保留（日期／時間序號由呼叫端依欄位轉換）。
 * 優先選擇名稱為「行程」的工作表，否則取第一個。
 */
export async function readXlsx(buffer, { preferSheet = '行程' } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!isXlsxBytes(bytes)) throw new Error('不是 Excel（.xlsx）檔案');
  const zip = listZip(bytes);
  const sheets = await listSheets(zip);
  if (!sheets.length) throw new Error('Excel 檔中沒有工作表');
  const sheet = sheets.find((s) => s.name === preferSheet) || sheets[0];
  const xml = await zip.read(sheet.path);
  if (!xml) throw new Error(`讀不到工作表「${sheet.name}」`);
  const ss = await sharedStrings(zip);

  const table = [];
  const rowRe = new RegExp(`<${P}row\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${P}row>)`, 'g');
  const cellRe = new RegExp(`<${P}c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${P}c>)`, 'g');
  const valueRe = new RegExp(`<${P}v(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${P}v>`);
  for (const rm of xml.matchAll(rowRe)) {
    const rowAttrs = rm[1] || '';
    const rIdx = Number(attr(`<row${rowAttrs}>`, 'r')) - 1;
    const row = [];
    const body = rm[2] || '';
    let autoCol = 0;
    for (const cm of body.matchAll(cellRe)) {
      const tag = `<c${cm[1]}>`;
      const ref = attr(tag, 'r');
      const ci = ref ? colIndex(ref) : autoCol;
      autoCol = ci + 1;
      const t = attr(tag, 't');
      const inner = cm[2] || '';
      const v = (inner.match(valueRe) || [])[1];
      let val = '';
      if (t === 's') val = ss[Number(v)] ?? '';
      else if (t === 'inlineStr') val = allText(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = decodeXml(v);
      row[ci] = val;
    }
    for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = '';
    table[Number.isFinite(rIdx) && rIdx >= 0 ? rIdx : table.length] = row;
  }
  const clean = [];
  for (let i = 0; i < table.length; i += 1) clean.push(table[i] || []);
  return {
    sheetName: sheet.name,
    sheetNames: sheets.map((s) => s.name),
    table: clean.filter((r) => r.some((c) => String(c).trim() !== '')),
  };
}

// ---------- Excel 數值轉換 ----------
/** Excel 日期序號（1900 系統）→ YYYY-MM-DD */
export function excelSerialToDate(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 1 || num > 2958465) return null;
  const ms = Math.round((Math.floor(num) - 25569) * 86400 * 1000); // 25569 = 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}

/** Excel 時間（一天的比例，例如 0.4166…）→ HH:mm */
export function excelFractionToTime(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return null;
  const frac = num - Math.floor(num);
  let mins = Math.round(frac * 24 * 60);
  if (mins >= 24 * 60) mins = 0;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// ---------- 寫出 .xlsx（不壓縮的 ZIP；文字以 inline string 儲存） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); cen.set(name, 46);
    parts.push(local, data); central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
function xmlEsc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
function colName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
function sheetXml(rows) {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    const ref = `${colName(c)}${r + 1}`;
    const style = r === 0 ? ' s="1"' : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
    if (v == null || v === '') return '';
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** sheets: [{ name, rows: [[...]] }] → Uint8Array（.xlsx） */
export function writeXlsx(sheets) {
  const safe = sheets.map((s, i) => ({ ...s, name: String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) }));
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safe.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safe.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${safe.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>' },
    ...safe.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ];
  return zipStore(files);
}
