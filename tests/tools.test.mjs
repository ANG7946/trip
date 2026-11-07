import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/core.js';
import * as T from '../js/tools.js';
import * as X from '../js/xlsx.js';

function trip() {
  const t = C.createTrip({ title: 't', timeZone: 'Europe/Vienna', startDate: '2026-11-12', endDate: '2026-11-15' });
  const add = (p) => t.stops.push(C.createStop(t, p));
  add({ date: '2026-11-12', title: '飯店A', type: 'hotel', city: 'Vienna', address: 'A st 1', order: 3 });
  add({ date: '2026-11-12', title: '景點', type: 'attraction', city: '維也納', address: 'x', order: 1 });
  add({ date: '2026-11-13', title: '景點2', type: 'attraction', city: 'Bratislava', address: 'y', order: 1 });
  add({ date: '2026-11-14', title: '飯店A退房', type: 'hotel', city: 'Vienna', address: 'A st 1', order: 1 });
  add({ date: '2026-11-14', title: '飯店B', type: 'hotel', city: 'Budapest', address: 'B st 2', order: 5 });
  return t;
}

test('回飯店：當天住宿、退房前仍是原飯店、無住宿日用前一晚', () => {
  const t = trip();
  assert.equal(C.lodgingFor(t, '2026-11-12').title, '飯店A');
  assert.equal(C.lodgingFor(t, '2026-11-13').title, '飯店A');
  assert.equal(C.lodgingFor(t, '2026-11-14').title, '飯店A退房');
  t.stops.find((s) => s.title === '飯店A退房').status = 'completed';
  assert.equal(C.lodgingFor(t, '2026-11-14').title, '飯店B');
  assert.equal(C.lodgingFor(t, '2026-11-15').title, '飯店B');
  assert.equal(C.lodgingFor(t, '2026-11-11'), null);
  t.stops = t.stops.filter((s) => s.type !== 'hotel');
  assert.equal(C.lodgingFor(t, '2026-11-13'), null);
});

test('國家判斷：依城市（中英文）順序，家鄉排除，無城市時用時區', () => {
  const t = trip();
  assert.deepEqual(T.detectCountries(t), ['AT', 'SK', 'HU']);
  assert.deepEqual(T.detectCountries({ timeZone: 'Asia/Tokyo', stops: [] }), ['JP']);
  assert.deepEqual(T.detectCountries({ timeZone: 'Europe/Vienna', stops: [{ city: 'Ljubljana', date: '2026-01-01', order: 1 }] }, { geoCC: { ljubljana: 'si' } }), ['SI']);
  assert.deepEqual(T.detectCountries({ stops: [{ city: '台北', date: 'x', order: 1 }, { city: 'Tokyo', date: 'y', order: 1 }] }, { homeCC: 'TW' }), ['JP']);
  assert.deepEqual(T.detectCountries(t, { extra: ['CZ', 'AT'] }), ['AT', 'SK', 'HU', 'CZ']);
});

test('緊急資訊：三國代表處皆有急難電話；免付費專線不適用奧匈斯', () => {
  for (const cc of ['AT', 'HU', 'SK']) {
    assert.ok(T.MISSIONS[cc].emergency.intl.startsWith('+'));
    assert.equal(T.COUNTRIES[cc].local[0].number, '112');
    assert.equal(T.tollFreeDial(cc), null);
  }
  assert.equal(T.tollFreeDial('DE'), '00-800-0885-0885');
  assert.equal(T.telHref('+43-664-345-0455'), 'tel:+436643450455');
});

test('幣別：奧斯用歐元、匈牙利用福林；家鄉幣別依時區', () => {
  assert.deepEqual(T.tripCurrencies(['AT', 'SK', 'HU']), ['EUR', 'HUF']);
  assert.equal(T.homeCurrencyFor('Asia/Taipei'), 'TWD');
  assert.equal(T.homeCurrencyFor('America/Los_Angeles'), 'USD');
  assert.equal(T.homeCurrencyFor('Europe/Paris'), 'EUR');
  assert.equal(T.homeCurrencyFor('Nowhere/X'), 'TWD');
});

