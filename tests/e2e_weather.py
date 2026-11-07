# 天氣預報端對端測試：以攔截請求回傳真實 Open-Meteo 回應（2026-11-07 取得），不連真實網路
# 執行：先 npm run serve，再 python3 tests/e2e_weather.py ./screenshots
import asyncio, json, os, sys
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
BASE = os.environ.get('BASE', 'http://localhost:8080/')
SHOTS = sys.argv[1] if len(sys.argv) > 1 else './screenshots'
os.makedirs(SHOTS, exist_ok=True)
CHROME = os.environ.get('CHROME')
HERE = os.path.dirname(os.path.abspath(__file__))
REAL = open(os.path.join(HERE, 'fixtures', 'open-meteo-vienna-hourly.json'), encoding='utf-8').read()
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, info)

hits = []
async def route_wx(route):
    url = route.request.url
    hits.append(url)
    h = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}
    if 'geocoding-api' in url:
        return await route.fulfill(status=200, headers=h, body=json.dumps({'results': [{'name': 'X', 'latitude': 47.56231, 'longitude': 13.64912}]}))
    return await route.fulfill(status=200, headers=h, body=REAL)

async def main():
    async with async_playwright() as p:
        kw = {'args': ['--no-sandbox']}
        if CHROME: kw['executable_path'] = CHROME
        b = await p.chromium.launch(**kw)
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, timezone_id='Asia/Taipei')
        await ctx.route('https://*.open-meteo.com/**', route_wx)
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await page.goto(BASE); await page.wait_for_selector('.welcome')
        await page.click('text=先看看示範旅程'); await page.wait_for_selector('.next-card')
        await page.wait_for_selector('#weather-row .wx-chip', timeout=8000)
        txt = await page.inner_text('#weather-row')
        check('11/12 顯示維也納天氣（霧 4–10°C、降雨 10%）', 'Vienna' in txt and '4–10°C' in txt and '☂︎10%' in txt, txt.replace('\n', ' '))
        check('天氣列不再放 Open-Meteo 連結', 'Open-Meteo' not in txt)
        # 點城市標籤 → 展開逐時預報（11/12 的逐時資料不在測試檔內，改看 11/15）
        await page.select_option('.date-select', '2026-11-14')
        await page.select_option('.date-select', '2026-11-12')
        check('已移除長日期文字', await page.locator('.date-long').count() == 0)
        q = parse_qs(urlparse(hits[0]).query)
        check('只送出城市的大略座標（小數 2 位）', all(len(q[k][0].split('.')[-1]) <= 2 for k in ('latitude', 'longitude')), f"{q['latitude'][0]},{q['longitude'][0]}")
        await page.screenshot(path=f'{SHOTS}/50-weather.png')

        # 11/14：維也納＋布拉提斯拉瓦兩個城市
        await page.select_option('.date-select', '2026-11-14')
        for _ in range(50):
            if await page.locator('#weather-row .wx-chip').count() >= 2: break
            await page.wait_for_timeout(100)
        chips = await page.locator('#weather-row .wx-chip').all_inner_texts()
        check('同日兩城市各顯示一個天氣標籤', len(chips) == 2 and 'Vienna' in chips[0] and 'Bratislava' in chips[1], str(chips))

        # 逐時預報：示範旅程沒有 11/15，暫時加一個 11/15 的維也納停靠點
        await page.goto(BASE + '#tripform/edit'); await page.wait_for_selector('.stop-form')
        await page.fill('.stop-form input[type=date] >> nth=1', '2026-11-15')
        await page.click('button[type=submit]'); await page.wait_for_timeout(400)
        await page.goto(BASE + '#new/2026-11-15'); await page.wait_for_selector('.stop-form')
        await page.fill('input[placeholder="例：卡爾教堂"]', '美泉宮'); await page.fill('input[placeholder^="例：Vienna"]', 'Vienna')
        await page.click('button[type=submit]'); await page.wait_for_timeout(500)
        await page.goto(BASE + '#today'); await page.wait_for_selector('.today-view')
        await page.select_option('.date-select', '2026-11-15')
        await page.wait_for_selector('#weather-row button.wx-chip', timeout=8000)
        check('詳細面板預設收合', not await page.is_visible('#weather-detail'))
        await page.click('#weather-row button.wx-chip')
        await page.wait_for_selector('#weather-detail .wx-slot', timeout=5000)
        det = await page.inner_text('#weather-detail')
        slots = await page.locator('#weather-detail .wx-slot').count()
        check('點城市展開逐時預報：6 個時段、日出日落', slots == 6 and '日出 07:01' in det and '日落 16:16' in det, det.replace('\n', ' ')[:120])
        check('詳細面板底部標示資料來源與授權', 'Open-Meteo.com' in det and 'CC BY 4.0' in det)
        check('展開狀態以 aria-expanded 標示', await page.get_attribute('#weather-row button.wx-chip', 'aria-expanded') == 'true')
        await page.screenshot(path=f'{SHOTS}/51-weather-detail.png')
        await page.click('#weather-row button.wx-chip'); await page.wait_for_timeout(200)
        check('再點一次收合', not await page.is_visible('#weather-detail'))
        await page.click('#weather-row button.wx-chip'); await page.wait_for_selector('#weather-detail .wx-slot')
        await page.click('.date-step:has-text("前一天")'); await page.wait_for_timeout(300)
        check('切換日期時自動收合', not await page.is_visible('#weather-detail'))

        # 3 小時內不重抓
        n = len(hits)
        await page.reload(); await page.wait_for_selector('#weather-row .wx-chip', timeout=8000)
        check('3 小時內重新開啟不重新下載', len(hits) == n, f'{n} -> {len(hits)}')

        # 離線：顯示上次的資料
        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_selector('#weather-row .wx-chip', timeout=8000)
        check('離線時仍顯示已存的天氣', 'Vienna' in await page.inner_text('#weather-row'))
        await ctx.set_offline(False)

        # 關閉天氣：不顯示、不連線
        await page.goto(BASE + '#app'); await page.wait_for_selector('.settings-view')
        await page.click('label.check:has-text("顯示天氣預報") input')
        n2 = len(hits)
        await page.goto(BASE + '#today'); await page.wait_for_selector('.next-card'); await page.wait_for_timeout(800)
        check('關閉後不顯示天氣、也不發出請求', await page.locator('#weather-row .wx-chip').count() == 0 and len(hits) == n2)
        plain = await page.locator('#weather-row .chip.city').all_inner_texts()
        check('關閉天氣後仍以城市標籤顯示當天城市（11/14 兩城市）', plain == ['Vienna', 'Bratislava'], str(plain))
        check('「行前預覽」移到兩地時間同一行；原城市列已移除', await page.locator('.clock-row .chip.preview').count() == 1 and await page.locator('.date-meta').count() == 0)
        check('沒有出現 null 字樣', 'null' not in await page.inner_text('.day-header'))
        check('無 JS／CSP 錯誤', not errs, '; '.join(errs))
        await b.close()
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')
    sys.exit(1 if fails else 0)
asyncio.run(main())
