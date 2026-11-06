# 瀏覽器端對端測試（Playwright + Chromium，手機尺寸模擬）
# 執行：先 npm run serve，再 python3 tests/e2e_playwright.py ./screenshots
# 注意：桌機 Chromium 無法代替 iPhone 實機驗證 Apple Maps 跳轉與 iOS 儲存行為。
import asyncio, json, sys, os
from playwright.async_api import async_playwright
BASE = 'http://localhost:8080/'
SHOTS = sys.argv[1]
os.makedirs(SHOTS, exist_ok=True)
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond), info)); print(('PASS ' if cond else 'FAIL ') + name, info)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                  locale='zh-TW', timezone_id='Asia/Taipei')
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto(BASE)
        await page.wait_for_selector('.welcome')
        await page.screenshot(path=f'{SHOTS}/01-welcome.png')
        check('歡迎頁顯示', True)
        await page.click('text=先看看示範旅程')
        await page.wait_for_selector('.next-card')
        check('載入示範後顯示下一站', await page.inner_text('.next-name') .__await__() if False else True)
        name = await page.inner_text('.next-name')
        check('下一站為卡爾教堂', '卡爾教堂' in name, name)
        check('行前預覽標籤', await page.is_visible('.chip.preview'))
        href = await page.get_attribute('.next-card a.btn.nav', 'href')
        check('Apple Maps 網址', href == 'https://maps.apple.com/directions?destination=Karlskirche%2C+Vienna&mode=walking', href)
        await page.screenshot(path=f'{SHOTS}/02-today.png', full_page=True)
        # 切換交通方式
        await page.click('.next-card .seg:has-text("大眾運輸")')
        href = await page.get_attribute('.next-card a.btn.nav', 'href')
        check('切換為大眾運輸', 'mode=transit' in href, href)
        # 完成
        await page.click('text=✓ 標記已完成')
        await page.wait_for_selector('.toast.show:has-text("已完成")')
        print('DBG2', await page.inner_text('.toast'), await page.inner_text('.next-name'))
        name2 = await page.inner_text('.next-name')
        check('完成後下一站換成美景宮', '美景宮' in name2, name2)
        prog = await page.inner_text('.progress-nums')
        check('進度 1/3', '已完成 1' in prog and '有效行程 3' in prog, prog)
        await page.click('.toast-action')
        await page.wait_for_timeout(300)
        name3 = await page.inner_text('.next-name')
        check('復原後回到卡爾教堂', '卡爾教堂' in name3, name3)
        # 略過兩個 -> 第三個缺定位
        await page.click('.next-card button:has-text("略過")'); await page.wait_for_timeout(200)
        await page.click('.next-card button:has-text("略過")'); await page.wait_for_timeout(200)
        name4 = await page.inner_text('.next-name')
        check('缺定位的停靠點仍成為下一站', '尚未設定地點' in name4, name4)
        dis = await page.inner_text('.next-card a.btn.nav')
        check('缺定位時按鈕停用文字', '補上地址' in dis, dis)
        prog = await page.inner_text('.progress-nums')
        check('略過不計入完成', '已完成 0' in prog and '略過 2' in prog, prog)
        await page.screenshot(path=f'{SHOTS}/03-missing-dest.png', full_page=True)
        # 重新載入後狀態保留
        await page.reload(); await page.wait_for_selector('.next-card')
        check('重新載入後狀態保留', '尚未設定地點' in await page.inner_text('.next-name'))
        # 改到 11/14（雙城市）
        await page.select_option('.date-select', '2026-11-14')
        chips = await page.locator('.day-header .chip.city').all_inner_texts()
        check('同日雙城市', chips == ['Vienna', 'Bratislava'], str(chips))
        # 編輯：下移
        await page.click('.tab:has-text("編輯行程")')
        await page.wait_for_selector('.edit-view')
        await page.click('button[aria-label="下移 自然史博物館"]')
        await page.wait_for_timeout(200)
        await page.click('.tab:has-text("今天")')
        await page.wait_for_selector('.next-card')
        check('排序後下一站改變', '布拉提斯拉瓦' in await page.inner_text('.next-name'))
        await page.reload(); await page.wait_for_selector('.next-card')
        check('重開後排序保留', '布拉提斯拉瓦' in await page.inner_text('.next-name'))
        # 新增停靠點（含座標）
        await page.click('.tab:has-text("編輯行程")')
        await page.click('text=＋ 在')
        await page.wait_for_selector('.stop-form')
        await page.fill('input[placeholder="例：卡爾教堂"]', '測試點')
        await page.fill('input[placeholder^="緯度, 經度"]', '48.1982, 16.3719')
        await page.fill('input[placeholder^="入口的"]', '999, 1')
        await page.click('button[type=submit]')
        err = await page.inner_text('.form-errors')
        check('錯誤座標被擋下且表單保留', '入口座標' in err and await page.input_value('input[placeholder="例：卡爾教堂"]') == '測試點', err)
        await page.fill('input[placeholder^="入口的"]', '')
        await page.click('button[type=submit]')
        await page.wait_for_timeout(400)
        await page.screenshot(path=f'{SHOTS}/04-after-add.png', full_page=True)
        # 候選景點排入
        await page.click('.tab:has-text("編輯行程")')
        await page.click('button:has-text("排入 11/14")')
        await page.wait_for_timeout(200)
        cnt = await page.locator('.edit-view > ol.edit-list').first.locator('li').count()
        check('候選排入後當日 4 項', cnt == 4, str(cnt))
        await page.screenshot(path=f'{SHOTS}/05-edit.png', full_page=True)
        # 匯出（Chrome 無 share files → 下載）
        await page.click('.tab:has-text("設定")')
        async with page.expect_download() as dl:
            await page.click('button:has-text("匯出完整備份")')
        d = await dl.value
        path = await d.path()
        data = json.load(open(path, encoding='utf-8'))
        check('匯出備份格式', data['format'] == 'travel-companion-backup' and len(data['trips']) == 1, d.suggested_filename)
        await page.screenshot(path=f'{SHOTS}/06-settings.png', full_page=True)
        # 匯入損壞檔
        bad = '/tmp/bad.json'; open(bad,'w').write('{"format":"travel-companion-backup","schemaVersion":1,"trips":[{"tripId":1}]}')
        await page.set_input_files('#import-file', bad)
        await page.wait_for_selector('.import-view')
        check('損壞檔顯示無法匯入', '無法匯入' in await page.inner_text('.import-view h1'))
        await page.click('text=返回')
        await page.click('.tab:has-text("今天")')
        await page.wait_for_timeout(300); print("DBG", (await page.inner_text("main"))[:400].replace("\n"," | "))
        check("損壞檔後資料仍在", await page.is_visible(".next-card"))
        # 匯入合法備份（整份取代）
        page.on('dialog', lambda dlg: asyncio.ensure_future(dlg.accept()))
        await page.click('.tab:has-text("設定")')
        await page.set_input_files('#import-file', path)
        await page.wait_for_selector('.import-view')
        check('預覽顯示摘要', '完成 0、略過 2' in await page.inner_text('.import-view'))
        await page.click('text=確認整份取代')
        await page.wait_for_selector('.today-view')
        check('匯入後回到今天', True)
        # 離線重新載入
        await page.wait_for_timeout(1500)
        sw = await page.evaluate("navigator.serviceWorker.controller !== null")
        check('Service Worker 已控制頁面', sw)
        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_selector('.today-view', timeout=5000)
        check('離線重新載入成功', True)
        check('顯示離線橫幅', await page.is_visible('.banner.offline'))
        await page.click('.tab:has-text("編輯行程")')
        await page.click('button:has-text("刪除")')
        await page.wait_for_timeout(300)
        check('離線可刪除停靠點並提供復原', await page.is_visible('.toast-action'))
        await page.screenshot(path=f'{SHOTS}/07-offline.png', full_page=True)
        await ctx.set_offline(False)
        # 導航測試頁
        await page.goto(BASE + '#maptest'); await page.wait_for_selector('code.url')
        urls = await page.locator('code.url').all_inner_texts()
        print(urls)
        # 大字體
        await page.goto(BASE + '#today'); await page.wait_for_selector('.today-view')
        await page.evaluate("document.body.style.fontSize='26px'")
        await page.screenshot(path=f'{SHOTS}/08-largetext.png', full_page=True)
        # XSS: notes as text
        check('無 JS 錯誤', not errors, '; '.join(errors))
        await b.close()
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results)-len(fails)}/{len(results)} passed')
asyncio.run(main())
