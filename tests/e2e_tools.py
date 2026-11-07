# 工具分頁端對端測試：回飯店、緊急資訊、聯絡人、匯率（攔截 API）、花費、匯出 Excel、備份
# 匯率回應依 2026-11-07 真實 API 數值（EUR 0.027329、HUF 9.926 / TWD 基準）
# 執行：先 npm run serve，再 python3 tests/e2e_tools.py ./screenshots
import asyncio, json, os, sys, zipfile, io
from playwright.async_api import async_playwright
BASE = os.environ.get('BASE', 'http://localhost:8080/')
SHOTS = sys.argv[1] if len(sys.argv) > 1 else './screenshots'
os.makedirs(SHOTS, exist_ok=True)
CHROME = os.environ.get('CHROME')
HERE = os.path.dirname(os.path.abspath(__file__))
FX = open(os.path.join(HERE, 'fixtures', 'er-api-twd.json'), encoding='utf-8').read()
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, info)
fx_hits = []
async def route_fx(route):
    fx_hits.append(route.request.url)
    await route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}, body=FX)
async def route_block(route):
    await route.abort()

async def wait_true(page, js, timeout=5000):
    for _ in range(timeout // 100):
        if await page.evaluate(js): return True
        await page.wait_for_timeout(100)
    return False

async def main():
    async with async_playwright() as p:
        kw = {'args': ['--no-sandbox']}
        if CHROME: kw['executable_path'] = CHROME
        b = await p.chromium.launch(**kw)
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, timezone_id='Asia/Taipei', accept_downloads=True)
        await ctx.route('https://open.er-api.com/**', route_fx)
        await ctx.route('https://*.open-meteo.com/**', route_block)
        await ctx.route('https://*.wikipedia.org/**', route_block)
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'ERR_' not in m.text and 'Failed to load resource' not in m.text else None)
        await page.goto(BASE); await page.wait_for_selector('.welcome')
        await page.click('text=先看看示範旅程'); await page.wait_for_selector('.next-card')

        tabs = await page.locator('#tabbar .tab').all_inner_texts()
        check('底部 5 個分頁，工具在第 4 個', tabs == ['今天', '全部日期', '編輯行程', '工具', '旅程設定'], str(tabs))
        check('沒有住宿時不顯示回飯店', await page.locator('.hotel-btn').count() == 0)

        # 加入 11/12 住宿
        await page.goto(BASE + '#new/2026-11-12'); await page.wait_for_selector('.stop-form')
        await page.fill('input[placeholder="例：卡爾教堂"]', '測試飯店')
        await page.fill('input[placeholder^="例：Vienna"]', 'Vienna')
        await page.select_option('.stop-form select >> nth=0', 'hotel')
        await page.evaluate("""() => { const f=[...document.querySelectorAll('.field')].find(x=>x.querySelector('.field-label')?.textContent.includes('地址')); const i=f.querySelector('input,textarea'); i.value='Mariahilfer Str. 1, 1060 Wien'; i.dispatchEvent(new Event('input',{bubbles:true})); }""")
        await page.click('button[type=submit]'); await page.wait_for_timeout(500)
        await page.goto(BASE + '#today'); await page.wait_for_selector('.today-view')
        await page.select_option('.date-select', '2026-11-12'); await page.wait_for_timeout(200)
        hb = page.locator('.hotel-btn')
        check('有住宿當天：頁首出現回飯店', await hb.count() == 1)
        href = await hb.get_attribute('href') if await hb.count() else ''
        check('回飯店連到 Apple Maps 路線', href.startswith('https://maps.apple.com/directions') and 'Mariahilfer' in href, href)
        await page.select_option('.date-select', '2026-11-13'); await page.wait_for_timeout(200)
        check('隔天沒有住宿：沿用前一晚的飯店', await page.locator('.hotel-btn').count() == 1)
        box = await page.locator('.head-row').bounding_box()
        hbb = await page.locator('.hotel-btn').bounding_box()
        check('回飯店在第一行右側', hbb and box and hbb['x'] + hbb['width'] > box['x'] + box['width'] - 4 and abs(hbb['y'] - box['y']) < 20)
        await page.screenshot(path=f'{SHOTS}/60-hotel.png')

        # 工具頁
        await page.click('#tabbar .tab:has-text("工具")'); await page.wait_for_selector('.tools-view')
        em = await page.inner_text('#tl-emergency')
        check('依行程判斷國家：奧地利、匈牙利、斯洛伐克', all(x in em for x in ['奧地利', '匈牙利', '斯洛伐克']))
        check('三國代表處急難電話', all(x in em for x in ['+43-664-345-0455', '+36-30-964-1546', '+421-915-108-489']))
        tels = await page.eval_on_selector_all('#tl-emergency a[href^="tel:"]', 'els => els.map(e => e.getAttribute("href"))')
        check('電話皆為 tel: 連結，含 112 與外交部專線', 'tel:112' in tels and 'tel:+886800085095' in tels and 'tel:+436643450455' in tels, str(len(tels)))
        check('標示資料來源與查證日期', '外交部領事事務局' in em and '2026-11-07' in em)
        check('奧匈斯不顯示全球免付費專線', '800-0885-0885' not in em)
        await page.select_option('#tl-emergency select', 'DE'); await page.wait_for_timeout(300)
        em2 = await page.inner_text('#tl-emergency')
        check('手動加入德國：顯示免付費撥法與「尚未內建館處」', '德國' in em2 and '00-800-0885-0885' in em2 and '尚未內建此國家的駐外館處' in em2)
        await page.click('#tl-emergency .em-remove'); await page.wait_for_timeout(300)
        check('可移除手動加入的國家', '德國' not in ''.join(await page.locator('#tl-emergency h3').all_inner_texts()))
        await page.screenshot(path=f'{SHOTS}/61-emergency.png', full_page=True)

        # 聯絡人
        check('三國共用 112 只顯示一次', await page.locator('#tl-emergency .btn.tel.local').count() == 1)
        await page.click('#tl-contacts summary:has-text("新增聯絡人")')
        await page.fill('#tl-contacts input[placeholder="例：王小明"]', '林小華')
        await page.fill('#tl-contacts input[placeholder^="例：配偶"]', '家人')
        await page.fill('#tl-contacts input[type=tel]', '+886-912-345-678')
        await page.click('#tl-contacts form button[type=submit]'); await page.wait_for_timeout(400)
        ct = await page.get_attribute('#tl-contacts .contact a', 'href')
        check('新增聯絡人後可一鍵撥打', ct == 'tel:+886912345678', str(ct))

        # 匯率
        ok = await wait_true(page, "() => !document.querySelector('#fx-box .fx-input')?.disabled")
        check('連網時自動下載匯率（以家鄉 TWD 為基準）', ok and fx_hits and fx_hits[0].endswith('/v6/latest/TWD'), str(fx_hits))
        curs = await page.locator('#fx-box .fx-cur strong').all_inner_texts()
        check('幣別自動為 EUR、HUF、TWD', curs == ['EUR', 'HUF', 'TWD'], str(curs))
        await page.fill('#fx-box .fx-input >> nth=0', '10'); await page.dispatch_event('#fx-box .fx-input >> nth=0', 'input')
        vals = await page.eval_on_selector_all('#fx-box .fx-input', 'els => els.map(e => e.value)')
        check('10 EUR ≈ 3632 HUF ≈ 366 TWD', vals[1] == '3632' and vals[2] == '366', str(vals))
        fxt = await page.inner_text('#fx-box')
        check('標示參考匯率、更新時間與 Exchange Rate API 來源', '參考匯率' in fxt and 'Rates By Exchange Rate API' in fxt and '2026/11/7' in fxt, fxt[-120:])
        await page.screenshot(path=f'{SHOTS}/62-fx.png')

        # 花費：從停靠點卡片記一筆
        await page.goto(BASE + '#today'); await page.wait_for_selector('.today-view')
        await page.select_option('.date-select', '2026-11-13'); await page.wait_for_timeout(200)
        await page.click('.next-card summary:has-text("備援與編輯")')
        await page.click('.next-card button:has-text("記一筆花費")'); await page.wait_for_selector('.expense-form')
        cur = await page.input_value('.expense-form select >> nth=0')
        check('從布達佩斯停靠點記帳：預設幣別 HUF、帶入日期與停靠點', cur == 'HUF' and await page.input_value('.expense-form select >> nth=1') == '2026-11-13'
              and (await page.locator('.expense-form select >> nth=2 >> option:checked').inner_text()) == '漁人堡', cur)
        await page.fill('.amount-input', '1200'); await page.fill('.expense-form input[placeholder^="例：午餐"]', '門票')
        await page.click('.expense-form .seg:has-text("門票")')
        await page.click('.expense-form button[type=submit]'); await page.wait_for_selector('.tools-view')
        # 工具頁直接記一筆（EUR，刷卡）
        await page.click('#tl-expense button:has-text("記一筆")'); await page.wait_for_selector('.expense-form')
        await page.select_option('.expense-form select >> nth=0', 'EUR')
        await page.fill('.amount-input', '12.5'); await page.fill('.expense-form input[placeholder^="例：午餐"]', '午餐')
        await page.click('.expense-form .seg:has-text("刷卡")')
        await page.click('.expense-form button[type=submit]'); await page.wait_for_selector('.tools-view')
        exp = await page.inner_text('#tl-expense')
        check('合計換算成新臺幣（1200 HUF + 12.5 EUR ≈ 578 TWD）', '合計約 578 TWD' in exp, exp[:160])
        check('依日期列出', '11/13' in exp and '門票' in exp and '午餐' in exp)
        await page.screenshot(path=f'{SHOTS}/63-expenses.png', full_page=True)

        # 匯出 Excel
        async with page.expect_download() as dl:
            await page.evaluate("() => { navigator.canShare = undefined; }")
            await page.click('#tl-expense button:has-text("匯出 Excel")')
        d = await dl.value
        data = open(await d.path(), 'rb').read()
        z = zipfile.ZipFile(io.BytesIO(data))
        s1 = z.read('xl/worksheets/sheet1.xml').decode()
        check('匯出 .xlsx：含明細與每日合計分頁', d.suggested_filename.endswith('.xlsx') and 'xl/worksheets/sheet2.xml' in z.namelist() and '門票' in s1 and '1200' in s1, d.suggested_filename)
        try:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(data))
            check('openpyxl 可正常開啟', wb.sheetnames == ['花費明細', '每日合計'] and wb['花費明細']['F2'].value in (1200, 12.5), str(wb.sheetnames))
        except ImportError:
            pass

        # 編輯與刪除（復原）
        await page.click('#tl-expense .exp-item:has-text("午餐")'); await page.wait_for_selector('.expense-form')
        check('編輯時保留原資料', await page.input_value('.amount-input') == '12.5')
        await page.click('.expense-form button:has-text("刪除這筆花費")'); await page.wait_for_selector('.tools-view')
        check('刪除後只剩一筆', await page.locator('#tl-expense .exp-item').count() == 1)
        await page.click('.toast-action'); await page.wait_for_timeout(400)
        await page.evaluate("() => location.hash = '#tools'"); await page.wait_for_timeout(300)
        check('復原刪除', await page.locator('#tl-expense .exp-item').count() == 2)

        # 備份含花費與聯絡人；分享範本不含
        async with page.expect_download() as dl2:
            await page.goto(BASE + '#app'); await page.wait_for_selector('.view')
            await page.evaluate("() => { navigator.canShare = undefined; }")
            await page.click('button:has-text("完整備份") >> nth=0')
        bk = json.loads(open(await (await dl2.value).path(), encoding='utf-8').read())
        check('完整備份含花費與聯絡人', len(bk.get('expenses', [])) == 2 and bk['contacts']['people'][0]['name'] == '林小華')
        await page.goto(BASE + '#settings'); await page.wait_for_selector('.settings-view')
        async with page.expect_download() as dl3:
            await page.evaluate("() => { navigator.canShare = undefined; }")
            await page.click('button:has-text("匯出分享範本")')
        tp = open(await (await dl3.value).path(), encoding='utf-8').read()
        check('分享範本不含花費與聯絡人', '林小華' not in tp and 'expenses' not in tp and '+886-912' not in tp)

        # 離線：重新載入後匯率仍可用
        await ctx.set_offline(True)
        await page.goto(BASE + '#tools'); await page.wait_for_selector('.tools-view')
        await page.wait_for_timeout(500)
        check('離線時沿用快取匯率', not await page.locator('#fx-box .fx-input >> nth=0').is_disabled())
        await ctx.set_offline(False)

        # 深色模式截圖
        await page.evaluate("() => { localStorage.setItem('tc-theme','dark'); }")
        await page.reload(); await page.wait_for_selector('.tools-view')
        await page.screenshot(path=f'{SHOTS}/64-tools-dark.png')
        check('沒有 JS 錯誤', not errs, str(errs[:3]))
        await b.close()
    bad = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(bad)}/{len(results)} passed')
    sys.exit(1 if bad else 0)
asyncio.run(main())
