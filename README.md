# 旅程導航助手（Travel Companion）

這是給 iPhone 用的 PWA，作為「已規劃行程的執行介面」。使用流程是：從主畫面開啟 → 看今天的下一站 → **一按開啟 Apple Maps 路線** → 返回 App 手動標記「已完成」或「略過」。

- 不需要帳號、後端、資料庫或 API 金鑰。
- 不追蹤 GPS，也不做分析統計。
- 行程只存在手機的 IndexedDB 裡；JSON 備份與還原是必要的保險。
- 支援多趟旅程，時區依各旅程設定，可以分享範本給別人使用。
- 原生 HTML／CSS／JavaScript（ES modules），**不需要建置步驟**，直接放上 GitHub Pages 就能用。

> 開發規格：`Central_Europe_Travel_Companion_Development_Spec_v1.0`（P0 範圍）。架構由 Vite/React 改為零建置的原生實作，原因是時程短、降低部署風險。P0 驗收能力全部保留。

---

## 1. 檔案結構

```text
index.html               App 外殼（含 CSP，禁止 inline script／style）
manifest.webmanifest     PWA 設定（相對路徑，適用 GitHub Pages 子路徑）
sw.js                    Service Worker：只快取網站資產
css/styles.css           手機直向優先、安全區域、深淺色
js/core.js               純邏輯：資料模型、驗證、地圖網址、時區、下一站／進度（不依賴 DOM）
js/db.js                 IndexedDB 存取層（所有讀寫都經由此處）
js/csv.js                表格轉換（CSV／Excel 共用規則）、CSV 解析（UTF-8／Big5）、AI 提示詞
js/xlsx.js               Excel（.xlsx）讀取：不依賴外部套件，以 DecompressionStream 解壓縮
js/photos.js             參考照片：維基百科查詢、配對、授權資訊、本機快取
js/weather.js            天氣預報（Open-Meteo）
js/images.js             自己的照片：縮圖（長邊 640px JPEG）、批次指派（依檔名／依順序）
js/app.js                介面與互動
js/theme-boot.js         日夜模式：首次繪製前套用（一般腳本）
icons/                   PWA 圖示
data/demo-trip.json      示範旅程（僅公開景點，可公開）
data/trip-template.xlsx  Excel 範本：「行程」分頁（下拉選單）＋「填寫說明」分頁
data/trip-template.csv   CSV 範本（與 Excel 範本欄名、範例完全相同）
data/trip-template.json  JSON 範本
data/ai-prompt.txt       給 AI 轉換行程用的提示詞
tests/core.test.mjs      邏輯單元測試（Node 內建 test runner）
tests/csv.test.mjs       CSV／AI JSON 匯入單元測試
tests/e2e_playwright.py  瀏覽器端對端測試（主要流程）
tests/xlsx.test.mjs      Excel 讀取單元測試（含 Excel 自動轉日期、LibreOffice 存檔）
tests/fixtures/          測試用 Excel 檔（虛構資料）
tests/e2e_import.py      瀏覽器端對端測試（匯入）
tests/photos.test.mjs    參考照片配對與查詢單元測試（模擬 API）
tests/e2e_photos.py      參考照片端對端測試（攔截請求模擬維基百科）
tests/images.test.mjs    自己的照片：檔名解析、批次指派、備份驗證
tests/e2e_userphotos.py  自己的照片端對端測試（含資料庫 v1→v2 升級、備份還原）
tests/clock.test.mjs     兩地時間單元測試
tests/e2e_clock_theme.py 兩地時間與日夜模式端對端測試
tests/weather.test.mjs   天氣單元測試
tests/e2e_weather.py     天氣端對端測試
tools/bump-version.mjs   發佈新版本時一次更新所有版本字串
tools/make-xlsx-template.py  由 CSV 範本產生 Excel 範本（需要 openpyxl）
private/                 私人行程（已列入 .gitignore，不會上傳）
```

## 2. 本機執行與測試

```bash
npm run serve            # = python3 -m http.server 8080，然後開 http://localhost:8080
npm test                 # 邏輯單元測試（需要 Node 18 以上）
python3 tests/e2e_playwright.py ./screenshots   # 需要 pip install playwright && playwright install chromium
```

Service Worker 只在 `https://` 或 `localhost` 下運作。

## 3. 部署到 GitHub Pages

