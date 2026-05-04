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
npm run classroom:start:dev
```

模式說明：

- `classroom:start` 或 `classroom:start:teacher`：老師模式（預設），只使用 `apps/dashboard`，不吃外部固定路徑。
- `classroom:start:dev`：開發模式，允許 `LOCAL_DASHBOARD_DIR` 與外部 fallback。

`dashboard:sync-out` 會把 `apps/dashboard` 同步到外部 dashboard 目錄（可用 `EXTERNAL_DASHBOARD_DIR` 設定目標路徑），此同步只給開發模式使用。

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
