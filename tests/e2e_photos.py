# 參考照片端對端測試：以攔截請求模擬維基百科，不連真實網路
# 執行：先 npm run serve，再 python3 tests/e2e_photos.py ./screenshots
import asyncio, base64, json, os, sys
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
BASE = os.environ.get('BASE', 'http://localhost:8080/')
SHOTS = sys.argv[1] if len(sys.argv) > 1 else './screenshots'
os.makedirs(SHOTS, exist_ok=True)
CHROME = os.environ.get('CHROME')
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, info)

# 測試用小圖（400x300 PNG，虛構建築）
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAZAAAAEsCAIAAABi1XKVAAAECElEQVR42u3bsbGCQBSG0YtDMcQUYR1UsMVsBVRETDkG5kbA+M+ek77kcZ37zerq9G57ASR4GQEgWACCBQgWgGABCBYgWACCBSBYgGABCBaAYAGCBSBYAIIFCBaAYAEIFiBYAIIFIFiAYAEIFoBgAYIFIFgAggUIFoBgAYIFN1iPbggIFjG10iwEi6SzlWYhWCS9E9QsLjQbAXd/aPX907E2U8IJi4yP2B21ECySLgQ1C8Ei6esLmoVgkfRlK81CsEj6aqhmUW4JCfoWu6tDnLAI+82NoxaCRdIvBDULwSLp98yahWCR1BTNQrBIqolmUW4JCYqIq0OcsAg78jhqIVgkVUOzECySeqFZCBZJpdAsBIukRmgW5ZaQoDS4OsQJi7CDjKMWgkVSCzQLwVKr7r9FsLD//mcEi+E3X7PKLSFSFfcIrg6dsFArz4JgYcM9EYLF4LutWYKFrfZ0CBb22TNSbgkZfo1dHTphoVaeGsHC3np2BAsbawKChV01BwQLW2oalFtCy4mrQycs1Mp8ECxsoykhWPYQsxIsbKCJIVjYPXOj3BJaOVwdOmGhViaJYGHHzBPBsl2YqmBhr8wWwbJRhmDCuCW0SLg6dMJCrcwcwbI5mLxgYWcwf8HCtngVECx7gtei3BJiPXB16ISFWnl1ECz7gNfIW0Ie8/sdx94WI3rG1k9DcMICECxAsAAEC0CwAMECECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLADBAgQLQLAABAsQLADBAgQLQLAABAsQLADBAhAsQLAABAtAsADBAhAsAMECBAtAsAAECxAsAMECECxAsAAEC0CwAMECECwAwQIEC0CwAAQLECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLADBAgQLQLAABAsQLADBAhAsQLAABAtAsADBAhAsAMECBAtAsAAECxAsAMECBAtAsAAECxAsAMECECxAsAAEC0CwAMECECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLADBAgQLQLAABAsQLADBAgQLQLAABAsQLADBAhAsQLAABAtAsADBAhAsAMECBAtAsAAECxAsAMECECxAsAAEC0CwAMECECwAwQIEC0CwAAQLECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLADBAgQLQLAABAsQLADBAhAsQLAABAtAsADBAhAsAMECBAtAsADBMgJAsAAuNhvB/9v6aQjghAUIFoBgAYIFIFgAggUIFoBgAQgWIFgAggUgWIBgAQgWgGABggUgWACCBQgWgGABCBYgWACCBSBYgGABCBaAYAGCBSBYAIIFCBaAYAGCBSBYAIIFCBaAYAEIFjCMD63y1krx+FLbAAAAAElFTkSuQmCC')
wiki_hits = []

def page_for(q):
    name = q.split(' ')[0] if q else ''
    if not name or name.startswith('示範'):
        return {'query': {}}
    t = name
    return {'query': {'pages': [{'title': t, 'index': 1, 'pageimage': f'{t}.jpg',
        'thumbnail': {'source': f'https://upload.wikimedia.org/thumb/{t}.png', 'width': 400, 'height': 300}}]}}

async def route_wiki(route):
    url = route.request.url
    wiki_hits.append(url)
    u = urlparse(url); qs = parse_qs(u.query)
    headers = {'Access-Control-Allow-Origin': '*'}
    if u.hostname == 'upload.wikimedia.org':
        return await route.fulfill(status=200, body=PNG, headers={**headers, 'Content-Type': 'image/png'})
    if u.hostname == 'commons.wikimedia.org':
        body = {'query': {'pages': [{'imageinfo': [{'thumburl': 'https://upload.wikimedia.org/thumb/x.png',
            'descriptionurl': 'https://commons.wikimedia.org/wiki/File:x.png',
            'extmetadata': {'Artist': {'value': '<b>Test Author</b>'}, 'LicenseShortName': {'value': 'CC BY-SA 4.0'}, 'LicenseUrl': {'value': 'https://creativecommons.org/licenses/by-sa/4.0'}}}]}]}}
        return await route.fulfill(status=200, body=json.dumps(body), headers={**headers, 'Content-Type': 'application/json'})
    q = (qs.get('gsrsearch') or [''])[0]
    return await route.fulfill(status=200, body=json.dumps(page_for(q)), headers={**headers, 'Content-Type': 'application/json'})

