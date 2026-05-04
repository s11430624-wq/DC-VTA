# VTA Teacher Manual

## 使用定位

這套系統分成兩部分：

- Discord Bot：出題、發題、收答案、查統計、導去批改
- Teacher Dashboard：短答題批改、AI 輔助批改、分析

## 老師日常流程

### 1. 單題出題

```text
/ask prompt:幫我出一題關於資料庫正規化的四選一題，適合大一
```

流程：

1. Bot 先回題目草稿
2. 你可以按 `我要修改`
3. 確認後按 `同意建立`
4. Bot 會回正式題目 ID

### 2. 批次出題

```text
/batch_generate prompt:幫我出資料庫正規化題目，適合大一 count:3
```

流程：

1. Bot 回多題草稿
2. 按 `全部建立` 或 `全部作廢`

### 3. 發佈題目

選擇題或短答題都用：

```text
/open id:214
```

結果：

- 選擇題：學生按 A/B/C/D 作答
- 短答題：學生按 `提交短答` 後輸入答案

### 4. 查看統計

```text
/check id:214
```

- 選擇題：看答對答錯統計
- 短答題：看提交數與批改連結

### 5. 查看待批改清單

```text
/grading_queue
```

用途：

- 看目前有哪些短答題待批改
- 每題附前端批改連結

### 6. 直接打開某題批改頁

```text
/grade_link id:214
```

用途：

- 取得指定短答題的批改頁連結

### 7. 看排行榜

```text
/rank
/rank limit:5
```

## 學生常用流程

### 綁定

```text
/link student_id:110123456 name:王小明
```

### 查自己資料

```text
/me
```

### 問 Agent

```text
/ask prompt:我目前答對幾題？
```

## 常見問題

### 題目草稿不見了

可能原因：

- 已經建立
- 已作廢
- 超過 24 小時失效
- 你有執行 `/clear_memory`

### 短答批改頁打不開

先確認：

1. 你有登入 teacher dashboard
2. `FRONTEND_BASE_URL` 指向的是正確正式網址
3. 前端已部署最新 deep-link 版本

### Discord 說你不是老師

先確認：

- Discord 有老師身分組
- `TEACHER_ROLE_ID` 設定的是正確的 Discord 老師身分組

## 建議上課前檢查

1. Discord Bot 已啟動
2. Teacher Dashboard 可登入
3. `/help` 正常
4. `/grading_queue` 正常
5. 用一題測 `/open`
6. 用學生帳號測一次作答
7. 用 `/check` 或批改頁確認資料有進資料庫
