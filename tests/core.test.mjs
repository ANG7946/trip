// 執行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/core.js';

function demoTrip() {
  const t = C.createTrip({ title: '測試', timeZone: 'Europe/Vienna', startDate: '2026-11-12', endDate: '2026-11-19' });
  return t;
}

test('Apple 統一網址：空格、德文、匈牙利語字元正確編碼', () => {
  const t = demoTrip();
  const s = C.createStop(t, { date: '2026-11-12', title: '測試', address: 'Mariahilfer Straße 1, 1060 Wien' });
  const url = C.buildDirectionsUrl(s, 'walking');
  assert.ok(url.startsWith('https://maps.apple.com/directions?'));
  const u = new URL(url);
  assert.equal(u.searchParams.get('destination'), 'Mariahilfer Straße 1, 1060 Wien');
  assert.equal(u.searchParams.get('mode'), 'walking');
  assert.ok(!url.includes(' '), '網址不可含原始空格');

  const h = C.createStop(t, { date: '2026-11-16', title: '漁人堡', localName: 'Halászbástya', city: 'Budapest' });
  const u2 = new URL(C.buildDirectionsUrl(h, 'transit'));
  assert.equal(u2.searchParams.get('destination'), 'Halászbástya, Budapest');
  assert.equal(u2.searchParams.get('mode'), 'transit');
  const h2 = C.createStop(t, { date: '2026-11-16', title: 'x', address: 'Szentháromság tér, Budapest 1014 – Őrház' });
  assert.equal(new URL(C.buildDirectionsUrl(h2, 'walking')).searchParams.get('destination'), 'Szentháromság tér, Budapest 1014 – Őrház');
});

test('座標順序為 緯度,經度，且入口座標優先', () => {
  const t = demoTrip();
  const s = C.createStop(t, {
    date: '2026-11-12', title: 'A', address: 'X',
    coordinates: { lat: 48.1, lng: 16.3 }, entranceCoordinates: { lat: 48.2, lng: 16.4 },
  });
  assert.equal(new URL(C.buildDirectionsUrl(s, 'walking')).searchParams.get('destination'), '48.2,16.4');
  const s2 = { ...s, entranceCoordinates: null };
  assert.equal(new URL(C.buildDirectionsUrl(s2, 'walking')).searchParams.get('destination'), '48.1,16.3');
  assert.equal(C.resolveDestination(s2).level, 'coords');
});

test('沒有目的地時不產生連結；只有名稱沒有城市也不產生', () => {
  const t = demoTrip();
  assert.equal(C.buildDirectionsUrl(C.createStop(t, { title: '' }), 'walking'), null);
  assert.equal(C.buildDirectionsUrl(C.createStop(t, { title: '某地' }), 'walking'), null);
  assert.equal(C.resolveDestination(C.createStop(t, { title: '某地', city: 'Wien' })).level, 'name');
});

test('舊式網址、maps://、Google Maps 備援', () => {
  const t = demoTrip();
  const s = C.createStop(t, { title: 'Karlskirche', city: 'Vienna' });
  assert.equal(C.buildDirectionsUrl(s, 'transit', { appleStyle: 'legacy' }), 'https://maps.apple.com/?daddr=Karlskirche%2C+Vienna&dirflg=r');
  assert.equal(C.buildDirectionsUrl(s, 'cycling', { appleStyle: 'scheme' }), 'maps://?daddr=Karlskirche%2C+Vienna');
  const g = new URL(C.buildDirectionsUrl(s, 'cycling', { provider: 'google' }));
  assert.equal(g.searchParams.get('travelmode'), 'bicycling');
  assert.equal(g.searchParams.get('api'), '1');
});

test('旅行時區日期不受裝置時區影響', () => {
  // 臺灣 11/12 06:30 = 維也納 11/11 23:30
  const at = new Date('2026-11-11T22:30:00Z');
  assert.equal(C.dateInTimeZone('Europe/Vienna', at), '2026-11-11');
  assert.equal(C.dateInTimeZone('Asia/Taipei', at), '2026-11-12');
  const t = demoTrip();
  assert.deepEqual(C.resolveDefaultDate(t, at), { date: '2026-11-12', today: '2026-11-11', phase: 'before' });
  assert.equal(C.resolveDefaultDate(t, new Date('2026-11-13T10:00:00Z')).phase, 'during');
  assert.equal(C.resolveDefaultDate(t, new Date('2026-11-25T10:00:00Z')).date, '2026-11-19');
});

