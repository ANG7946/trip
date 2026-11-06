# 自己的照片：單張上傳、批次指派（依檔名／依順序）、表單不被清除、備份還原、資料庫 v1→v2 升級
# 執行：先 npm run serve，再 python3 tests/e2e_userphotos.py ./screenshots（需要 Pillow）
import asyncio, json, os, sys, tempfile
from PIL import Image, ImageDraw
from playwright.async_api import async_playwright
BASE = os.environ.get('BASE', 'http://localhost:8080/')
SHOTS = sys.argv[1] if len(sys.argv) > 1 else './screenshots'
os.makedirs(SHOTS, exist_ok=True)
CHROME = os.environ.get('CHROME')
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, info)

TMP = tempfile.mkdtemp()
def make_img(name, color, size=(2400, 1800)):
    p = os.path.join(TMP, name)
    im = Image.new('RGB', size, color); d = ImageDraw.Draw(im)
    d.rectangle([size[0]//3, size[1]//4, size[0]*2//3, size[1]*3//4], fill=(240, 235, 220))
    im.save(p, quality=95) if p.lower().endswith('.jpg') else im.save(p)
    return p

async def new_ctx(b):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = await ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    return ctx, page, errs

async def choose(page, selector, files):
    async with page.expect_file_chooser() as fc:
        await page.click(selector)
    await (await fc.value).set_files(files)

async def main():
    single = make_img('IMG_9001.jpg', (60, 100, 150))
    batch = [make_img('Halászbástya.png', (150, 80, 60)), make_img('IMG_0001.jpg', (40, 120, 70)), make_img('11-14_1.jpg', (120, 60, 140))]
    form_img = make_img('form.jpg', (90, 90, 90))
    async with async_playwright() as p:
        kw = {'args': ['--no-sandbox']}
        if CHROME: kw['executable_path'] = CHROME
        b = await p.chromium.launch(**kw)

        # ---- 資料庫 v1 → v2 升級：既有行程不受影響 ----
        ctx0, pg0, errs0 = await new_ctx(b)
        await pg0.goto(BASE + 'manifest.webmanifest')
        demo = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'demo-trip.json'), encoding='utf-8').read()
        await pg0.evaluate("""(demo) => new Promise((res, rej) => {
          const r = indexedDB.open('travel-companion', 1);
          r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('trips', { keyPath: 'tripId' }); db.createObjectStore('meta', { keyPath: 'key' }); };
          r.onsuccess = () => { const db = r.result; const t = JSON.parse(demo); t.title = 'v1 舊資料'; const tx = db.transaction('trips', 'readwrite'); tx.objectStore('trips').put(t); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
          r.onerror = () => rej(r.error);
        })""", demo)
        await pg0.goto(BASE); await pg0.wait_for_selector('.today-view, .trips-view', timeout=10000)
        await pg0.goto(BASE + '#trips'); await pg0.wait_for_selector('.trips-view')
        ver = await pg0.evaluate("new Promise(r => { const q = indexedDB.open('travel-companion'); q.onsuccess = () => { const v = q.result.version; const has = q.result.objectStoreNames.contains('images'); q.result.close(); r([v, has]); }; })")
        check('資料庫升級為 v2 並新增照片儲存區', ver == [2, True], str(ver))
        check('升級後既有行程仍在', 'v1 舊資料' in await pg0.inner_text('.trips-view'))
        check('升級過程無錯誤', not errs0, '; '.join(errs0))
        await ctx0.close()

        # ---- 主要流程 ----
        ctx, page, errs = await new_ctx(b)
        await page.goto(BASE); await page.wait_for_selector('.welcome')
        await page.click('text=先看看示範旅程'); await page.wait_for_selector('.next-card')
        await page.goto(BASE + '#photos'); await page.wait_for_selector('.photos-view')
        check('照片整理頁列出停靠點', await page.locator('.pm-row').count() >= 6)

        # 單張
        await choose(page, '.pm-row >> nth=0 >> button:has-text("選照片")', [single])
        await page.wait_for_selector('.toast.show:has-text("已加入照片")')
        t = await page.inner_text('.toast')
        kb = int(''.join(ch for ch in t.split('約')[1].split('KB')[0] if ch.isdigit()))
        check('單張上傳並自動縮小（原圖 2400x1800）', kb < 200, f'{kb} KB')
        dims = await page.evaluate("new Promise(r => { const i = document.querySelector('.pm-row img.pm-thumb'); const f = () => r([i.naturalWidth, i.naturalHeight]); i.complete ? f() : i.onload = f; })")
        check('縮圖長邊 640px', max(dims) == 640, str(dims))

        await page.goto(BASE + '#today'); await page.wait_for_selector('.next-card')
        src = await page.get_attribute('.next-card .photo img', 'src')
        check('下一站顯示我的照片（不需開啟維基百科功能、不連網）', bool(src) and src.startswith('data:image/jpeg'))

        # 批次
        await page.goto(BASE + '#photos'); await page.wait_for_selector('.photos-view')
        await choose(page, 'button:has-text("選取多張照片")', batch)
        await page.wait_for_selector('.assign-view')
        items = await page.locator('.assign-item').all()
        info = []
        for it in items:
            sel = it.locator('select')
            label = await sel.evaluate('s => s.options[s.selectedIndex].text')
            chip = await it.locator('.chip').inner_text()
            info.append((label, chip))
        print('   assign:', info)
        check('依檔名配對：Halászbástya.png → 漁人堡', '漁人堡' in info[0][0] and info[0][1] == '依檔名配對')
        check('依檔名配對：11-14_1.jpg → 11/14 第 1 站', '11/14' in info[2][0] and '#1' in info[2][0] and info[2][1] == '依檔名配對')
        check('iPhone 檔名依選取順序指派', info[1][1] == '依選取順序' and info[1][0] != '（不使用這張）')
        await page.screenshot(path=f'{SHOTS}/30-assign.png', full_page=True)
        await page.click('button:has-text("確認加入")')
        await page.wait_for_selector('.toast.show:has-text("已加入 3 張")')
        sub = await page.inner_text('.photos-view .sub')
        check('批次加入後共 4 張', '自己的照片 4 張' in sub, sub)
        await page.screenshot(path=f'{SHOTS}/31-photos.png', full_page=True)

        # 表單：未儲存的欄位不會因上傳照片被清除
        await page.goto(BASE + '#edit'); await page.wait_for_selector('.edit-view')
        await page.click('.edit-view .edit-list >> nth=0 >> a:has-text("編輯") >> nth=0')
        await page.wait_for_selector('.stop-form')
        await page.fill('textarea[placeholder^="純文字備註"]', '尚未儲存的備註')
        await choose(page, '#photo-fs button:has-text("我的照片")', [form_img])
        await page.wait_for_selector('.toast.show:has-text("已加入照片")')
        check('上傳照片後，尚未儲存的備註仍在', await page.input_value('textarea[placeholder^="純文字備註"]') == '尚未儲存的備註')

        # 備份（含／不含照片）
        await page.goto(BASE + '#app'); await page.wait_for_selector('#import-file')
        async with page.expect_download() as dl:
            await page.click('button:has-text("匯出完整備份（含照片）")')
        full_path = os.path.join(TMP, 'full-backup.json')
        await (await dl.value).save_as(full_path)
        full = json.load(open(full_path, encoding='utf-8'))
        check('完整備份含照片（僅被引用者）', len(full.get('images', [])) == 4, str(len(full.get('images', []))))
        async with page.expect_download() as dl2:
            await page.click('button:has-text("匯出備份（不含照片")')
        lite = json.load(open(await (await dl2.value).path(), encoding='utf-8'))
        check('不含照片的備份沒有 images', 'images' not in lite)
        await page.goto(BASE + '#settings'); await page.wait_for_selector('.settings-view')
        async with page.expect_download() as dl3:
            await page.click('button:has-text("匯出分享範本")')
        tpl = json.load(open(await (await dl3.value).path(), encoding='utf-8'))
        check('分享範本不含自己的照片', all(s.get('userPhoto') is None for s in tpl['stops']) and 'images' not in tpl)
        check('主要流程無錯誤', not errs, '; '.join(errs))
        await ctx.close()

        # 新手機還原
        ctx2, pg2, errs2 = await new_ctx(b)
        await pg2.goto(BASE + '#trips'); await pg2.wait_for_selector('.trips-view')
        await pg2.set_input_files('#trips-import', full_path); await pg2.wait_for_selector('.import-view')
        check('還原預覽顯示照片數', '含 4 張自己的照片' in await pg2.inner_text('.import-view'))
        await pg2.click('text=確認整份取代'); await pg2.wait_for_selector('.today-view')
        await pg2.goto(BASE + '#photos'); await pg2.wait_for_selector('.photos-view')
        check('還原後照片都在', '自己的照片 4 張' in await pg2.inner_text('.photos-view .sub'))
        check('還原流程無錯誤', not errs2, '; '.join(errs2))
        await b.close()
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')
    sys.exit(1 if fails else 0)
asyncio.run(main())
