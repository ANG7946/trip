// weather.js — 天氣預報（Open-Meteo，免費、免金鑰；資料授權 CC BY 4.0）
// 只傳送城市的大略座標（小數 2 位，約 1 公里），不傳送使用者位置或行程內容。
import { CITY_CENTERS, normName } from './photos.js?v=1.9.1';

export const WEATHER_TTL_MS = 3 * 3600 * 1000; // 3 小時內不重抓
export const FORECAST_DAYS = 16;
export const WX_FORMAT = 2; // 快取格式版本（v2 起含逐時預報與日出日落；舊快取會自動重抓）

/** WMO 天氣代碼 → 圖示與中文 */
export function wmo(code) {
  const c = Number(code);
  if (c === 0) return { icon: '☀️', text: '晴' };
  if (c === 1) return { icon: '🌤️', text: '晴時多雲' };
  if (c === 2) return { icon: '⛅', text: '多雲' };
  if (c === 3) return { icon: '☁️', text: '陰' };
  if (c === 45 || c === 48) return { icon: '🌫️', text: '霧' };
  if (c >= 51 && c <= 57) return { icon: '🌦️', text: '毛毛雨' };
  if (c >= 61 && c <= 67) return { icon: '🌧️', text: '雨' };
  if (c >= 71 && c <= 77) return { icon: '❄️', text: '雪' };
  if (c >= 80 && c <= 82) return { icon: '🌦️', text: '陣雨' };
  if (c === 85 || c === 86) return { icon: '🌨️', text: '陣雪' };
  if (c >= 95) return { icon: '⛈️', text: '雷雨' };
  return { icon: '🌡️', text: '—' };
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

export function forecastUrl(lat, lng, timeZone) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', String(round2(lat)));
  u.searchParams.set('longitude', String(round2(lng)));
  u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset');
  u.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code');
  u.searchParams.set('current', 'temperature_2m,weather_code');
  u.searchParams.set('timezone', timeZone || 'auto');
  u.searchParams.set('forecast_days', String(FORECAST_DAYS));
  return u.toString();
}

export function geocodeUrl(name) {
  const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
  u.searchParams.set('name', name);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'en');
  u.searchParams.set('format', 'json');
  return u.toString();
}

/** 解析預報；缺值（null）的日子不列入 */
export function parseForecast(json) {
  const d = json && json.daily;
  const daily = {};
  if (d && Array.isArray(d.time)) {
    d.time.forEach((date, i) => {
      const max = d.temperature_2m_max?.[i];
      const min = d.temperature_2m_min?.[i];
      const code = d.weather_code?.[i];
      if (max == null || min == null || code == null) return;
      const pop = d.precipitation_probability_max?.[i];
      const hm = (v) => (typeof v === 'string' && v.length >= 16 ? v.slice(11, 16) : null);
      daily[date] = { code, max, min, pop: pop == null ? null : pop, sunrise: hm(d.sunrise?.[i]), sunset: hm(d.sunset?.[i]) };
    });
  }
  // 逐時：依日期分組，缺值略過
  const hourly = {};
  const hh = json && json.hourly;
  if (hh && Array.isArray(hh.time)) {
    hh.time.forEach((t, i) => {
      const temp = hh.temperature_2m?.[i];
      const code = hh.weather_code?.[i];
      if (temp == null || code == null || typeof t !== 'string') return;
      const date = t.slice(0, 10);
      const pop = hh.precipitation_probability?.[i];
      (hourly[date] = hourly[date] || []).push({ time: t.slice(11, 16), temp, code, pop: pop == null ? null : pop });
    });
  }
  const c = json && json.current;
  const current = c && c.temperature_2m != null ? { time: c.time, temp: c.temperature_2m, code: c.weather_code } : null;
  return { daily, hourly, current };
}

/**
 * 當日詳細：日出日落＋每 3 小時一格（06–21 時，適合旅行白天行程；檢視今天時從目前時段開始）。
 * 回傳 { sunrise, sunset, slots: [{ time, icon, text, temp, pop }] } 或 null
 */
export function dayDetail(parsed, date, { nowTime = null, hours = ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00'] } = {}) {
  const day = parsed && parsed.daily[date];
  const list = parsed && parsed.hourly && parsed.hourly[date];
  if (!day && !list) return null;
  let wanted = hours;
  if (nowTime) {
    const nowH = Number(nowTime.slice(0, 2));
    const start = Math.max(0, Math.floor(nowH / 3) * 3);
    wanted = [];
    for (let k = start; k < 24 && wanted.length < 6; k += 3) wanted.push(`${String(k).padStart(2, '0')}:00`);
  }
  const slots = (list || []).filter((x) => wanted.includes(x.time)).map((x) => {
    const w = wmo(x.code);
    return { time: x.time, icon: w.icon, text: w.text, temp: `${Math.round(x.temp)}°`, pop: x.pop };
  });
  return { sunrise: day ? day.sunrise : null, sunset: day ? day.sunset : null, slots };
}

/**
 * 決定城市的座標：1) 當天該城市停靠點的座標（取第一個）2) 內建常見城市中心 3) null（需線上查詢）
 */
export function cityCoords(trip, date, city) {
  const key = normName(city);
  if (!key) return null;
  const withCoords = trip.stops.find((s) => s.date === date && normName(s.city) === key && (s.coordinates || s.entranceCoordinates));
  if (withCoords) {
    const c = withCoords.coordinates || withCoords.entranceCoordinates;
    return { lat: round2(c.lat), lng: round2(c.lng) };
  }
  if (CITY_CENTERS[key]) return { lat: round2(CITY_CENTERS[key][0]), lng: round2(CITY_CENTERS[key][1]) };
  return null;
}

export function cacheKey(coords) {
  return `wx:${round2(coords.lat)},${round2(coords.lng)}`;
}

/** 某日的天氣顯示文字；沒有資料時回傳 null */
export function describeDay(parsed, date, { today = null } = {}) {
  const day = parsed && parsed.daily[date];
  if (!day) return null;
  const w = wmo(day.code);
  const temp = `${Math.round(day.min)}–${Math.round(day.max)}°C`;
  const rain = day.pop != null && day.pop >= 10 ? `☂︎${day.pop}%` : '';
  const now = today === date && parsed.current ? `現在 ${Math.round(parsed.current.temp)}°` : '';
  return { icon: w.icon, text: w.text, temp, rain, now };
}
