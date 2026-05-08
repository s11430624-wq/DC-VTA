# Frontend Deploy Checklist

## 目的

這份清單用於正式部署 `teacher-dashboard`。

## 上線前

1. 確認 `.env` 使用 `VITE_SUPABASE_ANON_KEY`
2. 確認沒有 `VITE_SUPABASE_SERVICE_ROLE_KEY`
3. 確認 `VITE_SUPABASE_URL` 已設定
4. 確認 `VITE_AI_GRADING_API_URL` 正確，或留空走預設 `/api/ai-grade`
5. 確認 Vercel serverless env 已設定 `GEMINI_API_KEY`
6. 如未設定 `GEMINI_MODEL`，確認現場已有 `QUESTION_MODEL`
7. 確認 deep-link 版本已包含 `tab/status/question_id/response_id`

## 建議的 Vercel Env

Client env:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_AI_GRADING_API_URL=/api/ai-grade
```

Serverless env:

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.1-flash-lite-preview
```

備註：

- `GEMINI_MODEL` 可省略
- `api/ai-grade` 會 fallback 使用 `QUESTION_MODEL`
- 舊的 `VITE_AI_WEBHOOK_URL` / `VITE_SUBMIT_WEBHOOK_URL` 已不再使用

## 驗證指令

```powershell
npm run build
```

## 驗證項目

1. 首頁可開啟
2. 教師可登入
3. `簡答批改` 分頁正常
4. 從以下網址可直接切到批改：

```text
https://teacher-dashboard-two-mauve.vercel.app/?tab=grading&status=pending&question_id=214
```

5. 指定題號有資料時會自動選中
6. 指定題號沒資料時會顯示合理錯誤訊息
7. `AI 輔助批改` 可產生分數與評語
8. `AI 一鍵全自動批改` 可把 pending 轉成 graded
9. 手動送出後 `quiz_responses.status` 會變成 `graded`

## 和 Discord Bot 的對接

正式站部署完成後，Discord Bot `.env` 應設定：

```env
FRONTEND_BASE_URL=https://teacher-dashboard-two-mauve.vercel.app
```

## 禁止事項

- 不要把 Supabase `service_role` 放在前端
- 不要把機密金鑰寫進 client-side bundle
- 不要再設定舊的 webhook env 當作正式依賴

