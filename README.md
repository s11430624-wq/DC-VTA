# N8N Classroom Monorepo

這個 repo 現在拆成兩個應用：

- `apps/bot`：Discord 課堂測驗機器人
- `apps/dashboard`：老師前端管理介面

## 常用指令

```powershell
npm run classroom:start
```

同時啟動：

- Discord bot
- 老師 dashboard
- 本機 AI 批改 API

其他常用指令：

```powershell
npm run bot:typecheck
npm run dashboard:build
npm run dashboard:sync-out
```

`dashboard:sync-out` 會把 `apps/dashboard` 同步到 `C:\Users\s9207\teacher-dashboard`（可用 `EXTERNAL_DASHBOARD_DIR` 覆寫目標路徑）。

若要反向拉回（不建議日常使用）：

```powershell
$env:ALLOW_DASHBOARD_SYNC_IN="true"
npm run dashboard:sync-in
```

## 結構

```text
N8N/
  apps/
    bot/
    dashboard/
  docs/
  scripts/
  supabase/
```

## 詳細文件

- Bot 說明：`apps/bot/README.md`
- Dashboard 說明：`apps/dashboard/README.md`