test('匯率：解析 API 回應、交叉換算、更新時機', () => {
  const json = { result: 'success', base_code: 'TWD', time_last_update_unix: 1794009751, time_next_update_unix: 1794096541,
    rates: { TWD: 1, EUR: 0.027329, HUF: 9.927, bad: 3, NEG: -1 } };
  const t = T.parseRates(json);
  assert.equal(t.base, 'TWD');
  assert.equal(t.rates.bad, undefined);
  assert.equal(t.rates.NEG, undefined);
  assert.ok(Math.abs(T.convert(10, 'EUR', 'TWD', t) - 365.9) < 0.1);
  assert.ok(Math.abs(T.convert(1, 'EUR', 'HUF', t) - 363.2) < 0.5);
  assert.equal(T.convert(1, 'USD', 'TWD', t), null);
  assert.equal(T.parseRates({ result: 'error' }), null);
  assert.equal(T.ratesStale(t, 'TWD', t.updatedAt + 3600e3), false);
  assert.equal(T.ratesStale(t, 'TWD', t.nextAt + 1), true);
  assert.equal(T.ratesStale(t, 'TWD', t.nextAt + 1, t.nextAt - 60e3), false); // 剛下載過一小時內不重抓
  assert.equal(T.ratesStale(t, 'USD', 0), true);
  assert.equal(T.formatMoney(1234.5, 'HUF'), '1,235 HUF');
  assert.equal(T.formatMoney(3.5, 'EUR'), '3.50 EUR');
});

test('花費：分組、合計、驗證、匯出列', () => {
  const t = T.parseRates({ result: 'success', base_code: 'TWD', rates: { TWD: 1, EUR: 0.025, HUF: 10 } });
  const a = T.createExpense({ tripId: 't', date: '2026-11-12', amount: 10, currency: 'EUR', category: 'food', note: '午餐' });
  const b = T.createExpense({ tripId: 't', date: '2026-11-13', amount: 2000, currency: 'HUF', category: 'nope' });
  const c = T.createExpense({ tripId: 't', date: '2026-11-13', amount: 5, currency: 'XYZ' });
  assert.equal(b.category, 'other');
  const g = T.groupByDate([a, b, c]);
  assert.equal(g[0].date, '2026-11-13');
  assert.equal(g[0].items.length, 2);
  const s = T.totals([a, b, c], 'TWD', t);
  assert.equal(Math.round(s.homeTotal), 600);
  assert.equal(s.missing, 1);
  assert.equal(s.byCurrency.EUR, 10);
  assert.deepEqual(T.validateExpense(a), []);
  assert.ok(T.validateExpense({ ...a, amount: -1 }).length);
  const rows = T.expenseRows([b, a], 'TWD', t);
  assert.equal(rows[0][7], '約合 TWD');
  assert.equal(rows[1][2], '午餐');
  assert.equal(rows[1][7], 400);
});

test('寫出 xlsx 可再讀回（含中文與數字）', async () => {
  const bytes = X.writeXlsx([{ name: '花費', rows: [['日期', '金額'], ['2026-11-12', 12.5], ['<&>"', 3]] }]);
  assert.ok(X.isXlsxBytes(bytes));
  const r = await X.readXlsx(bytes.buffer, { preferSheet: '花費' });
  const table = r.table || r;
  assert.equal(table[0][0], '日期');
  assert.equal(String(table[1][1]), '12.5');
  assert.equal(table[2][0], '<&>"');
});

test('備份：含花費與聯絡人、收據照片保留；壞資料略過；範本不含', () => {
  const t = C.createTrip({ title: 't', timeZone: 'Europe/Vienna', startDate: '2026-11-12', endDate: '2026-11-13' });
  const x = T.createExpense({ tripId: t.tripId, date: '2026-11-12', amount: 5, currency: 'EUR', receiptId: 'r1' });
  const imgs = [{ id: 'r1', mime: 'image/jpeg', data: 'AAAA' }, { id: 'orphan', mime: 'image/jpeg', data: 'AAAA' }];
  const contacts = { people: [{ id: 'p', name: '甲', relation: '家人', phone: '+886912' }], insurance: null };
  const b = C.buildBackup([t], undefined, imgs, { expenses: [x, { bad: 1 }], contacts });
  assert.deepEqual(b.images.map((i) => i.id), ['r1']);
  const r = C.parseImport(JSON.stringify(b));
  assert.equal(r.ok, true);
  assert.equal(r.extras.expenses.length, 1);
  assert.equal(r.extras.skipped, 1);
  assert.equal(r.extras.contacts.people[0].name, '甲');
  const old = C.parseImport(JSON.stringify(C.buildBackup([t])));
  assert.equal(old.extras.expenses, null); // 舊備份：不覆蓋手機中的花費
  assert.ok(!JSON.stringify(C.buildTemplate(t)).includes('expenses'));
});
