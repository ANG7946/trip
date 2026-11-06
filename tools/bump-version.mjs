// 用法：node tools/bump-version.mjs 1.1.2
// 一次更新所有版本字串：資產網址的 ?v=、Service Worker 快取名稱、App 顯示版本、package.json
import { readFileSync, writeFileSync } from 'node:fs';
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || '')) { console.error('請提供版本號，例如 1.1.2'); process.exit(1); }
const edits = {
  'index.html': [[/\?v=[\d.]+/g, `?v=${v}`]],
  'sw.js': [[/\?v=[\d.]+/g, `?v=${v}`], [/const VERSION = '[\d.]+';/, `const VERSION = '${v}';`]],
  'js/app.js': [[/\?v=[\d.]+/g, `?v=${v}`], [/APP_VERSION = '[\d.]+';/, `APP_VERSION = '${v}';`]],
  'js/db.js': [[/\?v=[\d.]+/g, `?v=${v}`]],
  'js/csv.js': [[/\?v=[\d.]+/g, `?v=${v}`]],
  'package.json': [[/"version": "[\d.]+"/, `"version": "${v}"`]],
};
for (const [file, list] of Object.entries(edits)) {
  let s = readFileSync(file, 'utf8');
  for (const [re, rep] of list) s = s.replace(re, rep);
  writeFileSync(file, s);
}
console.log(`版本已更新為 ${v}`);
