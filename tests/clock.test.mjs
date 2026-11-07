import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/core.js';

test('時差：11 月維也納（冬令）與臺北相差 7 小時；7 月（夏令）相差 6 小時', () => {
  const nov = new Date('2026-11-12T08:12:00Z');
  const c = C.dualClock('Europe/Vienna', 'Asia/Taipei', nov);
  assert.equal(c.localTime, '09:12');
  assert.equal(c.homeTime, '16:12');
  assert.equal(c.diffText, '臺北快 7 小時');
  assert.equal(c.same, false);
  assert.equal(C.dualClock('Europe/Vienna', 'Asia/Taipei', new Date('2026-07-01T08:00:00Z')).diffText, '臺北快 6 小時');
});

test('跨日提示：維也納晚上 20:00 時臺北已是隔天', () => {
  const c = C.dualClock('Europe/Vienna', 'Asia/Taipei', new Date('2026-11-12T19:00:00Z'));
  assert.equal(c.localTime, '20:00');
  assert.equal(c.homeTime, '03:00');
  assert.equal(c.dayNote, '臺北已是隔天');
  const back = C.dualClock('Asia/Taipei', 'America/Los_Angeles', new Date('2026-11-12T02:00:00Z'));
  assert.equal(back.dayNote, '洛杉磯還是前一天');
  assert.match(back.diffText, /洛杉磯慢 16 小時/);
});

test('非整點時差與相同時區', () => {
  assert.equal(C.dualClock('Asia/Kolkata', 'Asia/Taipei', new Date('2026-11-12T00:00:00Z')).diffText, '臺北快 2 小時 30 分');
  assert.equal(C.dualClock('Europe/Vienna', 'Europe/Budapest', new Date()).same, true);
});

test('時區名稱：常見者用中文，其餘用 IANA 最後一段', () => {
  assert.equal(C.tzLabel('Asia/Taipei'), '臺北');
  assert.equal(C.tzLabel('America/Argentina/Buenos_Aires'), 'Buenos Aires');
});
