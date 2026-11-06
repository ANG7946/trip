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
js/app.js                介面與互動
icons/                   PWA 圖示
data/demo-trip.json      虛構的示範旅程（可公開）
tests/core.test.mjs      邏輯單元測試（Node 內建 test runner）
tests/e2e_playwright.py  瀏覽器端對端測試
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

**發佈新版本時**：修改 `sw.js` 裡的 `VERSION`（例如改成 `1.0.1`）。使用者開啟 App 後會看到「有新版本可用 → 重新載入」。IndexedDB 中的行程不會被動到。

## 4. 在 iPhone 上安裝與匯入私人行程

1. 用 **Safari** 開啟網址 → 分享 → **加入主畫面**。之後一律從主畫面圖示開啟，因為主畫面 App 與 Safari 分頁的資料可能分開保存。
2. 連網狀態下，從主畫面開啟一次，到「設定／備份」確認「離線網站資料：已就緒」。
3. 把私人行程 JSON（例如 `private/2026-central-europe-trip.json`）用 AirDrop 或 iCloud 雲碟傳到 iPhone 的「檔案」。
4. App →「設定／備份」→「匯入備份或行程檔…」→ 選檔 → 確認預覽 → 匯入。
5. 在 Apple Maps 內**自行下載**維也納、布達佩斯、布拉提斯拉瓦的離線地圖。
6. 開啟**飛航模式**，從主畫面重新開啟 App，確認仍能載入。

## 5. 資料格式（schemaVersion 1）

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

## 6. Apple Maps 連結

| 設定 | 網址格式 | 備註 |
|---|---|---|
| 官方統一網址（預設） | `https://maps.apple.com/directions?destination=…&mode=walking` | iOS 18.4 以上 |
| 舊式網址 | `https://maps.apple.com/?daddr=…&dirflg=w` | 沒有自行車模式 |
| `maps://` | `maps://?daddr=…&dirflg=w` | 若連結停留在網頁內，可用這個格式直接開啟 App |
| Google 地圖 | `https://www.google.com/maps/dir/?api=1&destination=…&travelmode=walking` | 給 Android 使用者，或作為備援 |

- 導航按鈕是真實的 `<a href>`，點擊時不經過任何非同步等待，避免 iOS 判定為非使用者手勢。
- 不帶 `source`，由 Apple Maps 從目前位置規劃；不使用自動開始導航的參數。
- 開啟地圖**不會**改變完成狀態。

## 7. 資料遷移策略

- `js/core.js` 的 `SCHEMA_VERSION` 是資料內容版本；`js/db.js` 的 `DB_VERSION` 是 IndexedDB 結構版本。
- 讀取時一律經過 `migrateTrip()`：舊版本依序升級，只新增欄位或轉換格式，不刪除使用者資料。
- IndexedDB 的 `onupgradeneeded` 只新增 store，不刪除。
- 網站更新（Service Worker 換版）只更換 Cache Storage 的網站資產，不碰 IndexedDB。

## 8. 隱私檢查（每次部署前）

```bash
git status --ignored            # private/ 應顯示為 ignored
grep -ri "你的飯店名稱或其他私人關鍵字" --exclude-dir=private --exclude-dir=.git .
```

公開 repo 與 GitHub Pages 的內容等同公開資訊。真實行程只透過 iPhone 匯入。

## 9. 測試紀錄（開發端，2026-11-06）

**已自動測試**

- 單元測試 16 項全數通過：網址編碼（德文、匈牙利文、空格）、座標順序、入口座標優先、無目的地時不產生連結、舊式／maps:///Google 網址、旅行時區日期（臺灣與維也納跨日）、行前預覽、完成／略過／復原時間戳、下一站（略過排除、缺定位不跳過）、上移下移、候選排入、匯入驗證（損壞、版本不符、ID 重複、日期越界、座標越界、`javascript:` 網址、狀態不一致）、BOM 與中文往返、範本去除個資、檔名時區。
- 瀏覽器端對端 28 項全數通過（Chromium 手機尺寸）：示範載入、下一站、模式切換、完成／復原、雙略過後缺定位的下一站、重新載入保留、同日雙城市、排序並重開後保留、表單錯誤時保留內容、候選排入、匯出、損壞檔被拒且資料保留、整份取代匯入、Service Worker 控制、**離線重新載入**、離線刪除＋復原、CSP 無錯誤。

**待 iPhone 實機驗證**（開發端無法測試，請逐項確認）

- [ ] 主畫面 App 點導航按鈕，是否**直接跳到 Apple Maps**（可在「設定 → 導航測試」比較四種格式）
- [ ] 步行與大眾運輸的模式是否正確帶入；在維也納／布達佩斯是否有大眾運輸路線
- [ ] 不帶 `source` 時，起點是否為目前位置
- [ ] 從 Apple Maps 返回後，App 是否停在原日期與原位置
- [ ] 飛航模式下從主畫面**重新啟動**，是否能載入並修改資料
- [ ] 匯出時分享面板是否出現「儲存到檔案」，以及存檔後能否重新匯入
- [ ] 系統「文字大小」調大後，按鈕是否重疊
- [ ] Safari 分頁與主畫面 App 的資料是否分開（記錄差異）
- [ ] 重新開機後資料是否仍在

## 10. 已知限制

- 本 App 不做路線規劃，也不提供離線逐步導航；大眾運輸班次以 Apple Maps 與官方資訊為準。
- iOS 仍可能清除網站資料（例如使用者清除 Safari 資料），**請定期備份**。
- 匯入只支援「整份取代」或「加入／取代單一旅程」，合併同步列為 P1。
- CSV 匯入與 Google Maps 清單整理（F14、F15）尚未實作。

## 授權

MIT License
