# VTA Discord Bot

VTA Discord Bot 是把原本 n8n + LINE Bot 課堂測驗流程改成全程式碼版的 Discord Bot。

目前主線流程：老師新增題目，開放題目，學生點 A/B/C/D 按鈕答題，Bot 寫入 Supabase，老師可查看統計，所有學生可查看排行榜。

## Features

- `/help`：顯示可用指令
- `/link student_id name`：學生綁定 Discord 帳號、姓名與學號
- `/me`：查詢自己的綁定資料
- `/list`：列出最近 10 筆題庫
- `/question id`：查看指定題目詳情
- `/add content`：老師新增簡化版選擇題
- `/add_short content rubric`：老師新增短答題
- `/open id`：老師開放選擇題，送出 Embed 與 A/B/C/D 按鈕
- `/open id`：短答題會送出「提交短答」按鈕，學生以文字作答
- Button answer：學生點 A/B/C/D 後寫入 `quiz_responses`
- Button answer feedback：顯示答案解析與個人累積答題統計
- `/check id`：老師查看指定題目的答題統計，短答題會直接附上批改連結
- `/grading_queue`：老師查看目前待批改的簡答清單與批改連結
- `/grade_link id`：老師取得指定短答題的批改連結
- `/rank limit`：顯示排行榜，`limit` 預設 10，範圍 1 到 20
- `/ask prompt`：向 Gemma Agent 發問，支援題目、個人資料、個人成績與排行榜查詢
- `/clear_memory`：清除目前頻道中的 Agent 對話記憶與未確認題目草稿
- `/batch_generate prompt count`：老師批次產生 `2` 到 `5` 題四選一草稿，預覽後可一鍵全部建立
- 老師用 `/ask` 生成題目時，會先看到草稿，再決定同意建立或修改需求

## Environment Variables

Create a local `.env` file with:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemma-3-27b-it
QUESTION_MODEL=gemini-3.1-flash-lite-preview
TEACHER_ROLE_ID=
STUDENT_ROLE_ID=
FRONTEND_BASE_URL=https://teacher-dashboard-two-mauve.vercel.app
```

Do not commit `.env` or `.env.local`. They are ignored by `.gitignore`.

`SUPABASE_SERVICE_ROLE_KEY` is used only by this backend Node.js Discord Bot. Do not send it to Discord messages, browser code, or logs.

`FRONTEND_BASE_URL` is the teacher dashboard base URL used by `/grading_queue`, `/grade_link`, and short-answer `/check` deep links.

## Supabase Tables

### `users`

Required columns:

```text
user_id text
platform text optional
display_name text
student_id text
role text
```

Notes:

- `user_id` stores the Discord user id.
- `role` should be `student` or `teacher`.
- `/link` preserves an existing role. If a user is already `teacher`, it will not overwrite the role to `student`.
- `platform` is optional in code, but recommended.

### `question_bank`

Required columns:

```text
id integer or bigint
content text
category text
question_type text
metadata jsonb or text
embedding optional
rubric optional
```

Expected `metadata` for multiple choice questions:

```json
{
  "options": ["選項A", "選項B", "選項C", "選項D"],
  "correct_answer": "A",
  "explanation": ""
}
```

`metadata` may be an object or JSON string. The bot safely parses both.

### `quiz_responses`

Required columns:

```text
user_id text
question_id integer or bigint
selected_option text
is_correct boolean
created_at optional
updated_at optional
```

Duplicate answer strategy:

- The application uses update-old-record behavior for the same `user_id + question_id`.
- If a duplicate already exists because the database has no unique constraint, the code updates all matching rows instead of failing on multi-row lookup.
- A database unique constraint is still recommended for long-term consistency.

## Recommended SQL

```sql
alter table users add column if not exists platform text default 'discord';
```

```sql
alter table quiz_responses
add constraint quiz_responses_user_question_unique
unique (user_id, question_id);
```

If the second statement fails because the constraint already exists or duplicate rows already exist, do not force it. Remove duplicate `quiz_responses` rows first, then add the constraint.

## Start

```powershell
npx ts-node src/index.ts
```

## Slash Command Registration

Slash commands are registered automatically when the bot starts.

The bot registers guild commands through:

```text
Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
```

Current commands:

```text
/help
/link
/me
/list
/question
/add
/add_short
/open
/check
/grading_queue
/grade_link
/rank
/ask
/batch_generate
/clear_memory
```

## Teacher Dashboard Integration

The Discord bot and teacher dashboard now split responsibilities:

- Discord Bot: create questions, open questions, collect answers, and route teachers to grading
- Teacher Dashboard: short-answer grading, AI-assisted grading, batch grading, analytics

Deep-link format used by the bot:

```text
https://teacher-dashboard-two-mauve.vercel.app/?tab=grading&status=pending&question_id=214
```

Supported query params:

```text
tab=grading
status=pending|graded
question_id=題目ID
response_id=作答ID
```

If the teacher is not logged in, the dashboard keeps the target state and opens the grading tab after login.

## Deployment Notes

Backend bot:

- Keep `SUPABASE_SERVICE_ROLE_KEY` only in the Node.js bot `.env`
- Restart the bot after changing `.env`

Frontend dashboard:

- The browser client must use only the Supabase anon key
- Do not expose `service_role` in Vite env variables
- Deploy the grading deep-link capable frontend before switching `FRONTEND_BASE_URL` to production

## Full Flow Test

1. Start the bot.

```powershell
npx ts-node src/index.ts
```

2. Confirm `/help` lists all commands.

3. Student links account.

```text
/link student_id:110123456 name:王小明
```

4. Student checks profile.

```text
/me
```

5. Teacher creates a question.

```text
/add content:HTTP 與 HTTPS 的差異是什麼？
```

6. Teacher opens the question.

```text
/open id:題目ID
```

7. Student clicks A/B/C/D button.

Expected student reply is ephemeral:

```text
✅ 答對了！
你的答案：A
```

or:

```text
❌ 答錯了。
你的答案：B
正確答案：A
```

8. Teacher checks question stats.

```text
/check id:題目ID
```

If the question is short-answer, the reply now includes the grading link.

9. Show ranking.

```text
/rank
/rank limit:5
```

10. Ask the agent.

```text
/ask prompt:我目前答對幾題？
/ask prompt:第 12 題是什麼？
/ask prompt:幫我出一題關於 HTTP 狀態碼的四選一題目，難度中等
/batch_generate prompt:幫我出資料庫正規化題目，適合大一 count:3
/grading_queue
/grade_link id:214
/clear_memory
```

Teacher question generation flow:

```text
1. /ask prompt:幫我出一題關於資料庫正規化的四選一題，適合大一
2. Bot 回草稿 + 「同意建立」/「我要修改」按鈕
3. 按「同意建立」後才真正寫入 question_bank
4. 按「我要修改」後，下一次 /ask 會明確修改該份草稿，不會混到別題
5. 草稿超過 24 小時、已建立或已被清除時，Bot 會提示草稿已失效
```

Teacher batch generation flow:

```text
1. /batch_generate prompt:幫我出資料庫正規化題目，適合大一 count:3
2. Bot 回 3 題草稿預覽 + 「全部建立」/「全部作廢」按鈕
3. 按「全部建立」後，所有題目一次寫入 question_bank
```

## TypeScript Check

```powershell
npx tsc --noEmit
```