1. 建立 repo（例如 `travel-companion`），把本資料夾內容推上去。**確認 `private/` 沒有被加入**：`git status` 裡不應出現 `private/` 底下的檔案。
2. 到 GitHub → Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main`，資料夾選 `/ (root)`。
3. 一兩分鐘後即可從 `https://<帳號>.github.io/travel-companion/` 開啟。
4. 所有路徑都是相對路徑，所以子路徑不必另外設定。manifest 的 `scope`／`start_url` 都是 `./`。

**自訂網域 `trip.tclin.tw`**

- repo 根目錄的 `CNAME` 檔內容為 `trip.tclin.tw`。
- DNS：在 tclin.tw 的 DNS 管理處新增 `CNAME`，主機名稱 `trip`，指向 `ang7946.github.io`。
- GitHub → Settings → Pages → Custom domain 填 `trip.tclin.tw`；憑證核發後，勾選 **Enforce HTTPS**。
- iPhone 的本機資料綁定網域。請直接以 `https://trip.tclin.tw/` 加入主畫面並匯入行程，不要用 github.io 網址，以免日後重新匯入。

**發佈新版本時**：執行 `node tools/bump-version.mjs 1.1.2`（換成新版本號），會一次更新資產網址的 `?v=`、Service Worker 快取名稱與 App 版本，避免瀏覽器或 CDN 混用新舊檔案。使用者開啟 App 後會看到「有新版本可用 → 重新載入」。IndexedDB 中的行程不會被動到。

## 4. 在 iPhone 上安裝與匯入私人行程

1. 用 **Safari** 開啟網址 → 分享 → **加入主畫面**。之後一律從主畫面圖示開啟，因為主畫面 App 與 Safari 分頁的資料可能分開保存。
2. 連網狀態下，從主畫面開啟一次，到「設定／備份」確認「離線網站資料：已就緒」。
3. 把私人行程 JSON（例如 `private/2026-central-europe-trip.json`）用 AirDrop 或 iCloud 雲碟傳到 iPhone 的「檔案」。
4. App →「設定／備份」→「匯入備份或行程檔…」→ 選檔 → 確認預覽 → 匯入。
5. 在 Apple Maps 內**自行下載**維也納、布達佩斯、布拉提斯拉瓦的離線地圖。
6. 開啟**飛航模式**，從主畫面重新開啟 App，確認仍能載入。

## 5. 建立行程的三種方式（也適用於分享給朋友）

App 內的「設定 → 查看說明與 AI 提示詞」（`#guide`）有完整說明，可直接把網址給朋友。

1. **App 內逐筆新增**：建立新旅程 → 編輯行程 → 新增停靠點。
2. **試算表（Excel 或 CSV）**：
   - **Excel 範本（建議）**：`trip-template.xlsx`。「行程」分頁的類型、交通方式、已確認地點都有下拉選單，日期、時間、座標欄預設為文字格式；「填寫說明」分頁附完整規則。存檔後直接匯入 .xlsx，不需要另存 CSV。App 優先讀取名為「行程」的分頁。
   - **CSV 範本**：`trip-template.csv`，給 Google 試算表、Numbers 使用者。也可以直接複製表格，到「貼上行程內容」貼上（Tab 分隔）。
   - 兩種範本欄名與規則完全相同，經過同一套檢查。修改範本時，請先改 `js/csv.js` 的 `TEMPLATE_ROWS` 並重新產生 CSV，再執行 `python3 tools/make-xlsx-template.py data/trip-template.csv data/trip-template.xlsx`。
   - Excel 若把日期、時間自動轉成序號，App 會換算回 `YYYY-MM-DD`、`HH:mm`。
   - 欄名支援中文或英文：日期、順序、城市、名稱、當地名稱、類型、開始時間、結束時間、地址、座標、入口座標、交通方式、已確認地點、參考網址、備註。
   - 編碼自動判斷：UTF-8（含 BOM）或 Big5（Windows 繁中 Excel 的一般 CSV）。
   - 日期接受 `2026-11-12`、`2026/11/12`；時間接受 `9:00`、`09:00:00`；類型與交通方式接受中文。
   - 匯入時可選「建立為新旅程」或「加入目前旅程」（只新增，不覆蓋）。
3. **AI 轉換**：複製提示詞給 ChatGPT／Claude／Gemini，貼上行程，再把 AI 回覆的 JSON 貼到「貼上行程內容」。
   - 單一旅程 JSON 只會自動補上**缺少的系統欄位**（id、狀態、時間戳、順序），不補任何旅遊資料；已存在但錯誤的值一律拒絕。
   - 匯入時以內容判斷 JSON 或 CSV，不依賴副檔名（iOS「檔案」有時會去掉副檔名）。

