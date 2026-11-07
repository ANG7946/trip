// db.js — IndexedDB 資料存取層（所有讀寫都經由此處）
import { migrateTrip } from './core.js?v=1.8.1';

const DB_NAME = 'travel-companion';
const DB_VERSION = 2; // IndexedDB 結構版本；資料內容版本見 core.SCHEMA_VERSION
const TRIPS = 'trips';
const META = 'meta';
const IMAGES = 'images'; // v2：使用者自己的照片（已縮圖，base64）

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('此瀏覽器不支援 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // 版本升級時只新增，不刪除既有的 store
      if (ev.oldVersion < 1) {
        db.createObjectStore(TRIPS, { keyPath: 'tripId' });
        db.createObjectStore(META, { keyPath: 'key' });
      }
      if (ev.oldVersion < 2 && !db.objectStoreNames.contains(IMAGES)) {
        db.createObjectStore(IMAGES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('無法開啟資料庫'));
    req.onblocked = () => reject(new Error('資料庫被其他分頁占用，請關閉其他分頁後重試'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('資料庫寫入失敗'));
    tx.onabort = () => reject(tx.error || new Error('資料庫交易已中止'));
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllTrips() {
  const db = await openDb();
  const tx = db.transaction(TRIPS, 'readonly');
  const all = await reqP(tx.objectStore(TRIPS).getAll());
  return all.map(migrateTrip);
}

/** 寫入單一旅程；交易完成（已落盤）後才 resolve。 */
export async function putTrip(trip) {
  const db = await openDb();
  const tx = db.transaction(TRIPS, 'readwrite');
  tx.objectStore(TRIPS).put(trip);
  await txDone(tx);
}

export async function deleteTrip(tripId) {
  const db = await openDb();
  const tx = db.transaction([TRIPS, META], 'readwrite');
  tx.objectStore(TRIPS).delete(tripId);
  await txDone(tx);
}

/**
 * 整份取代：在同一個交易內清空並寫入；任何一步失敗都會整體回滾。
 * images 為 null 時保留手機中既有的照片（備份不含照片時）。
 */
export async function replaceAllTrips(trips, images = null) {
  const db = await openDb();
  const stores = images ? [TRIPS, IMAGES] : [TRIPS];
  const tx = db.transaction(stores, 'readwrite');
  const store = tx.objectStore(TRIPS);
  store.clear();
  for (const t of trips) store.put(t);
  if (images) {
    const is = tx.objectStore(IMAGES);
    is.clear();
    for (const im of images) is.put(im);
  }
  await txDone(tx);
}

// ---------- 使用者照片 ----------
export async function getAllImages() {
  const db = await openDb();
  const tx = db.transaction(IMAGES, 'readonly');
  return reqP(tx.objectStore(IMAGES).getAll());
}

/** 一次寫入多張照片（同一交易） */
export async function putImages(images) {
  const db = await openDb();
  const tx = db.transaction(IMAGES, 'readwrite');
  const st = tx.objectStore(IMAGES);
  for (const im of images) st.put(im);
  await txDone(tx);
}

export async function deleteImages(ids) {
  if (!ids.length) return;
  const db = await openDb();
  const tx = db.transaction(IMAGES, 'readwrite');
  const st = tx.objectStore(IMAGES);
  for (const id of ids) st.delete(id);
  await txDone(tx);
}

export async function getMeta(key, fallback = null) {
  const db = await openDb();
  const tx = db.transaction(META, 'readonly');
  const row = await reqP(tx.objectStore(META).get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  tx.objectStore(META).put({ key, value });
  await txDone(tx);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* 忽略 */ }
  return false;
}
