// theme-boot.js — 在畫面第一次繪製前套用日夜模式，避免開啟時閃一下淺色
// 一般（非 module）腳本，於 <head> 同步載入；設定存在 localStorage（僅本機外觀偏好）
(function () {
  var mode = 'auto';
  try { mode = localStorage.getItem('tc-theme') || 'auto'; } catch (e) { /* 部分情境無法使用 localStorage */ }
  if (mode !== 'light' && mode !== 'dark') mode = 'auto';
  document.documentElement.setAttribute('data-theme', mode);
  var dark = mode === 'dark' || (mode === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0d1117' : '#0b2545');
}());
