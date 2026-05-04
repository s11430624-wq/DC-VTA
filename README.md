# VTA Discord Bot

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
- Teacher dashboard 前端網址（若要使用短答批改深連結）

## 安裝與啟動

安裝依賴：

```powershell
npm install
```

啟動：

```powershell
npm run start
```

開發模式：

```powershell
npm run dev
```

型別檢查：

```powershell
npm run typecheck
```

## `.env` 設定

請先建立本機 `.env`：

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
```

說明：

- `SUPABASE_SERVICE_ROLE_KEY` 只可用在這個 Node.js bot，不能暴露到前端。
- `FRONTEND_BASE_URL` 供 `/grading_queue`、`/grade_link`、短答 `/check` 連到 teacher dashboard。
- `TEACHER_ROLE_ID`、`TEACHER_LOG_CHANNEL_ID` 是 fallback 設定。多伺服器時，建議改由 `guild_settings` 控制每個班級的值。
- 如果 `TEACHER_LOG_CHANNEL_ID` 沒設，bot 會嘗試找同伺服器中名為 `teacher` 的文字頻道。
- 修改 `.env` 後需要重啟 bot。

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

建議做法：

- 每新增一個班級伺服器，就新增或更新一筆 `guild_settings`
- `.env` 裡的 `TEACHER_ROLE_ID`、`TEACHER_LOG_CHANNEL_ID` 保留當備援，不要當長期主設定

範例：

```sql
insert into public.guild_settings (
    guild_id,
    guild_name,
    teacher_role_id,
    teacher_log_channel_id
) values (
    '1500234854204178444',
    'VTA test',
    '1500236262458790018',
    '1500235643039518940'
)
on conflict (guild_id) do update
set
    guild_name = excluded.guild_name,
    teacher_role_id = excluded.teacher_role_id,
    teacher_log_channel_id = excluded.teacher_log_channel_id;
```

## Supabase 資料表

### `users`

至少需要：

```text
user_id text
display_name text
student_id text
role text
platform text optional
class_name text optional
```

說明：

- `user_id` 存 Discord user id
- `users.role` 已視為 legacy，不用來做老師授權
- 老師授權以 `guild_settings.teacher_role_id` 或 `.env` fallback 為準

### `question_bank`

至少需要：

```text
id integer or bigint
content text
category text
question_type text
metadata jsonb or text
embedding optional
rubric optional
```

選擇題 `metadata` 格式：

```json
{
  "options": ["選項A", "選項B", "選項C", "選項D"],
  "correct_answer": "A",
  "explanation": ""
}
```

### `quiz_responses`

至少需要：

```text
user_id text
question_id integer or bigint
group_id text nullable
selected_option text nullable
is_correct boolean
answer_text text nullable
status text not null default 'graded'
reaction_time double precision nullable
created_at optional
updated_at optional
```

說明：

- `group_id` 在 Discord 模式下使用 `guildId`
- 同一伺服器視為同一班級
- `/rank` 會依 `group_id` 聚合排行榜

## 建議 migration 順序

依序執行 `supabase/migrations`：

1. `20260504_001_schema_baseline_safe.sql`
2. `20260504_002_quiz_response_uniqueness.sql`
3. `20260504_003_discord_channel_groups.sql`
4. `20260504_004_quiz_response_reaction_time.sql`
5. `20260504_005_users_class_name.sql`
6. `20260504_006_guild_settings.sql`

## Slash Commands 註冊

bot 啟動時會：

- 對目前已加入的每個 Discord 伺服器註冊 guild commands
- 當 bot 新加入其他伺服器時，自動再註冊一次

註冊路徑：

```text
Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guild.id)
```

## Teacher Dashboard 整合

Discord bot 與 teacher dashboard 分工如下：

- Discord Bot：出題、開題、收答、查看統計、導向批改
- Teacher Dashboard：短答批改、AI 協助批改、批次批改、分析畫面

bot 產生的批改深連結格式：

```text
https://teacher-dashboard-two-mauve.vercel.app/?tab=grading&status=pending&question_id=214
```

支援參數：

```text
tab=grading
status=pending|graded
question_id=題目ID
response_id=作答ID
```

## 伺服器與群組邏輯

- 一個 Discord 伺服器代表一個班級
- 題目分類使用伺服器名稱
- 排行榜使用 `quiz_responses.group_id = guildId`
- 老師角色與老師通知頻道可依伺服器個別設定

## 報到與老師通知

### 學生報到

學生使用：

```text
/link student_id:110123456 name:王小明
```

之後可用：

```text
/me
```

確認綁定結果。

### 老師通知

學生 `/link` 成功後，bot 會自動通知老師頻道，內容包含：

- 姓名
- 學號
- Discord 使用者
- Discord ID
- 來源頻道

優先順序：

1. `guild_settings.teacher_log_channel_id`
2. `.env` 的 `TEACHER_LOG_CHANNEL_ID`
3. 同伺服器名稱為 `teacher` 的頻道

## 完整測試流程

1. 啟動 bot

```powershell
npx ts-node src/index.ts
```

2. 確認 `/help` 可用
3. 學生使用 `/link`
4. 學生使用 `/me`
5. 老師新增題目 `/add` 或 `/add_short`
6. 老師開題 `/open id:題目ID`
7. 學生作答
8. 老師查看 `/check`
9. 學生查看 `/rank`
10. 老師使用 `/grading_queue` 或 `/grade_link`

## Agent 功能

`/ask` 目前可處理：

- 個人資料查詢
- 個人成績查詢
- 伺服器排行榜查詢
- 題目查詢
- 最近題庫查詢
- 老師題目草稿生成

老師草稿流程：

```text
1. /ask prompt:幫我出一題關於資料庫正規化的四選一題
2. Bot 回草稿與按鈕
3. 按「同意建立」後才真正寫入 question_bank
4. 按「我要修改」後，下一次 /ask 會修改同一份草稿
```

批次草稿流程：

```text
1. /batch_generate prompt:幫我出資料庫正規化題目，適合大一 count:3
2. Bot 回 3 題草稿與按鈕
3. 按「全部建立」後一次寫入題庫
```

## 部署注意事項

### Backend bot

- `SUPABASE_SERVICE_ROLE_KEY` 只放在 bot 後端
- 修改 `.env` 後要重啟
- 新增伺服器後，確認 `guild_settings` 有正確角色與頻道設定

### Frontend dashboard

- 前端只能使用 Supabase anon key
- 不可把 service role 放進 Vite env
- 正式上線前先確認 `FRONTEND_BASE_URL`

## 驗證

```powershell
npx tsc --noEmit
```