test('listDates 與日期格式', () => {
  assert.equal(C.listDates('2026-11-12', '2026-11-19').length, 8);
  assert.equal(C.formatDateShort('2026-11-12'), '11/12（四）');
  assert.equal(C.listDates('2026-11-19', '2026-11-12').length, 0);
});

test('完成／略過／復原：時間戳一致', () => {
  const t = demoTrip();
  const s = C.createStop(t, { date: '2026-11-12', title: 'A' });
  const c = C.applyStatus(s, 'completed', '2026-11-12T09:00:00.000Z');
  assert.equal(c.completedAt, '2026-11-12T09:00:00.000Z');
  assert.equal(c.skippedAt, null);
  const k = C.applyStatus(c, 'skipped', '2026-11-12T10:00:00.000Z');
  assert.equal(k.completedAt, null);
  assert.equal(k.skippedAt, '2026-11-12T10:00:00.000Z');
  const p = C.applyStatus(k, 'pending');
  assert.equal(p.completedAt, null);
  assert.equal(p.skippedAt, null);
  assert.equal(s.status, 'pending', '原物件不可被改動');
});

test('下一站依 order；略過不算完成但排除於下一站；缺地址仍列為下一站', () => {
  const t = demoTrip();
  const d = '2026-11-12';
  const a = C.createStop(t, { date: d, title: 'A', city: 'Wien' }); t.stops.push(a);
  const b = C.createStop(t, { date: d, title: 'B' }); t.stops.push(b); // 缺定位
  const c = C.createStop(t, { date: d, title: 'C', city: 'Bratislava' }); t.stops.push(c);
  assert.equal(C.nextStop(t, d).id, a.id);
  t.stops = t.stops.map((s) => (s.id === a.id ? C.applyStatus(s, 'skipped') : s));
  assert.equal(C.nextStop(t, d).id, b.id, '缺地址不可被靜默跳過');
  const p = C.progress(C.stopsForDate(t, d));
  assert.equal(p.completed, 0);
  assert.equal(p.skipped, 1);
  assert.equal(p.total, 3);
  t.stops = t.stops.map((s) => C.applyStatus(s, 'completed'));
  assert.equal(C.nextStop(t, d), null);
  assert.equal(C.progress(C.stopsForDate(t, d)).completedRatio, 1);
  assert.deepEqual(C.citiesForDate(t, d), ['Wien', 'Bratislava']);
  assert.equal(C.progress([]).completedRatio, 0);
});

test('上移／下移改變下一站，且不依時間強制排序', () => {
  const t = demoTrip();
  const d = '2026-11-12';
  const a = C.createStop(t, { date: d, title: 'A', startTime: '09:00' }); t.stops.push(a);
  const b = C.createStop(t, { date: d, title: 'B', startTime: '08:00' }); t.stops.push(b);
  assert.equal(C.nextStop(t, d).id, a.id);
  t.stops = C.moveStop(t.stops, b.id, -1);
  assert.equal(C.nextStop(t, d).id, b.id);
  assert.deepEqual(C.stopsForDate(t, d).map((s) => s.title), ['B', 'A']);
  const same = C.moveStop(t.stops, b.id, -1);
  assert.equal(same, t.stops, '已在最上方時不變');
});

test('候選景點（date=null）排入某日', () => {
  const t = demoTrip();
  const x = C.createStop(t, { title: 'Stephansdom', city: 'Wien' }); t.stops.push(x);
  assert.equal(C.candidates(t).length, 1);
  t.stops = C.moveStopToDate(t, x.id, '2026-11-14');
  assert.equal(C.candidates(t).length, 0);
  assert.equal(C.stopsForDate(t, '2026-11-14')[0].order, 1);
});

