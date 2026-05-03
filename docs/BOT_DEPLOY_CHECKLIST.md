# Bot Deployment Checklist

## 目的

這份清單用於正式啟動 `VTA Discord Bot`。

## 啟動前

1. 確認 `.env` 已完整設定
2. 確認 `FRONTEND_BASE_URL` 指向正式前端
3. 確認 Supabase 可連線
4. 確認 Discord Bot Token 與 Guild ID 正確
5. 確認 `TEACHER_ROLE_ID` / `STUDENT_ROLE_ID` 正確

## 必要環境變數

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

## 啟動步驟

1. 安裝依賴

```powershell
npm install
```

2. 編譯檢查

```powershell
npx tsc --noEmit
```

3. 啟動 bot

```powershell
npx ts-node src/index.ts
```

4. 確認終端出現：

```text
✅ 機器人已上線
✅ Slash Commands 註冊成功
```

## 上線驗收

1. `/help`
2. `/ask prompt:幫我出一題...`
3. `/batch_generate ...`
4. `/open id:...`
5. `/check id:...`
6. `/grading_queue`
7. `/grade_link id:...`

## 風險點

- 不要把 `SUPABASE_SERVICE_ROLE_KEY` 放到前端
- 改 `.env` 後一定要重啟 bot
- 如果正式前端網址變了，要同步更新 `FRONTEND_BASE_URL`

## 回滾點

如果新版本有問題：

1. 還原最近 bot 程式變更
2. 保留資料庫不回滾
3. 重啟回上一版 bot
