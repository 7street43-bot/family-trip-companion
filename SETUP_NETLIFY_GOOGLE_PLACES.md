# V4.4 部署設定｜Netlify + Google Places

## 1. Google Cloud
1. 建立或選擇 Google Cloud Project。
2. 綁定 Billing Account。
3. 啟用 **Places API (New)** (`places.googleapis.com`)。
4. 建立一把專供本 App 使用的 API Key。
5. 將 API restrictions 限制為 **Places API (New)**。
6. 不要把 API Key 寫進 `app.js`、HTML 或 GitHub。

> 這個版本由 Netlify Functions 作為 server-side proxy。若使用 serverless 動態出口 IP，IP application restriction 可能不實用；至少應啟用 API restriction、用獨立 key，並監看 quota / usage。

## 2. Netlify
1. 將整個 V4.4 project folder / ZIP 重新部署到原站台。
2. Netlify 會依 `netlify.toml`：
   - publish: `public`
   - functions: `netlify/functions`
3. 到 Site/Project configuration → Environment variables。
4. 新增：
   - Key: `GOOGLE_PLACES_API_KEY`
   - Value: Google Cloud 建立的 API Key
5. 儲存後重新 Deploy 一次，讓 Function 讀到新的環境變數。

## 3. App 驗證
1. 開啟 App → 右上角設定。
2. 按「測試 API 設定」。
3. 顯示「Google Places API 已連線」即完成。
4. 新增景點，例如：
   - 名稱：小人國
   - 地區：桃園龍潭
5. 儲存後應自動找地點與封面。
6. 若同名地點不夠確定，App 會列候選讓你點選。

## 4. 既有資料
設定 → 「批次補齊既有封面」。
- 只會自動寫入高信心配對。
- 模糊資料略過，不硬配。
- 此動作會產生 Google Places API 請求用量。
