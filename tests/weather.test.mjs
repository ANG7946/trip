import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../js/weather.js';
import * as C from '../js/core.js';

// 2026-11-07 以真實 Open-Meteo API 取得的維也納預報（公開天氣資料）
const real = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-vienna-2026-11-07.json', import.meta.url), 'utf8'));

test('解析真實回應：每日預報、現在溫度；缺值（null）的日子略過', () => {
  const p = W.parseForecast(real);
  assert.deepEqual(p.daily['2026-11-13'], { code: 61, max: 8.2, min: 4.0, pop: 33, sunrise: null, sunset: null });
  assert.equal(p.daily['2026-11-21'].pop, null, '降雨機率缺值仍保留當日');
  assert.equal(p.daily['2026-11-22'], undefined, '溫度缺值的日子不列入');
  assert.deepEqual(p.current, { time: '2026-11-07T02:15', temp: 1.7, code: 2 });
});

test('顯示文字：圖示、溫度區間、降雨機率（10% 以上才顯示）、當天加現在溫度', () => {
  const p = W.parseForecast(real);
  assert.deepEqual(W.describeDay(p, '2026-11-13'), { icon: '🌧️', text: '雨', temp: '4–8°C', rain: '☂︎33%', now: '' });
  assert.equal(W.describeDay(p, '2026-11-07').rain, '', '0% 不顯示');
  assert.equal(W.describeDay(p, '2026-11-07', { today: '2026-11-07' }).now, '現在 2°');
  assert.equal(W.describeDay(p, '2026-11-19').text, '雪');
  assert.equal(W.describeDay(p, '2026-12-25'), null, '超出預報範圍');
});

test('WMO 代碼對照', () => {
  assert.equal(W.wmo(0).text, '晴');
  assert.equal(W.wmo(45).text, '霧');
  assert.equal(W.wmo(95).text, '雷雨');
});

test('API 網址：座標取小數 2 位（約 1 公里，不傳精確位置）、旅程時區、16 天', () => {
  const u = new URL(W.forecastUrl(48.198234, 16.371912, 'Europe/Vienna'));
  assert.equal(u.hostname, 'api.open-meteo.com');
  assert.equal(u.searchParams.get('latitude'), '48.2');
  assert.equal(u.searchParams.get('longitude'), '16.37');
  assert.equal(u.searchParams.get('timezone'), 'Europe/Vienna');
  assert.equal(u.searchParams.get('forecast_days'), '16');
  assert.equal(new URL(W.geocodeUrl('Hallstatt')).searchParams.get('name'), 'Hallstatt');
});

test('城市座標：優先用當天該城市停靠點的座標，其次內建城市中心，否則需線上查詢', () => {
  const t = C.createTrip({ title: 't', timeZone: 'Europe/Vienna', startDate: '2026-11-12', endDate: '2026-11-14' });
  t.stops.push(C.createStop(t, { date: '2026-11-14', title: 'Castle', city: 'Bratislava', coordinates: { lat: 48.142, lng: 17.1001 } }));
  assert.deepEqual(W.cityCoords(t, '2026-11-14', 'Bratislava'), { lat: 48.14, lng: 17.1 });
  assert.deepEqual(W.cityCoords(t, '2026-11-12', 'Vienna'), { lat: 48.21, lng: 16.37 });
  assert.equal(W.cityCoords(t, '2026-11-12', 'Hallstatt'), null);
  assert.equal(W.cacheKey({ lat: 48.2082, lng: 16.3738 }), 'wx:48.21,16.37');
});

// 含逐時與日出日落的回應（結構於 2026-11-07 以真實 API 確認；11/15 00–03 時與日出日落為真實數值）
const hourlyFx = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-vienna-hourly.json', import.meta.url), 'utf8'));

test('網址包含逐時預報與日出日落', () => {
  const u = new URL(W.forecastUrl(48.21, 16.37, 'Europe/Vienna'));
  assert.match(u.searchParams.get('daily'), /sunrise,sunset/);
  assert.equal(u.searchParams.get('hourly'), 'temperature_2m,precipitation_probability,weather_code');
});

test('解析逐時（依日期分組、缺值略過）與日出日落', () => {
  const p = W.parseForecast(hourlyFx);
  assert.equal(p.daily['2026-11-15'].sunrise, '07:01');
  assert.equal(p.daily['2026-11-15'].sunset, '16:16');
  assert.deepEqual(p.hourly['2026-11-15'][0], { time: '00:00', temp: 0.7, code: 0, pop: 3 });
  assert.equal(p.hourly['2026-11-22'], undefined, '全為 null 的時段不列入');
});

test('當日詳細：06–21 時每 3 小時；檢視今天時從目前時段開始', () => {
  const p = W.parseForecast(hourlyFx);
  const d = W.dayDetail(p, '2026-11-15');
  assert.deepEqual(d.slots.map((x) => x.time), ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
  assert.equal(d.sunset, '16:16');
  const now = W.dayDetail(p, '2026-11-15', { nowTime: '01:40' });
  assert.deepEqual(now.slots.map((x) => x.time), ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00']);
  assert.equal(now.slots[0].temp, '1°');
  assert.equal(W.dayDetail(p, '2027-01-01'), null);
  // 舊格式快取（無逐時）仍可顯示日出日落
  const old = W.parseForecast(real);
  assert.deepEqual(W.dayDetail(old, '2026-11-13').slots, []);
});