## 6. 景點參考照片（選用，預設關閉）

- 來源：英文維基百科條目的代表圖片（僅自由授權，`pilicense=free`），作者與授權取自 Wikimedia Commons；每張照片都顯示作者、授權與條目連結。
- 配對（v1.5.1 起）：**優先查當地語言的維基百科**（依城市判斷：維也納→德文、布達佩斯→匈牙利文、布拉提斯拉瓦→斯洛伐克文…；其次依原文特殊字母），以「當地名稱」搜尋，再查英文維基，最後以中文名稱查中文維基。有座標時先地理搜尋。
- **寧缺勿濫**：條目名稱必須與當地名稱或中文名稱吻合（完全相同、互相包含，或有共同關鍵字；museum、Schloss、Kirche 等通用字不算）才採用；整個城市的條目一律排除。找不到就不放照片。
- 「重新配對全部」：清除既有維基百科照片並重新搜尋；「不是這張」排除過的條目仍會略過，自己的照片不受影響。
- 流量：預設關閉、不發出任何請求。開啟後，以「預先下載所有旅程的照片」在 Wi‑Fi 下一次下載，存在 Cache Storage（`tc-photos-v1`），離線可看。「允許隨時自動下載」另行開關，預設關閉（iPhone 網頁 App 無法分辨 Wi‑Fi 與行動網路）。
- 隱私：開啟後維基百科會收到查詢的地點名稱。CSP 只開放 `*.wikipedia.org`（各語言版）、`commons.wikimedia.org`、`upload.wikimedia.org`、`thumb.wikimedia.org`。
- **v1.6.1 修正**：2026 年起維基百科 API 回傳的縮圖網址改用 `thumb.wikimedia.org`，舊版只接受 `upload.wikimedia.org`，導致幾乎所有結果被安全檢查丟棄。此問題於使用者電腦的瀏覽器以真實 API 驗證後修正；縮圖網址的 `utm_` 追蹤參數一併移除。名稱含「/」「，」等分隔（例：Hofburg / Heldenplatz）時拆成多個名稱搜尋與比對。
- 修正：照片下方「不是這張」可隱藏（可復原）；停靠點編輯頁可「重新搜尋（排除目前這張）」或移除。
- 照片資料（條目名稱、圖片網址、授權）存於停靠點的 `photo` 欄位，會隨備份與分享範本帶出；圖片本身不在備份內，需要時可重新下載。

### 自己的照片

- 每個停靠點可上傳一張自己的照片（停靠點編輯頁，或「旅程設定 → 照片整理」）。iPhone 可選相簿、拍照或檔案。
- 上傳時自動縮成長邊 640px 的 JPEG（每張約數十 KB），以 base64 存在 IndexedDB 的 `images`（資料庫 v2 新增）；原始照片留在相簿。
- 顯示優先順序：自己的照片 → 維基百科照片。自己的照片不受維基百科開關影響，也不需要網路。
- 批次：「照片整理 → 選取多張照片」。先依檔名配對（含地點名稱，或 `11-12_2`、`2026-11-12_2`、`1112-2`、`D1-2`），其餘依選取順序配給「尚無照片」的停靠點；確認前可逐張改指派，同一停靠點重複時會擋下。
- 備份：「匯出完整備份（含照片）」只帶出仍被引用的照片；「不含照片」版檔案較小，還原時保留手機中既有照片。分享範本一律不含自己的照片。
- 不再被引用的照片在啟動後與刪除旅程時自動清除（撤銷期間內不會清除）。
- **同一地點自動沿用**（v1.6.0）：地址相同、座標相距 30 公尺內，或「名稱（當地名稱或中文名稱）＋城市」相同的停靠點，視為同一地點（例如連住多晚的飯店）。只需在其中一站上傳，其他站自動顯示同一張（不另存副本）；某一站可上傳不同照片，或設定「這一站不顯示照片」（`userPhoto: { none: true }`）。維基百科批次下載也會讓同一地點共用查詢結果。

### 維基百科照片的修正（v1.5.0）

- 縮圖改用標準寬度 330px（非標準寬度常需現場產生，易被限流）；HTTP 429／5xx 稍候重試，再失敗改用 250px。
- 名稱搜尋依序嘗試：英文維基「當地名稱＋城市」→ 英文維基「當地名稱」→ 中文維基「中文名稱」。
- 批次下載後在設定頁顯示逐筆明細（成功／找不到條目／下載失敗與原因）；已有自己照片的停靠點略過。

