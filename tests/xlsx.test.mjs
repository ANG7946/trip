import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as X from '../js/xlsx.js';
import * as V from '../js/csv.js';

const load = (p) => new Uint8Array(readFileSync(new URL(p, import.meta.url)));

test('辨識 xlsx 檔頭', () => {
  assert.equal(X.isXlsxBytes(load('../data/trip-template.xlsx')), true);
  assert.equal(X.isXlsxBytes(new TextEncoder().encode('日期,名稱')), false);
});

test('Excel 範本與 CSV 範本內容完全一致', async () => {
  const { table, sheetName, sheetNames } = await X.readXlsx(load('../data/trip-template.xlsx'));
  assert.equal(sheetName, '行程');
  assert.deepEqual(sheetNames, ['行程', '填寫說明']);
  const fromXlsx = V.tableToDrafts(table, { source: 'xlsx' });
  const fromCsv = V.csvToDrafts(readFileSync(new URL('../data/trip-template.csv', import.meta.url), 'utf8'));
  assert.equal(fromXlsx.ok, true, fromXlsx.errors.join('\n'));
  const strip = (r) => r.rows.map(({ line, ...x }) => x);
  assert.deepEqual(strip(fromXlsx), strip(fromCsv));
});

test('LibreOffice 另存的 xlsx 也能讀', async () => {
  const { table } = await X.readXlsx(load('./fixtures/libreoffice-saved.xlsx'));
  const r = V.tableToDrafts(table, { source: 'xlsx' });
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.rows.length, 5);
  assert.equal(r.rows[1].localName, 'Schloss Belvedere');
  assert.equal(r.rows[1].endTime, '15:30');
});

test('Excel 自動轉換的日期／時間／布林、特殊字元、換行、跳列', async () => {
  const { table, sheetName } = await X.readXlsx(load('./fixtures/excel-auto-converted.xlsx'));
  assert.equal(sheetName, '行程', '優先讀「行程」分頁，即使不是第一個');
  const r = V.tableToDrafts(table, { source: 'xlsx' });
  assert.equal(r.ok, true, r.errors.join('\n'));
  const [a, b, c, d] = r.rows;
  assert.equal(a.date, '2026-11-12');
  assert.equal(a.startTime, '09:30');
  assert.equal(a.endTime, '15:00');
  assert.equal(a.destinationConfirmed, true);
  assert.equal(a.title, 'A & B <測試>');
  assert.equal(a.notes, '第一行\n第二行');
  assert.deepEqual(a.coordinates, { lat: 48.2, lng: 16.37 });
  assert.equal(b.date, '2026-11-13');
  assert.equal(b.title, 'Halászbástya');
  assert.equal(b.destinationConfirmed, true);
  assert.equal(c.date, null);
  assert.equal(d.date, '2026-11-14');
  assert.equal(d.title, '第十列');
});

test('序號換算', () => {
  assert.equal(X.excelSerialToDate(46338), '2026-11-12');
  assert.equal(X.excelFractionToTime(0.395833333), '09:30');
  assert.equal(X.excelFractionToTime(0.999999), '00:00');
  assert.equal(X.excelSerialToDate('abc'), null);
});

test('壞檔回報錯誤', async () => {
  await assert.rejects(() => X.readXlsx(new TextEncoder().encode('not a zip')), /不是 Excel/);
  const broken = load('../data/trip-template.xlsx').slice(0, 2000);
  await assert.rejects(() => X.readXlsx(broken));
});

test('命名空間前綴（Open XML SDK／部分 AI 工具產生的 <x:row>、<x:c>）、絕對路徑、行內字串', async () => {
  const { table, sheetName } = await X.readXlsx(load('./fixtures/prefixed-openxml-sdk.xlsx'));
  assert.equal(sheetName, '行程');
  const r = V.tableToDrafts(table, { source: 'xlsx' });
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].startTime, '10:00');
  assert.equal(r.rows[0].address, 'Karlsplatz, 1040 Wien');
  assert.equal(r.rows[1].title, '漁人堡 & 城堡');
  assert.equal(r.rows[1].date, null);
});
