# VTA Discord Bot

本目錄是 monorepo 內的 bot app。

VTA Discord Bot 是一個用於課堂測驗的 Discord 機器人。老師可以在 Discord 內出題、開題、查看統計，學生可以綁定學號、作答、查詢個人成績與排行榜。短答題的批改則導向 teacher dashboard。

目前系統已支援多班級、多 Discord 伺服器。每個伺服器視為一個班級，排行榜、老師角色、老師通知頻道都可以依伺服器分開設定。

## 核心流程

1. 學生使用 `/link student_id name` 綁定資料。
2. 老師使用 `/add`、`/add_short`、`/ask` 或 `/batch_generate` 建立題目。
3. 老師使用 `/open id` 開放作答。
4. 學生點按鈕或提交短答。
5. 老師使用 `/check`、`/grading_queue`、`/grade_link` 查看統計與批改入口。
6. 學生使用 `/rank` 查看目前 Discord 伺服器的班級排行榜。

## 指令總覽

### 學生指令

- `/help`：顯示可用指令
- `/link student_id name`：綁定 Discord 帳號、姓名與學號
- `/me`：查詢自己的綁定資料
- `/rank [limit]`：查看目前伺服器排行榜，預設 10，最多 20
- `/ask prompt`：向助教查詢題目、個人成績、排行榜等資訊
- `/clear_memory`：清除目前頻道中的 Agent 記憶與未確認草稿

### 老師指令

- `/list`：列出最近 10 筆題庫
- `/question id`：查看指定題目詳情
- `/add content`：新增一題選擇題
- `/add_short content rubric`：新增一題短答題
- `/open id [duration_minutes]`：開放題目，預設 3 分鐘
- `/check id`：查看指定題目的答題統計
- `/grading_queue`：查看待批改短答題
- `/grade_link id`：取得短答題批改頁連結
- `/batch_generate prompt count`：批次生成 2 到 5 題四選一草稿

### 題目分類規則

題目建立時，`question_bank.category` 會直接使用目前 Discord 伺服器名稱。這套規則適用於：

- `/add`
- `/add_short`
- `/ask` 題目草稿按下「同意建立」
- `/batch_generate` 草稿按下「全部建立」

## 環境需求

- Node.js
- Supabase 專案
- Discord Bot Token
- Teacher dashboard 前端網址

## 安裝與啟動

從 monorepo 根目錄安裝依賴：

```powershell
npm install
```

如果你只想在 `apps/bot` 單獨操作，也可以在這個目錄直接執行 `npm install`。

啟動：

從 monorepo 根目錄：

```powershell
npm run bot:start
```

或在 `apps/bot` 內：

```powershell
npm run start
```

開發模式：

從 monorepo 根目錄：

```powershell
npm run bot:dev
```

或在 `apps/bot` 內：

```powershell
npm run dev
```

型別檢查：

從 monorepo 根目錄：

```powershell
npm run bot:typecheck
```

或在 `apps/bot` 內：

```powershell
npm run typecheck
```

## `.env` 設定