### 兩地時間與日夜模式（v1.7.0）

- **兩地時間**：「今天」頁顯示「當地 HH:mm・家鄉 HH:mm（家鄉快 N 小時）」，跨日時在家鄉時間後標示「(+1)」或「(-1)」；每 30 秒與回到前景時更新，夏令時間自動處理。當地＝旅程時區；**家鄉時區在第一次開啟時記下手機時區**，之後固定（出國後 iPhone 會改為當地時間），可在「App 設定 → 外觀與時間」修改或關閉。時差為 0 時不顯示。
- **日夜模式**：跟隨系統（預設）／淺色／深色。「今天」頁有 ☾／☀︎ 快速切換。設定存於 `localStorage`（`tc-theme`，僅本機外觀偏好），由 `js/theme-boot.js` 在首次繪製前套用，避免閃爍；狀態列顏色（`theme-color`）同步變更。

### 天氣預報（v1.8.0）

- 來源：[Open-Meteo](https://open-meteo.com/)（免費、免金鑰，資料授權 CC BY 4.0，介面附來源連結）。回應格式已於 2026-11-07 以真實 API 驗證，測試使用該次真實回應（`tests/fixtures/open-meteo-vienna-2026-11-07.json`）。
- 「今天」頁依當天行程的城市各顯示一個標籤：「Vienna 🌧️ 4–8°C ☂︎33%」（降雨機率 10% 以上才顯示）；檢視日為今天時加「現在 N°」。
- 城市座標：當天該城市停靠點的座標 → 內建常見城市中心 → Open-Meteo 地名查詢（結果存本機）。一律取小數 2 位（約 1 公里），不傳送使用者位置或行程。
- 每城市每 3 小時最多下載一次（約數 KB），存於 IndexedDB；離線時顯示上次資料並註明時間。預報約 16 天，超出範圍的日子顯示「約兩週內才有預報」。
- **逐時預報（v1.9.0）**：點天氣標籤展開當日詳細——06–21 時每 3 小時一格（溫度、天氣、降雨機率；檢視今天時從目前時段起），以及日出、日落時間。資料與每日預報一起下載（全部約 13 KB），離線可看。資料來源與授權（Open-Meteo.com、CC BY 4.0）標示於詳細面板底部。舊格式快取會自動重抓。
- 可在「App 設定 → 外觀、時間與天氣」關閉；關閉後不發出任何請求。CSP 放行 `api.open-meteo.com`、`geocoding-api.open-meteo.com`。
- 同版調整：今天頁移除「家鄉快 N 小時」與長日期文字，僅保留兩地時間與跨日提示。

## 7. 資料格式（schemaVersion 1）

App 可匯入兩種檔案：

**完整備份**（由「匯出完整備份」產生，匯入時會「整份取代」手機中的所有資料）

```json
{ "format": "travel-companion-backup", "schemaVersion": 1, "exportedAt": "…", "trips": [ Trip, … ] }
```

**單一旅程／分享範本**（匯入時加入為新旅程；若 `tripId` 相同，則取代該旅程）

```json
{
  "schemaVersion": 1,
  "tripId": "uuid",
  "title": "2026 中歐旅行",
  "timeZone": "Europe/Vienna",
  "startDate": "2026-11-12",
  "endDate": "2026-11-19",
  "settings": { "defaultMode": "walking", "mapProvider": "apple", "appleLinkStyle": "unified" },
  "stops": [ Stop, … ]
}
```

**Stop**

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | 唯一 ID（UUID） |
| `date` | `YYYY-MM-DD` 或 `null` | 旅行當地日期；`null` 表示**候選景點** |
| `order` | number | 同日順序，由使用者決定，不依時間重排 |
| `city` | string | 可為空字串 |
| `title` | string | 必填 |
| `localName` | string／null | 當地語言原名；有填時，以名稱導航會優先使用原名 |
| `type` | enum | `attraction` `hotel` `conference` `station` `transfer` `meal` `other` |
| `startTime`／`endTime` | `HH:mm`／null | 僅供參考 |
| `address` | string／null | 完整地址 |
| `coordinates` | `{lat,lng}`／null | 地點座標 |
| `entranceCoordinates` | `{lat,lng}`／null | 入口座標（最優先） |
| `destinationConfirmed` | boolean | 是否已實際確認目的地 |
| `defaultMode` | enum | `walking` `transit` `driving` `cycling` |
| `notes` | string／null | 純文字，顯示時不解析 HTML |
| `referenceUrl` | string／null | 只接受 `https://` |
| `status` | enum | `pending` `completed` `skipped` |
| `completedAt`／`skippedAt` | ISO 時間／null | 只在對應狀態存在 |
| `updatedAt` | ISO 時間 | |

**導航目的地優先序**：入口座標 → 地點座標 → 地址 → 名稱＋城市。只有名稱＋城市時仍可導航，但會標示「定位待確認」。連名稱＋城市都沒有時，按鈕會停用。

**匯入檢查項目**：檔案大小、JSON 語法、`schemaVersion`、欄位型別、重複 ID、日期是否在旅程內、座標範圍、時間格式、網址協定、狀態與時間戳是否一致。任何一項不通過就拒絕匯入，**原資料不變**；寫入時使用單一交易。

## 8. Apple Maps 連結

| 設定 | 網址格式 | 備註 |
|---|---|---|
| 官方統一網址（預設） | `https://maps.apple.com/directions?destination=…&mode=walking` | iOS 18.4 以上 |
| 舊式網址 | `https://maps.apple.com/?daddr=…&dirflg=w` | 沒有自行車模式 |
| `maps://` | `maps://?daddr=…&dirflg=w` | 若連結停留在網頁內，可用這個格式直接開啟 App |
| Google 地圖 | `https://www.google.com/maps/dir/?api=1&destination=…&travelmode=walking` | 給 Android 使用者，或作為備援 |

- 導航按鈕是真實的 `<a href>`，點擊時不經過任何非同步等待，避免 iOS 判定為非使用者手勢。
- 不帶 `source`，由 Apple Maps 從目前位置規劃；不使用自動開始導航的參數。
- 開啟地圖**不會**改變完成狀態。

## 9. 資料遷移策略

- `js/core.js` 的 `SCHEMA_VERSION` 是資料內容版本；`js/db.js` 的 `DB_VERSION` 是 IndexedDB 結構版本。
- 讀取時一律經過 `migrateTrip()`：舊版本依序升級，只新增欄位或轉換格式，不刪除使用者資料。
- IndexedDB 的 `onupgradeneeded` 只新增 store，不刪除。
- 網站更新（Service Worker 換版）只更換 Cache Storage 的網站資產，不碰 IndexedDB。

## 10. 隱私檢查（每次部署前）

```bash
git status --ignored            # private/ 應顯示為 ignored
grep -ri "你的飯店名稱或其他私人關鍵字" --exclude-dir=private --exclude-dir=.git .
```

公開 repo 與 GitHub Pages 的內容等同公開資訊。真實行程只透過 iPhone 匯入。

## 11. 測試紀錄（開發端，2026-11-06）

**已自動測試**

- 單元測試 16 項全數通過：網址編碼（德文、匈牙利文、空格）、座標順序、入口座標優先、無目的地時不產生連結、舊式／maps:///Google 網址、旅行時區日期（臺灣與維也納跨日）、行前預覽、完成／略過／復原時間戳、下一站（略過排除、缺定位不跳過）、上移下移、候選排入、匯入驗證（損壞、版本不符、ID 重複、日期越界、座標越界、`javascript:` 網址、狀態不一致）、BOM 與中文往返、範本去除個資、檔名時區。
- 瀏覽器端對端 28 項全數通過（Chromium 手機尺寸）：示範載入、下一站、模式切換、完成／復原、雙略過後缺定位的下一站、重新載入保留、同日雙城市、排序並重開後保留、表單錯誤時保留內容、候選排入、匯出、損壞檔被拒且資料保留、整份取代匯入、Service Worker 控制、**離線重新載入**、離線刪除＋復原、CSP 無錯誤。

**v1.1.0 新增（2026-11-06）**：CSV／AI JSON 匯入。單元測試增為 27 項；匯入端對端 14 項全數通過（說明頁、複製提示詞、下載範本、貼上 AI JSON〔含 ``` 程式碼框〕、CSV 建立新旅程、Big5 解碼、日期越界拒絕、Tab 表格加入目前旅程、缺欄位拒絕）。

**v1.3.0 新增（2026-11-06）**：Excel 範本與 .xlsx 匯入。單元測試 33 項（含 Excel 範本與 CSV 範本內容一致性、LibreOffice 另存檔、Excel 自動轉換日期／時間／布林、跳列、特殊字元、損壞檔）；匯入端對端 22 項全數通過。

**v1.4.0 新增（2026-11-06）**：景點參考照片。單元測試 43 項（含配對：同名異城排除、相鄰建築不誤配、僅接受 upload.wikimedia.org）；照片端對端 12 項（預設不發出任何請求、預先下載、離線顯示、未允許即時下載時不連線、不是這張／復原）。開發環境無法連線真實維基百科，API 以模擬回應測試。

**v1.5.0 新增（2026-11-06）**：自己的照片與批次整理、維基百科照片修正。單元測試 53 項；自己的照片端對端 19 項（資料庫 v1→v2 升級保留既有行程、單張上傳縮成 640px、依檔名與依順序批次指派、編輯表單未儲存欄位不被清除、完整／不含照片備份、範本不含照片、新手機還原）；維基百科照片端對端 13 項。端對端測試改以輪詢 `page.evaluate` 等待，不再使用會被 CSP 阻擋的 `wait_for_function`。

**v1.5.1（2026-11-06）**：維基百科照片改為當地語言優先、名稱須吻合才採用。單元測試 56 項（新增：當地語言判斷、關鍵字吻合、拒絕城市條目與通用字、單一語言查詢失敗時繼續其他語言）。

**v1.6.0（2026-11-06）**：同一地點自動沿用照片。單元測試 58 項；自己的照片端對端 29 項（新增：同名同城市自動沿用、不另存副本、「尚無照片」篩選排除已沿用者、這一站不顯示照片；並修正 v1.5.2 的儲存覆寫問題）。

**v1.7.0（2026-11-07）**：兩地時間、日夜模式。單元測試 67 項（新增：冬令／夏令時差、跨日、非整點時差）；新增端對端 12 項（快速切換、重開後維持、跟隨系統即時變化、固定淺色不受系統影響、更換家鄉時區、關閉顯示、出國後家鄉時區不變）。

**v1.8.0（2026-11-07）**：天氣預報；精簡今天頁。單元測試 72 項；天氣端對端 9 項（真實回應格式、兩城市、3 小時快取、離線、關閉後不連線、座標僅 2 位小數）。

**v1.9.0（2026-11-07）**：逐時預報與日出日落（點天氣標籤展開）。單元測試 75 項；天氣端對端 18 項。逐時與日出日落的回應結構以真實 API 確認。

**待 iPhone 實機驗證**（開發端無法測試，請逐項確認）

- [ ] 主畫面 App 點導航按鈕，是否**直接跳到 Apple Maps**（可在「設定 → 導航測試」比較四種格式）
- [ ] 步行與大眾運輸的模式是否正確帶入；在維也納／布達佩斯是否有大眾運輸路線
- [ ] 不帶 `source` 時，起點是否為目前位置
- [ ] 從 Apple Maps 返回後，App 是否停在原日期與原位置
- [ ] 飛航模式下從主畫面**重新啟動**，是否能載入並修改資料
- [ ] 匯出時分享面板是否出現「儲存到檔案」，以及存檔後能否重新匯入
- [ ] 系統「文字大小」調大後，按鈕是否重疊
- [ ] 「下載 CSV 範本」在 iPhone 上能存到「檔案」，且用「檔案」選取 CSV 可匯入
- [ ] 用電腦 Excel 填好的 .xlsx（AirDrop／iCloud 雲碟傳到手機）可直接匯入
- [ ] 參考照片：Wi‑Fi 下預先下載成功、配對結果大致正確；飛航模式下照片仍顯示
- [ ] 自己的照片：從相簿選取（含 HEIC）、拍照、一次多選皆可；方向正確（直拍不會躺下）
- [ ] Safari 分頁與主畫面 App 的資料是否分開（記錄差異）
- [ ] 重新開機後資料是否仍在

## 12. 已知限制

- 本 App 不做路線規劃，也不提供離線逐步導航；大眾運輸班次以 Apple Maps 與官方資訊為準。
- iOS 仍可能清除網站資料（例如使用者清除 Safari 資料），**請定期備份**。
- 匯入只支援「整份取代」或「加入／取代單一旅程」，合併同步列為 P1。
- Google Maps 清單整理（F15）尚未實作；目前可先把清單整理成 CSV 或交給 AI 轉換。
- Excel 只讀取儲存格的值，不計算公式；含公式的儲存格以 Excel 最後存檔時的結果為準。不支援舊版 .xls。
- 讀取 .xlsx 需要瀏覽器支援 DecompressionStream（iOS Safari 16.4 以上）。

## 授權

MIT License