async def main():
    async with async_playwright() as p:
        kw = {'args': ['--no-sandbox']}
        if CHROME: kw['executable_path'] = CHROME
        b = await p.chromium.launch(**kw)
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        await ctx.route('https://*.wikipedia.org/**', route_wiki)
        await ctx.route('https://*.wikimedia.org/**', route_wiki)
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await page.goto(BASE); await page.wait_for_selector('.welcome')
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller !== null', timeout=10000)
        await page.click('text=先看看示範旅程'); await page.wait_for_selector('.next-card')
        for s in ['.tab:has-text("全部日期")', '.tab:has-text("編輯行程")', '.tab:has-text("今天")']:
            await page.click(s); await page.wait_for_timeout(200)
        check('預設關閉：瀏覽時沒有任何維基百科請求', len(wiki_hits) == 0, str(len(wiki_hits)))
        check('預設關閉：卡片上沒有照片', await page.locator('.photo').count() == 0)

        # 開啟並預先下載
        await page.goto(BASE + '#app'); await page.wait_for_selector('.settings-view')
        await page.click('label.check:has-text("顯示參考照片") input')
        await page.wait_for_selector('text=預先下載所有旅程的照片')
        check('只開啟顯示、尚未下載：仍沒有請求', len(wiki_hits) == 0)
        await page.click('text=預先下載所有旅程的照片')
        await page.wait_for_selector('.toast.show:has-text("縮圖下載完成")', timeout=20000)
        toast = await page.inner_text('.toast')
        check('預先下載完成', '縮圖下載完成' in toast, toast.replace('\n', ' '))
        await page.wait_for_timeout(500)
        stats = await page.inner_text('#photo-stats')
        check('本機已保存照片', '已保存' in stats and '已保存 0 張' not in stats, stats)
        await page.screenshot(path=f'{SHOTS}/20-photo-settings.png', full_page=True)

        # 今天頁顯示側邊縮圖，點擊放大並顯示授權
        await page.goto(BASE + '#today'); await page.wait_for_selector('.next-card')
        await page.wait_for_function("document.querySelector('.next-card .photo img') && document.querySelector('.next-card .photo img').src.startsWith('blob:')", timeout=5000)
        w = await page.evaluate("new Promise(r => { const i = document.querySelector('.next-card .photo img'); if (i.complete) r(i.naturalWidth); else i.onload = () => r(i.naturalWidth); })")
        check('下一站顯示照片（來自本機快取，且圖片可解碼）', w == 400, str(w))
        await page.screenshot(path=f'{SHOTS}/21-photo-side.png')
        await page.click('.next-card .photo-btn')
        cap = await page.inner_text('.next-card figcaption')
        check('放大後顯示作者與授權', 'Test Author' in cap and 'CC BY-SA 4.0' in cap, cap.replace('\n', ' '))
        await page.screenshot(path=f'{SHOTS}/22-photo-wide.png')

        # 離線重開：照片仍可顯示，且不發出新請求
        n_before = len(wiki_hits)
        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_selector('.next-card')
        await page.wait_for_function("document.querySelector('.next-card .photo img') && document.querySelector('.next-card .photo img').src.startsWith('blob:')", timeout=5000)
        check('離線時照片仍可顯示', True)
        await ctx.set_offline(False)
        await page.reload(); await page.wait_for_selector('.next-card'); await page.wait_for_timeout(800)
        check('未允許即時下載：重新開啟不會發出請求', len(wiki_hits) == n_before, f'{n_before} -> {len(wiki_hits)}')

        # 不是這張 → 隱藏 → 復原
        await page.click('.next-card .photo-btn')
        await page.click('.next-card button:has-text("不是這張")')
        await page.wait_for_selector('.toast.show:has-text("已隱藏")')
        check('「不是這張」後隱藏', await page.locator('.next-card .photo').count() == 0)
        await page.click('.toast-action'); await page.wait_for_timeout(400)
        check('復原後照片回來', await page.locator('.next-card .photo').count() == 1)

        # 交通類不查；缺名稱城市的示範點沒有照片也不出錯
        check('無 JS 錯誤', not errors, '; '.join(errors))
        await b.close()
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')
    sys.exit(1 if fails else 0)
asyncio.run(main())
