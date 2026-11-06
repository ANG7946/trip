import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../js/images.js';
import * as C from '../js/core.js';

const T = [
  { id: 'a', date: '2026-11-12', position: 1, title: '卡爾教堂', localName: 'Karlskirche' },
  { id: 'b', date: '2026-11-12', position: 2, title: '美景宮', localName: 'Schloss Belvedere' },
  { id: 'c', date: '2026-11-13', position: 1, title: '漁人堡', localName: 'Halászbástya' },
  { id: 'd', date: '2026-11-13', position: 2, title: 'Leopold Museum', localName: null },
];
const dates = ['2026-11-12', '2026-11-13'];

test('檔名日期＋順序解析', () => {
  assert.deepEqual(I.parseDateOrder('11-12_2.jpg'), { month: 11, day: 12, n: 2 });
  assert.deepEqual(I.parseDateOrder('2026-11-13_1.HEIC'), { month: 11, day: 13, n: 1 });
  assert.deepEqual(I.parseDateOrder('1112-2.png'), { month: 11, day: 12, n: 2 });
  assert.deepEqual(I.parseDateOrder('D2-1.jpg'), { dayIndex: 2, n: 1 });
  assert.equal(I.parseDateOrder('IMG_1234.JPG'), null);
});

test('依檔名配對：日期順序、當地名稱（含重音）、中文名稱', () => {
  const files = [{ name: '11-12_2.jpg' }, { name: 'halaszbastya.png' }, { name: '卡爾教堂.jpg' }, { name: 'D2-2.jpg' }];
  const r = I.guessAssignments(files, T, { dates });
  assert.deepEqual(r.map((x) => x.stopId), ['b', 'c', 'a', 'd']);
  assert.ok(r.every((x) => x.source === 'filename'));
});

test('iPhone 檔名（IMG_xxxx）依選取順序配給尚未配對的停靠點', () => {
  const files = [{ name: 'karlskirche.jpg' }, { name: 'IMG_0001.HEIC' }, { name: 'IMG_0002.HEIC' }];
  const r = I.guessAssignments(files, T, { dates });
  assert.deepEqual(r.map((x) => [x.stopId, x.source]), [['a', 'filename'], ['b', 'order'], ['c', 'order']]);
});

test('照片比停靠點多時，多出的不指派；關閉依序指派時只依檔名', () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ name: `IMG_${i}.jpg` }));
  const r = I.guessAssignments(files, T, { dates });
  assert.equal(r.filter((x) => x.stopId).length, 4);
  assert.equal(r[5].stopId, null);
  const r2 = I.guessAssignments([{ name: 'IMG_1.jpg' }], T, { dates, useOrder: false });
  assert.equal(r2[0].stopId, null);
});

test('名稱模糊吻合多個時不亂配（改為依順序）', () => {
  const twins = [{ id: 'x', date: '2026-11-12', position: 1, title: 'Museum A' }, { id: 'y', date: '2026-11-12', position: 2, title: 'Museum B' }];
  const r = I.guessAssignments([{ name: 'museum.jpg' }], twins, { dates, useOrder: false });
  assert.equal(r[0].stopId, null);
});

test('備份：只帶出仍被引用的照片；驗證照片格式；範本移除自己的照片', () => {
  const t = C.createTrip({ title: 't', timeZone: 'Europe/Vienna', startDate: '2026-11-12', endDate: '2026-11-13' });
  t.stops.push(C.createStop(t, { date: '2026-11-12', title: 'A', userPhoto: { id: 'img1' } }));
  const imgs = [{ id: 'img1', mime: 'image/jpeg', data: 'AAAA' }, { id: 'orphan', mime: 'image/jpeg', data: 'BBBB' }];
  const b = C.buildBackup([t], undefined, imgs);
  assert.deepEqual(b.images.map((x) => x.id), ['img1']);
  const r = C.parseImport(JSON.stringify(b));
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.images.length, 1);
  assert.equal(C.parseImport(JSON.stringify(C.buildBackup([t]))).images, null, '不含照片的備份');
  const bad = { ...b, images: [{ id: 'img1', mime: 'image/svg+xml', data: 'AAAA' }] };
  assert.match(C.parseImport(JSON.stringify(bad)).errors.join(), /不支援的格式/);
  const bad2 = { ...b, images: [{ id: 'img1', mime: 'image/jpeg', data: '<script>' }] };
  assert.match(C.parseImport(JSON.stringify(bad2)).errors.join(), /損壞/);
  assert.equal(C.buildTemplate(t).stops[0].userPhoto, null);
});

test('同一地點：地址相同、座標 30m 內、名稱＋城市相同', () => {
  const h1 = { id: '1', title: '飯店（入住）', city: 'Vienna', address: 'Lemböckgasse 61, 1230 Wien' };
  const h2 = { id: '2', title: '飯店（退房）', city: 'Vienna', address: 'Lemböckgasse 61, 1230 Wien' };
  assert.equal(I.samePlace(h1, h2), true, '名稱不同但地址相同');
  const c1 = { id: '3', title: 'A', city: 'X', coordinates: { lat: 48.18500, lng: 16.37600 } };
  const c2 = { id: '4', title: 'B', city: 'Y', coordinates: { lat: 48.18510, lng: 16.37610 } };
  assert.equal(I.samePlace(c1, c2), true, '約 13m');
  const c3 = { ...c2, id: '5', coordinates: { lat: 48.1860, lng: 16.3770 } };
  assert.equal(I.samePlace(c1, c3), false, '約 130m');
  const n1 = { id: '6', title: '美景宮', localName: 'Schloss Belvedere', city: 'Vienna' };
  const n2 = { id: '7', title: '美景宮花園', localName: 'Schloss Belvedere', city: 'Vienna' };
  assert.equal(I.samePlace(n1, n2), true, '當地名稱＋城市相同');
  assert.equal(I.samePlace(n1, { ...n2, city: 'Salzburg' }), false, '不同城市');
  assert.equal(I.samePlace(n1, n1), false, '同一站本身不算');
});

test('找出同一地點中最早、且照片仍存在的那一站', () => {
  const stops = [
    { id: 'b', date: '2026-11-17', order: 1, title: 'Hotel Test', city: 'V', userPhoto: { id: 'img2' } },
    { id: 'a', date: '2026-11-12', order: 1, title: 'Hotel Test', city: 'V', userPhoto: { id: 'img1' } },
    { id: 'c', date: '2026-11-15', order: 2, title: 'Hotel Test', city: 'V' },
    { id: 'gone', date: '2026-11-11', order: 1, title: 'Hotel Test', city: 'V', userPhoto: { id: 'deleted' } },
  ];
  const has = (id) => id !== 'deleted';
  assert.equal(I.findSamePlaceWithPhoto(stops, stops[2], has).id, 'a');
  assert.equal(I.findSamePlaceWithPhoto(stops, { id: 'z', title: 'Other', city: 'V' }, has), null);
});
