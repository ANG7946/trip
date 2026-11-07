# 兩地時間與日夜模式端對端測試
# 執行：先 npm run serve，再 python3 tests/e2e_clock_theme.py ./screenshots
import asyncio, os, sys
from playwright.async_api import async_playwright
BASE = os.environ.get('BASE', 'http://localhost:8080/')
SHOTS = sys.argv[1] if len(sys.argv) > 1 else './screenshots'
os.makedirs(SHOTS, exist_ok=True)
CHROME = os.environ.get('CHROME')
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, info)

async def bg(page):
    return await page.evaluate("getComputedStyle(document.body).backgroundColor")

async def main():
    async with async_playwright() as p:
        kw = {'args': ['--no-sandbox']}
        if CHROME: kw['executable_path'] = CHROME
        b = await p.chromium.launch(**kw)
        # 模擬人在臺灣、手機為淺色
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                  timezone_id='Asia/Taipei', color_scheme='light')
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'ERR_TUNNEL_CONNECTION_FAILED' not in m.text else None)
        await page.goto(BASE); await page.wait_for_selector('.welcome')
        await page.click('text=先看看示範旅程'); await page.wait_for_selector('.next-card')

        txt = await page.inner_text('#dual-clock')
        import re
        def hours(t):
            m = re.findall(r'(\d{2}):(\d{2})', t); return [int(a) * 60 + int(b) for a, b in m]
        hh = hours(txt)
        check('顯示兩地時間（家鄉自動記為臺北，11 月相差 7 小時，不再顯示時差文字）', '當地' in txt and '臺北' in txt and '快' not in txt and len(hh) == 2 and (hh[1] - hh[0]) % 1440 == 420, txt)
        light_bg = await bg(page)
        check('跟隨系統：淺色', await page.get_attribute('html', 'data-theme') == 'auto' and light_bg == 'rgb(244, 246, 249)', light_bg)
        await page.screenshot(path=f'{SHOTS}/40-light.png')

        # 快速切換為深色
        await page.click('.theme-toggle')
        await page.wait_for_timeout(200)
        check('快速切換為深色', await page.get_attribute('html', 'data-theme') == 'dark' and await bg(page) == 'rgb(13, 17, 23)', await bg(page))
        check('狀態列顏色跟著變深', await page.get_attribute('meta[name=theme-color]', 'content') == '#0d1117')
        await page.screenshot(path=f'{SHOTS}/41-dark.png')

        # 重新開啟：在第一次繪製前就是深色（由 theme-boot.js 套用）
        await page.reload(); await page.wait_for_selector('.next-card')
        boot = await page.evaluate("document.documentElement.getAttribute('data-theme')")
        check('重新開啟後維持深色', boot == 'dark' and await bg(page) == 'rgb(13, 17, 23)')

        # 設定頁：跟隨系統 + 系統改為深色
        await page.goto(BASE + '#app'); await page.wait_for_selector('.settings-view')
        await page.locator('label.field:has-text("日夜模式") select').select_option('auto')
        await page.emulate_media(color_scheme='dark'); await page.wait_for_timeout(200)
        check('跟隨系統：系統改深色時自動變深', await bg(page) == 'rgb(13, 17, 23)')
        await page.emulate_media(color_scheme='light'); await page.wait_for_timeout(200)
        check('跟隨系統：系統改回淺色時自動變淺', await bg(page) == 'rgb(244, 246, 249)')
        await page.locator('label.field:has-text("日夜模式") select').select_option('light')
        await page.emulate_media(color_scheme='dark'); await page.wait_for_timeout(200)
        check('固定淺色：不受系統深色影響', await bg(page) == 'rgb(244, 246, 249)')

        # 家鄉時區改為東京
        await page.locator('label.field:has-text("家鄉時區") select').select_option('Asia/Tokyo')
        await page.goto(BASE + '#today'); await page.wait_for_selector('.next-card')
        txt = await page.inner_text('#dual-clock')
        hh = hours(txt)
        check('改家鄉時區為東京（相差 8 小時）', '東京' in txt and (hh[1] - hh[0]) % 1440 == 480, txt)

        # 關閉兩地時間
        await page.goto(BASE + '#app'); await page.wait_for_selector('.settings-view')
        await page.click('label.check:has-text("顯示兩地時間") input')
        await page.goto(BASE + '#today'); await page.wait_for_selector('.next-card')
        check('可關閉兩地時間', (await page.inner_text('#dual-clock')).strip() == '')

        # 人已在維也納（手機時區 = 旅行地）：家鄉時區已固定，不會跟著變
        ctx2 = await b.new_context(viewport={'width': 390, 'height': 844}, timezone_id='Asia/Taipei')
        p2 = await ctx2.new_page()
        await p2.goto(BASE); await p2.wait_for_selector('.welcome')
        await p2.click('text=先看看示範旅程'); await p2.wait_for_selector('.next-card')
        await p2.wait_for_timeout(500)
        state = await p2.context.storage_state(indexed_db=True)
        await ctx2.close()
        ctx3 = await b.new_context(viewport={'width': 390, 'height': 844}, timezone_id='Europe/Vienna', storage_state=state)
        p3 = await ctx3.new_page()
        await p3.goto(BASE + '#today'); await p3.wait_for_selector('.next-card')
        t3 = (await p3.inner_text('#dual-clock')).strip()
        hh = hours(t3)
        check('出國後手機改為當地時區，家鄉仍是臺北', '臺北' in t3 and (hh[1] - hh[0]) % 1440 == 420, t3)
        await ctx3.close()

        check('無 JS／CSP 錯誤', not errs, '; '.join(errs))
        await b.close()
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')
    sys.exit(1 if fails else 0)
asyncio.run(main())
