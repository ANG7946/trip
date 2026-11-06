# 匯入相關的端對端測試：CSV 檔（UTF-8／Big5）、貼上 AI JSON、貼上試算表表格、說明頁
# 執行：先 npm run serve，再 python3 tests/e2e_import.py ./screenshots
import asyncio, json, os, sys, tempfile
from playwright.async_api import async_playwright
BASE = os.environ.get('BASE', 'http://localhost:8080/')
SHOTS = sys.argv[1] if len(sys.argv) > 1 else './screenshots'
os.makedirs(SHOTS, exist_ok=True)
CHROME = os.environ.get('CHROME')
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, info)

AI_JSON = json.dumps({
  "schemaVersion": 1, "title": "朋友的東京行", "timeZone": "Asia/Tokyo", "startDate": "2027-03-01", "endDate": "2027-03-02",
  "settings": {"defaultMode": "transit"},
  "stops": [
    {"date": "2027-03-01", "order": 1, "city": "Tokyo", "title": "淺草寺", "localName": "浅草寺", "type": "attraction"},
    {"date": "2027-03-02", "order": 1, "city": "Tokyo", "title": "明治神宮", "localName": "明治神宮", "type": "attraction", "startTime": "09:00"},
  ]}, ensure_ascii=False)

async def main():
    async with async_playwright() as p:
        kw = {'args': ['--no-sandbox']}
        if CHROME: kw['executable_path'] = CHROME
        b = await p.chromium.launch(**kw)
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        await ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE.rstrip('/'))
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto(BASE); await page.wait_for_selector('.welcome')
        # 等 Service Worker 接管頁面（下載問題只在 SW 控制下出現）
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller !== null', timeout=10000)

        # 說明頁
        await page.click('text=如何建立行程檔？'); await page.wait_for_selector('.guide-view')
        check('說明頁含提示詞', '不要自行猜測' in await page.inner_text('.prompt-box'))
        await page.click('text=複製提示詞'); await page.wait_for_timeout(300)
        clip = await page.evaluate('navigator.clipboard.readText()')
        check('複製提示詞到剪貼簿', clip.startswith('請把我下面提供'))
        await page.screenshot(path=f'{SHOTS}/10-guide.png', full_page=True)
        async with page.expect_download() as dl:
            await page.click('.guide-view a:has-text("下載 CSV 範本")')
        d = await dl.value
        csv_path = await d.path()
        check('下載 CSV 範本', d.suggested_filename == 'trip-template.csv')
        head = open(csv_path, 'rb').read(200).decode('utf-8', 'replace')
        check('下載的 CSV 內容正確（不是網頁 HTML）', head.lstrip('\ufeff').startswith('日期,順序,城市,名稱') and '<html' not in head.lower(), head[:40])
        async with page.expect_download() as dl2:
            await page.click('.guide-view a:has-text("下載 JSON 範本")')
        jhead = open(await (await dl2.value).path(), 'rb').read(100).decode('utf-8', 'replace')
        check('下載的 JSON 範本內容正確', jhead.lstrip().startswith('{'), jhead[:30])

        # 直接以「開啟頁面」方式請求 CSV（部分瀏覽器的下載連結即是如此），不可被 SW 換成 App 首頁
        nav = await ctx.new_page()
        served_html = False
        try:
            resp = await nav.goto(BASE + 'data/trip-template.csv')
            body = await resp.text() if resp else ''
            served_html = '<html' in body.lower()
        except Exception as e:
            served_html = False  # 觸發下載＝拿到 CSV 本身
        await nav.close()
        check('以頁面導覽開啟 CSV 不會拿到網頁 HTML', not served_html)

        # 貼上 AI JSON
        await page.goto(BASE + '#paste'); await page.wait_for_selector('.paste-box')
        await page.fill('.paste-box', '```json\n' + AI_JSON + '\n```')
        await page.click('text=檢查並預覽'); await page.wait_for_selector('.import-view')
        check('AI JSON 預覽', '朋友的東京行' in await page.inner_text('.import-view'))
        await page.click('text=加入為新旅程'); await page.wait_for_selector('.today-view')
        check('AI JSON 匯入後顯示下一站', '淺草寺' in await page.inner_text('.next-name'))
        href = await page.get_attribute('.next-card a.btn.nav', 'href')
        check('AI JSON 預設交通方式 transit', 'mode=transit' in href, href)

        # 匯入範本 CSV（建立新旅程）
        await page.goto(BASE + '#app'); await page.wait_for_selector('#import-file')
        await page.set_input_files('#import-file', csv_path)
        await page.wait_for_selector('.import-view')
        txt = await page.inner_text('.import-view')
        check('CSV 預覽筆數', '共 5 筆' in txt and '候選景點 1 筆' in txt, txt[:120])
        await page.screenshot(path=f'{SHOTS}/11-csv-preview.png', full_page=True)
        await page.fill('.import-view input[type=text]', 'CSV 測試旅程')
        await page.click('text=建立新旅程並匯入'); await page.wait_for_selector('.today-view')
        check('CSV 新旅程下一站', '卡爾教堂' in await page.inner_text('.next-name'))

        # Big5 CSV 加入目前旅程
        big5 = os.path.join(tempfile.gettempdir(), 'big5-trip.csv')
        open(big5, 'wb').write('日期,名稱,城市,交通方式\r\n2026-11-12,自然史博物館,Vienna,步行\r\n2026-11-30,超出範圍,Vienna,步行\r\n'.encode('big5'))
        await page.goto(BASE + '#app'); await page.wait_for_selector('#import-file')
        await page.set_input_files('#import-file', big5); await page.wait_for_selector('.import-view')
        check('Big5 正確解碼', 'Big5' in await page.inner_text('.import-view') and '自然史博物館' in await page.inner_text('.import-view'))
        await page.click('button:has-text("加入「CSV 測試旅程」")')
        await page.wait_for_timeout(300)
        check('超出旅程日期被拒並說明', '不在旅程期間' in await page.inner_text('.form-errors'))

        # 貼上試算表表格（Tab 分隔）加入目前旅程
        await page.goto(BASE + '#paste'); await page.wait_for_selector('.paste-box')
        await page.fill('.paste-box', '日期\t名稱\t城市\n2026-11-12\t自然史博物館\tVienna\n')
        await page.click('text=檢查並預覽'); await page.wait_for_selector('.import-view')
        await page.click('button:has-text("加入「CSV 測試旅程」")'); await page.wait_for_selector('.edit-view')
        names = await page.locator('.edit-view .edit-list').first.locator('.stop-title').all_inner_texts()
        check('Tab 表格加入後接在最後', names == ['卡爾教堂', '美景宮', '自然史博物館'], str(names))

        # 錯誤 CSV
        bad = os.path.join(tempfile.gettempdir(), 'bad.csv')
        open(bad, 'w', encoding='utf-8').write('日期,地址\n2026-11-12,x\n')
        await page.goto(BASE + '#app'); await page.wait_for_selector('#import-file')
        await page.set_input_files('#import-file', bad); await page.wait_for_selector('.import-view')
        check('缺名稱欄的 CSV 被拒', '無法匯入 CSV' in await page.inner_text('.import-view h1'))

        # 旅程數
        await page.goto(BASE + '#trips'); await page.wait_for_selector('.date-list')
        check('共有 2 個旅程', await page.locator('.date-list li').count() == 2)
        check('無 JS 錯誤', not errors, '; '.join(errors))
        await b.close()
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')
    sys.exit(1 if fails else 0)
asyncio.run(main())