test('匯入驗證：合法備份可通過並產生摘要', () => {
  const t = demoTrip();
  t.stops.push(C.applyStatus(C.createStop(t, { date: '2026-11-12', title: 'A' }), 'completed'));
  t.stops.push(C.createStop(t, { title: '候選' }));
  const text = JSON.stringify(C.buildBackup([t]));
  const r = C.parseImport(text);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.kind, 'backup');
  assert.equal(r.summary[0].completed, 1);
  assert.equal(r.summary[0].candidates, 1);
});

test('匯入驗證：錯誤檔案被拒絕並說明原因', () => {
  assert.equal(C.parseImport('{oops').ok, false);
  assert.equal(C.parseImport('[]').ok, false);
  assert.equal(C.parseImport('{"hello":1}').ok, false);
  const t = demoTrip();
  const s = C.createStop(t, { date: '2026-12-01', title: 'A' });
  t.stops.push(s, { ...s }); // 日期超出範圍 + id 重複
  t.stops.push(C.createStop(t, { date: '2026-11-12', title: 'B', coordinates: { lat: 120, lng: 16 } }));
  t.stops.push(C.createStop(t, { date: '2026-11-12', title: 'C', referenceUrl: 'javascript:alert(1)' }));
  t.stops.push({ ...C.createStop(t, { date: '2026-11-12', title: 'D' }), status: 'completed' });
  const r = C.parseImport(JSON.stringify(t));
  assert.equal(r.ok, false);
  const all = r.errors.join('\n');
  assert.match(all, /不在旅程期間內/);
  assert.match(all, /id 重複/);
  assert.match(all, /座標超出範圍/);
  assert.match(all, /https/);
  assert.match(all, /缺少 completedAt/);
  const v2 = { ...C.buildBackup([demoTrip()]), schemaVersion: 2 };
  assert.match(C.parseImport(JSON.stringify(v2)).errors[0], /不相容/);
});

test('匯入：BOM 與中文、特殊字元往返不亂碼', () => {
  const t = demoTrip();
  t.title = '2026 中歐旅行 — Wien · Budapest';
  t.stops.push(C.createStop(t, { date: '2026-11-16', title: '布達城堡', localName: 'Budavári Palota', notes: '<script>alert(1)</script> 備註' }));
  const r = C.parseImport('﻿' + JSON.stringify(C.buildBackup([t])));
  assert.equal(r.ok, true);
  assert.equal(r.trips[0].title, t.title);
  assert.equal(r.trips[0].stops[0].localName, 'Budavári Palota');
  assert.equal(r.trips[0].stops[0].notes, '<script>alert(1)</script> 備註', '備註以原始文字保存，顯示時以 textContent 呈現');
});

test('範本匯出移除狀態與備註並產生新 id', () => {
  const t = demoTrip();
  const s = C.applyStatus(C.createStop(t, { date: '2026-11-12', title: 'A', notes: '房號 1203' }), 'completed');
  t.stops.push(s);
  const tpl = C.buildTemplate(t);
  assert.notEqual(tpl.tripId, t.tripId);
  assert.equal(tpl.stops[0].status, 'pending');
  assert.equal(tpl.stops[0].completedAt, null);
  assert.equal(tpl.stops[0].notes, null);
  assert.notEqual(tpl.stops[0].id, s.id);
  assert.equal(C.parseImport(JSON.stringify(tpl)).ok, true);
});

test('座標輸入解析', () => {
  assert.deepEqual(C.parseCoordsInput('48.1982, 16.3719'), { lat: 48.1982, lng: 16.3719 });
  assert.deepEqual(C.parseCoordsInput('48.1982，16.3719'), { lat: 48.1982, lng: 16.3719 });
  assert.equal(C.parseCoordsInput('91, 10'), null);
  assert.equal(C.parseCoordsInput('abc'), null);
});

test('檔名使用旅行時區', () => {
  const at = new Date('2026-11-12T08:05:00Z');
  assert.equal(C.backupFileName('central-europe-trip-backup', at, 'Europe/Vienna'), 'central-europe-trip-backup-20261112-0905.json');
  assert.equal(C.slugForFile('2026 中歐旅行 Wien'), '2026-wien');
});
