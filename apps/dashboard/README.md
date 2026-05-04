# Teacher Dashboard

本目錄是 monorepo 內的 dashboard app。

Teacher Dashboard 是短答題批改與教學分析前端，使用 Vue 3 + Vite + Supabase。

## Responsibilities

這個前端負責：

- 教師登入
- 題庫管理
- 排行榜與分析
- 短答題批改
- AI 輔助批改
- 接收 Discord Bot 帶入的批改 deep link

Discord Bot 負責：

- 出題
- 發題
- 收答案
- 導流到批改頁

## Environment Variables

建立 `apps/dashboard/.env`：

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_AI_GRADING_API_URL=/api/ai-grade
VITE_LIFF_ID=
GEMINI_API_KEY=
GEMINI_MODEL=gemma-3-27b-it
```

規則：

- 前端只能使用 `anon key`
- 不要把 `service_role` 放進 Vite env

說明：

- `VITE_SUPABASE_URL`：前端連線用
- `VITE_SUPABASE_ANON_KEY`：前端登入與讀寫 `quiz_responses/question_bank/users/groups` 用
- `VITE_AI_GRADING_API_URL`：可省略，預設會打 `/api/ai-grade`
- `VITE_LIFF_ID`：只有保留舊 `StudentQuiz` LIFF 路由時才需要
- `GEMINI_API_KEY`：Vercel serverless `api/ai-grade` 用，不會進 client bundle
- `GEMINI_MODEL`：可省略；若未提供，程式也支援 fallback 到 `QUESTION_MODEL`

## Vercel Deployment Env

建議在 Vercel 分成兩類理解：

Client env:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_AI_GRADING_API_URL=/api/ai-grade
```

Serverless env:

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemma-3-27b-it
```

如果你已經只有：

```env
QUESTION_MODEL=gemini-3.1-flash-lite-preview
```

也可以，`api/ai-grade` 會自動 fallback 使用它。

## Install

從 monorepo 根目錄安裝依賴：

```powershell
npm install
```

如果你只想在 `apps/dashboard` 單獨操作，也可以在這個目錄直接執行：

```powershell
npm install
```

## Development

從 monorepo 根目錄：

```powershell
npm run dashboard:dev
```

或在 `apps/dashboard` 內：

```powershell
npm run dev
```

本機預設網址：

```text
http://localhost:5173/
```

## Discord Settings UI

登入教師後台後，切到 `Discord 設定` 分頁即可管理 `guild_settings`，不用手打 SQL。

可編輯欄位：

- `guild_id`
- `guild_name`
- `teacher_role_id`
- `teacher_log_channel_id`

建議每個班級伺服器都填完整 `teacher_role_id` 與 `teacher_log_channel_id`，避免 fallback 到全域 `.env`。

## Production Build

從 monorepo 根目錄：

```powershell
npm run dashboard:build
```

或在 `apps/dashboard` 內：

```powershell
npm run build
```

## Grading Deep Link Support

這個前端已支援以下查詢參數：

```text
?tab=grading
?status=pending|graded
?question_id=214
?response_id=987
```

範例：

```text
https://teacher-dashboard-two-mauve.vercel.app/?tab=grading&status=pending&question_id=214
```

行為：

- 未登入時，登入後會保留導向狀態
- 會自動切到 `簡答批改`
- 如果指定題號或作答存在，會自動選到那筆資料

## Deployment Notes

1. 確認前端只暴露 `VITE_*` 變數
2. 確認 deep-link 版本已部署
3. 確認 Vercel 已設定 `GEMINI_API_KEY`，否則 AI 批改會失敗
4. 確認 Discord Bot 的 `FRONTEND_BASE_URL` 指向這個正式網址
5. 如果前端網址改變，要同步更新 `apps/bot/.env`

## Validation

從 monorepo 根目錄：

```powershell
npm run dashboard:build
```

或在 `apps/dashboard` 內：

```powershell
npm run build
```