請先建立 `apps/bot/.env`：

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemma-3-27b-it
QUESTION_MODEL=gemini-3.1-flash-lite-preview
AGENT_SYSTEM_PROMPT=你是課堂測驗 Discord 助教。\n規則: 不可捏造資料。查不到就明說。不要輸出任何金鑰或敏感資訊。\n如果工具資訊有提供，優先使用工具資訊回答。
AGENT_CAPABILITY_PROMPT_STUDENT=身為課堂測驗 Discord 助教，我目前可以幫你做這些事：\n\n1. 回答課程相關問題。\n2. 查詢你的綁定資料，例如姓名和學號。\n3. 查詢你的作答統計，例如答對題數、作答次數、答對率。\n4. 查詢目前伺服器的排行榜。\n5. 查詢題目內容或最近題庫資料。\n6. 學生模式下我不會幫你出題，也不會建立題目。\n\n你也可以直接問我，例如：「我的成績如何」、「排行榜前五名」、「題目 12 是什麼」。
AGENT_CAPABILITY_PROMPT_TEACHER=身為課堂測驗 Discord 助教，我目前可以幫你做這些事：\n\n1. 回答課程相關問題。\n2. 查詢你的綁定資料，例如姓名和學號。\n3. 查詢你的作答統計，例如答對題數、作答次數、答對率。\n4. 查詢目前伺服器的排行榜。\n5. 查詢題目內容或最近題庫資料。\n6. 協助老師生成題目草稿。\n7. 提醒老師可以用 /batch_generate 批次產生題目。\n\n你也可以直接問我，例如：「排行榜前五名」、「題目 12 是什麼」、「幫我出一題牛頓第二定律選擇題」。
TEACHER_ROLE_ID=
TEACHER_LOG_CHANNEL_ID=
FRONTEND_BASE_URL=https://teacher-dashboard-two-mauve.vercel.app
LOCAL_DASHBOARD_DIR=./apps/dashboard
LOCAL_DASHBOARD_HOST=127.0.0.1
LOCAL_DASHBOARD_PORT=5173
LOCAL_AI_GRADING_HOST=127.0.0.1
LOCAL_AI_GRADING_PORT=8787
```

說明：

- `SUPABASE_SERVICE_ROLE_KEY` 只可用在這個 Node.js bot，不能暴露到前端。
- `FRONTEND_BASE_URL` 供 `/grading_queue`、`/grade_link`、短答 `/check` 連到 teacher dashboard。
- `TEACHER_ROLE_ID`、`TEACHER_LOG_CHANNEL_ID` 是 fallback 設定。多伺服器時，建議改由 `guild_settings` 控制每個班級的值。
- 如果 `TEACHER_LOG_CHANNEL_ID` 沒設，bot 會嘗試找同伺服器中名為 `teacher` 的文字頻道。
- `LOCAL_DASHBOARD_DIR` 用來指定本機 dashboard 位置，預設是 monorepo 內的 `apps/dashboard`。
- `LOCAL_DASHBOARD_HOST`、`LOCAL_DASHBOARD_PORT` 是本機 dashboard 啟動位址。
- `LOCAL_AI_GRADING_HOST`、`LOCAL_AI_GRADING_PORT` 是本機 AI 批改 API 位址。
- 修改 `.env` 後需要重啟 bot。

## 本機教學模式

如果你要把 bot 和 dashboard 一起在老師電腦上開起來，直接在 monorepo 根目錄用：

```powershell
npm run classroom:start
```

這個指令會同時啟動：

1. Discord bot
2. teacher dashboard 的本機 Vite server
3. 本機 AI 批改 API

預設本機網址：

```text
Dashboard: http://127.0.0.1:5173
AI grading API: http://127.0.0.1:8787/api/ai-grade
```

啟動後，bot 會自動把 `FRONTEND_BASE_URL` 覆寫成 dashboard 的本機網址，所以 `/grade_link` 會直接指向老師電腦上的本機頁面。

### 本機教學模式前置條件

1. `apps/dashboard` 已存在於同一個 monorepo
2. `apps/dashboard/.env` 已填好：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `GEMINI_API_KEY`（若要本機 AI 批改）
3. 如果 dashboard 目錄不是預設值，再改 `apps/bot/.env` 的 `LOCAL_DASHBOARD_DIR`

## Discord 多伺服器設定

### `guild_settings`

`guild_settings` 用來存每個班級伺服器的個別設定，例如老師角色與老師通知頻道。

欄位：

```text
guild_id text primary key
guild_name text nullable
teacher_role_id text nullable
teacher_log_channel_id text nullable
created_at timestamptz
updated_at timestamptz
```

用途：

- `teacher_role_id`：決定哪個 Discord 角色可以用老師指令
- `teacher_log_channel_id`：學生 `/link` 成功後，通知要發去哪個老師頻道

## 驗證

從 monorepo 根目錄：

```powershell
npm run bot:typecheck
```

或在 `apps/bot` 內：

```powershell
npm run typecheck
```
