import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/core.js';
import * as V from '../js/csv.js';

function trip() {
  return C.createTrip({ title: 't', timeZone: 'Europe/Vienna', startDate: '2026-11-12', endDate: '2026-11-19' });
}

test('範本可被自己的解析器讀回且全部通過', () => {
  const r = V.csvToDrafts(V.buildCsvTemplate());
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.rows.length, V.TEMPLATE_ROWS.length);
  assert.deepEqual(r.dateRange, { min: '2026-11-12', max: '2026-11-14' });
  const b = r.rows.find((x) => x.localName === 'Schloss Belvedere');
  assert.equal(b.defaultMode, 'transit');
  assert.equal(b.endTime, '15:30');
  assert.equal(r.rows.at(-1).date, null, '日期留空 = 候選');
});

test('範本只含公開景點（無住宿、會議類型）', () => {
  const r = V.csvToDrafts(V.buildCsvTemplate());
  assert.ok(r.rows.every((x) => x.type === 'attraction'));
});

test('引號、逗號、換行、分號分隔與 BOM', () => {
  const csv = '﻿名稱;地址;備註\r\n"A; B";"Ringstraße 1, Wien";"第一行\n第二行 ""引號"""\r\n';
  const rows = V.parseCsvText(csv);
  assert.deepEqual(rows[1], ['A; B', 'Ringstraße 1, Wien', '第一行\n第二行 "引號"']);
});

test('英文欄名、Excel 日期與時間格式', () => {
  const csv = 'Date,Title,City,Start,Mode,Type,Coordinates\n2026/11/5,X,Wien,9:00,walk,Museum,"48.2, 16.37"\n';
  const r = V.csvToDrafts(csv);
  assert.equal(r.errors.length, 1, '「Museum」不是可辨識的類型');
  const ok = V.csvToDrafts(csv.replace('Museum', '景點'));
  assert.equal(ok.ok, true, ok.errors.join());
  assert.equal(ok.rows[0].date, '2026-11-05');
  assert.equal(ok.rows[0].startTime, '09:00');
  assert.equal(ok.rows[0].defaultMode, 'walking');
  assert.deepEqual(ok.rows[0].coordinates, { lat: 48.2, lng: 16.37 });
});

test('錯誤列會回報列號，且不產生資料', () => {
  const csv = '日期,名稱,開始時間,座標,參考網址\n2026-13-01,A,,,\n2026-11-12,,10:00,,\n2026-11-12,B,25:00,999,javascript:x\n';
  const r = V.csvToDrafts(csv);
  assert.equal(r.ok, false);
  const all = r.errors.join('\n');
  assert.match(all, /第 2 列：日期/);
  assert.match(all, /第 3 列：缺少名稱/);
  assert.match(all, /第 4 列：開始時間/);
  assert.match(all, /第 4 列：座標/);
  assert.match(all, /第 4 列：參考網址/);
});

test('缺少名稱欄時拒絕', () => {
  assert.equal(V.csvToDrafts('日期,地址\n2026-11-12,x\n').ok, false);
});

test('Big5 編碼的 CSV 可正確解碼', () => {
  // 「名稱\n卡爾教堂」的 Big5 位元組
  const big5 = new Uint8Array([0xa6, 0x57, 0xba, 0xd9, 0x0a, 0xa5, 0x64, 0xba, 0xb8, 0xb1, 0xd0, 0xb0, 0xf3]);
  const { text, encoding } = V.decodeCsvBytes(big5);
  assert.equal(encoding, 'Big5');
  assert.equal(text, '名稱\n卡爾教堂');
  const utf8 = new TextEncoder().encode('﻿名稱\nHalászbástya');
  assert.equal(V.decodeCsvBytes(utf8).text, '名稱\nHalászbástya');
});

test('加入旅程：依「順序」與檔案順序排列，接在既有停靠點之後', () => {
  const t = trip();
  t.stops.push(C.createStop(t, { date: '2026-11-12', title: '既有' }));
  const r = V.csvToDrafts('日期,順序,名稱\n2026-11-12,2,B\n2026-11-12,1,A\n2026-11-12,,C\n,,候選\n');
  const out = V.appendDrafts(t, r.rows);
  assert.equal(out.ok, true);
  t.stops = out.stops;
  assert.deepEqual(C.stopsForDate(t, '2026-11-12').map((s) => s.title), ['既有', 'A', 'B', 'C']);
  assert.equal(C.candidates(t)[0].title, '候選');
  const v = C.validateTrip(t);
  assert.deepEqual(v, []);
});

test('加入旅程：日期超出範圍時拒絕', () => {
  const r = V.csvToDrafts('日期,名稱\n2026-12-01,A\n');
  const out = V.appendDrafts(trip(), r.rows);
  assert.equal(out.ok, false);
  assert.match(out.errors[0], /不在旅程期間/);
});

test('AI 產生的精簡 JSON（缺 id／狀態等系統欄位）可匯入，但不補旅遊資料', () => {
  const ai = {
    schemaVersion: 1, title: '東京', timeZone: 'Asia/Tokyo', startDate: '2027-03-01', endDate: '2027-03-03',
    stops: [
      { date: '2027-03-01', title: '淺草寺', localName: '浅草寺', city: 'Tokyo', address: null, coordinates: null },
      { date: '2027-03-01', title: '晴空塔', city: 'Tokyo', startTime: '' },
      { date: null, title: '築地場外市場', city: 'Tokyo' },
    ],
  };
  const r = C.parseImport(JSON.stringify(ai));
  assert.equal(r.ok, true, r.errors.join('\n'));
  const s = r.trips[0].stops;
  assert.deepEqual(s.map((x) => x.order), [1, 2, 1]);
  assert.ok(s.every((x) => x.status === 'pending' && x.destinationConfirmed === false));
  assert.equal(s[0].address, null);
  assert.equal(s[0].coordinates, null);
  // 已存在但錯誤的值仍被拒絕
  ai.stops[0].type = '寺廟';
  assert.equal(C.parseImport(JSON.stringify(ai)).ok, false);
});

test('AI 提示詞包含不得捏造的規則', () => {
  assert.match(V.AI_PROMPT, /不要自行猜測/);
  assert.match(V.AI_PROMPT, /"stops"/);
});
