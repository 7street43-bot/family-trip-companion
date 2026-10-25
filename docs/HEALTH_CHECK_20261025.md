# 雙寶出遊趣｜整體健康檢查與輕量隔離壓測

日期：2026-10-25（Asia/Taipei）
狀態：**PARTIAL：資料與一般導航通過，設定入口有可重現卡頓**
基準：Preview `4.5.0-phase1.21-journal.1`，commit `10a84432e3b6c82dbcddc7a670c5482d0585594f`
正式 main：`3761d9d7d4671d85b5cce901a424850641df0da9`（未修改）
依據：App Performance Engineering Skill Pack V1.1 + 正式 Registry，皆於執行前 Fresh Read。

## 1. 隔離資料與核心回歸測試

- 30 趟虛構行程、每趟 5 個景點＝150 個景點
- 80 篇虛構日誌、24 個安全媒體儲存路徑
- 300 次本機日誌搜尋：p95 約 0.643ms（Runner Node.js，非瀏覽器 UI 時間）
- 行程候選／排序／起點模型／路線計算／智慧停留／日誌與照片權限邏輯的既有測試均 PASS
- 無 Google Places / Routes 付費 API 呼叫；無 Production 或真實家庭資料寫入
- 證據：GitHub Actions Run 40186045487 及後續重驗

## 2. WebKit 模擬手機與桌面

GitHub Actions Run 40186045487：
- mobile 390×844：first usable 255ms；5 次行程切換 829 / 54 / 36 / 38 / 43ms
- desktop 1280×900：first usable 194ms；5 次行程切換 1154 / 149 / 51 / 64 / 70ms
- 兩者均 PASS：30 行程列表、日誌搜尋、展開新增／取消、0 個 uncaught page errors、0px document overflow

重測 Run 40186501519：
- mobile first usable 217ms；5 次切換 958 / 52 / 52 / 38 / 41ms
- desktop first usable 188ms；5 次切換 839 / 138 / 54 / 66 / 70ms
- 行程與 Journal 測試均 PASS
- 注意：WebKit 虛擬 viewport 並不等於 iPhone 16 Pro Max 實機 Safari。

## 3. 設定入口：可重現故障

- Run 40186247428 與 Run 40186501519，mobile / desktop WebKit 點擊 `#settingsBtn` 均在 performing click action 階段逾時（6.5s）
- 第二次加測逾時後的 modal DOM 讀取，1.5s 仍沒有回應（probe-timeout）
- pageErrors 在兩種 profile 皆為 0（不代表主執行緒不卡）
- 過往 J2B Origin/WebKit Gate 也曾在同一個 `#settingsBtn` 卡住
- 判定：設定入口互動存在待定位的主執行緒卡頓風險；**尚未確認是設定函式、Cloud Sync 初始化、重入事件或 WebKit 特性所致**
- 待修復前不得宣稱「整體 App 功能完全 PASS」

## 4. 既有 Gate 假失敗／舊腳本問題

- J2A/J2B 的舊版 contract 硬性要求 J2A/J2B channel，Preview 已是 JOURNAL，造成 version/channel gate failure；核心單元測試實際 PASS
- J1K 舊 WebKit 腳本仍尋找已移除的 `data-journal-tab=history/search`，故逾時
- 這些 Gate 應依新版功能規格修訂，不應放寬真正的安全驗收

## 5. 仍未驗證

- 真實 iPhone Safari 與實際桌機裝置的觸控、卡頓、照片相簿上傳/刪除
- 真實登入、跨裝置 Cloud Sync、家人共編（使用者已暫停這條線）
- Google Places/Routes 的付費 Live 呼叫（此輪明確不呼叫）

## 6. 建議下一刀

先在隔離分支對設定入口做儀表化、事件階段二分診斷（pointer → click handler → showModal → hydrateCloudSyncSettings），定位真正阻塞，再做最小修補與 WebKit 回歸；其後修訂已過時的 J1K/J2A/J2B 測試腳本。Production 不應在這些 Gate 通過前發布這輪 Preview。

本文件與測試碼只存在 `health/20261025-integration`，沒有合入 Preview/main。

## 7. 2026-10-25 下一刀：設定入口定位與安全回復

- Freshness：main HEAD=`3761d9d7d4671d85b5cce901a424850641df0da9`，Netlify published deploy `6aa202e29e1b2f00085643df` READY，不曾寫入 main 或 Production。
- 初始化完成等待後仍 FAIL：Run `40187060165`，mobile / desktop 點擊均逾時；非僅首頁未 ready 所致。
- DOM 事件階段追蹤：Run `40187440045`，兩種 profile 均收到 pointerdown、click capture，以及設定 handler 的 ENTER / PRE_SHOW / AFTER_SHOW / AFTER_HYDRATE；但 Playwright click 未完成、modal 後續 evaluate timeout。這不等於已證明 App 自身阻塞。
- Candidate A「雲端狀態改用後續 task」Run `40187665782`：核心 PASS，但兩種 WebKit 點擊仍 FAIL，已撤銷。
- Candidate B「hidden modal 先建 DOM 再顯示」Run `40187862670`：核心 PASS，但兩種 WebKit 點擊仍 FAIL，已撤銷。
- 兩個失敗候選皆 rollback；health branch `public/app.js` 已 read-back 還原為原始 blob `040e979843f7e536c2df3dba1d529f35fa8624c7`。不可將兩個失敗方案合入 Preview / main。
- 現有 `tests/health-settings-probe.mjs` 加入原生 DOM click 與 WebKit locator click 對照，但保留原有實際 locator Gate，不會用原生事件替代通過標準。
- 下一個精確證據點：Actions Run `40188125782`（2026-10-25 11:20 UTC 查詢時仍 in_progress）；讀取 `HEALTH_SETTINGS_NATIVE` 與 `HEALTH_SETTINGS_PROBE` 分別判定 driver / App 互動；未得到結果前保持 `PARTIAL PASS`，不更動 App 功能與正式部署。
