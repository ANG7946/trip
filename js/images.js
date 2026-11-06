// images.js — 使用者自己的照片：縮圖、編碼、批次指派
import { normName } from './photos.js?v=1.5.0';

export const MAX_SIDE = 640;     // 長邊像素
export const JPEG_QUALITY = 0.78;

// ---------- 縮圖（瀏覽器） ----------
async function decode(file) {
  // 優先使用 createImageBitmap（依 EXIF 方向轉正）；不支援時改用 <img>
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* 改用備援 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error || new Error('讀取失敗'));
    r.readAsDataURL(blob);
  });
}

/** 把相片縮成長邊 640px 的 JPEG，回傳 { mime, data(base64), width, height, bytes } */
export async function resizeToJpeg(file, { maxSide = MAX_SIDE, quality = JPEG_QUALITY } = {}) {
  const src = await decode(file);
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new Error('無法讀取這張照片');
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('壓縮失敗'))), 'image/jpeg', quality));
  return { mime: 'image/jpeg', data: await blobToBase64(blob), width: w, height: h, bytes: blob.size };
}

export function dataUrl(image) {
  return image ? `data:${image.mime};base64,${image.data}` : '';
}

export function imageBytes(image) {
  return image && image.data ? Math.floor((image.data.length * 3) / 4) : 0;
}

// ---------- 批次指派（純邏輯，可測試） ----------
function baseName(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '');
}

/**
 * 從檔名解析「日期＋順序」，接受：11-12_2、1112-2、2026-11-12_2、11.12 2、D1-2（第 1 天第 2 站）
 * 回傳 { month, day, n } 或 { dayIndex, n } 或 null
 */
export function parseDateOrder(fileName) {
  const b = baseName(fileName);
  let m = b.match(/(?:^|[^\d])(?:\d{4}[-_.])?(\d{1,2})[-_.](\d{1,2})[-_. ]+(\d{1,2})(?:[^\d]|$)/);
  if (m) return { month: Number(m[1]), day: Number(m[2]), n: Number(m[3]) };
  m = b.match(/(?:^|[^\d])(\d{2})(\d{2})[-_ ](\d{1,2})(?:[^\d]|$)/);
  if (m) return { month: Number(m[1]), day: Number(m[2]), n: Number(m[3]) };
  m = b.match(/(?:^|[^a-z])d(?:ay)?[-_ ]?(\d{1,2})[-_ ](\d{1,2})(?:[^\d]|$)/i);
  if (m) return { dayIndex: Number(m[1]), n: Number(m[2]) };
  return null;
}

/**
 * 為多張照片猜測對應的停靠點。
 * targets：依畫面順序排列的停靠點 [{ id, date, title, localName, position }]（position 為當日第幾站，1 起算）
 * dates：旅程所有日期（用於 D1、D2…）
 * 規則：1) 檔名含日期＋順序　2) 檔名含地點名稱（唯一吻合）　3) 其餘依選取順序配給尚未配對的停靠點
 * 回傳與 files 等長的陣列 [{ stopId|null, source: 'filename'|'order'|null }]
 */
export function guessAssignments(files, targets, { dates = [], useOrder = true } = {}) {
  const result = files.map(() => ({ stopId: null, source: null }));
  const taken = new Set();
  const names = targets.map((t) => ({ id: t.id, keys: [t.localName, t.title].filter(Boolean).map(normName).filter((k) => k.length >= 2) }));

  files.forEach((f, i) => {
    const dob = parseDateOrder(f.name);
    if (dob) {
      let date = null;
      if (dob.dayIndex) date = dates[dob.dayIndex - 1] || null;
      else date = targets.map((t) => t.date).find((d) => d && Number(d.slice(5, 7)) === dob.month && Number(d.slice(8, 10)) === dob.day) || null;
      const hit = date && targets.find((t) => t.date === date && t.position === dob.n && !taken.has(t.id));
      if (hit) { result[i] = { stopId: hit.id, source: 'filename' }; taken.add(hit.id); return; }
    }
    const fn = normName(baseName(f.name));
    if (fn) {
      const hits = names.filter((n) => !taken.has(n.id) && n.keys.some((k) => fn === k || fn.includes(k) || (fn.length >= 4 && k.includes(fn))));
      if (hits.length === 1) { result[i] = { stopId: hits[0].id, source: 'filename' }; taken.add(hits[0].id); }
    }
  });

  if (useOrder) {
    const free = targets.filter((t) => !taken.has(t.id));
    let k = 0;
    result.forEach((r, i) => {
      if (r.stopId || k >= free.length) return;
      result[i] = { stopId: free[k].id, source: 'order' };
      taken.add(free[k].id);
      k += 1;
    });
  }
  return result;
}
