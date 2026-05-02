給 Codex 的工作計畫
你是一位資深 Node.js / TypeScript / Discord.js / Supabase 工程師。

我要把原本的 n8n + LINE Bot 課堂測驗系統，改成全程式碼版 Discord Bot。

目前 Discord Bot 已經可以啟動，並且 /help 指令可以正常回覆：
「VTA Discord Bot 已成功切換為 Node.js 程式碼模式」

接下來請依照以下計畫實作，不要一次做完全部功能，請分階段完成，並且每一階段都要確保可以執行與測試。

技術棧：
- Node.js
- TypeScript
- discord.js v14
- Supabase
- dotenv

請先檢查目前專案結構，沿用現有風格，不要大幅重構已經可運作的程式碼。
Phase 1：整理基礎架構
目標：
建立穩定的 Discord Bot + Supabase 基礎架構。

請完成：

1. 檢查 .env 是否支援以下環境變數：
   - DISCORD_TOKEN
   - DISCORD_CLIENT_ID
   - DISCORD_GUILD_ID
   - SUPABASE_URL
   - SUPABASE_SERVICE_ROLE_KEY
   - TEACHER_ROLE_ID
   - STUDENT_ROLE_ID

2. 建立 Supabase client：
   檔案：src/services/supabase.ts

3. 建立 user service：
   檔案：src/services/userService.ts

   需要功能：
   - getUserByDiscordId(discordUserId)
   - linkStudent(discordUserId, displayName, studentId)
   - getUserRole(discordUserId)

4. 建立 question service：
   檔案：src/services/questionService.ts

   需要功能：
   - getRecentQuestions(limit = 10)
   - getQuestionById(id)

5. 建立基本錯誤處理工具：
   檔案：src/utils/errorHandler.ts

   需要功能：
   - safeReply(interaction, content)
   - formatError(error)

要求：
- 所有 Supabase 查詢都要檢查 error
- 不要把 service role key 輸出到 console
- 缺少環境變數時，啟動時要明確報錯
Phase 2：實作 /link
目標：
讓 Discord 使用者可以綁定學號，寫入 Supabase users 表。

Slash Command：
/link student_id name

參數：
- student_id：String，必填
- name：String，必填

寫入資料表：
users

欄位對應：
- user_id = Discord user id
- display_name = 使用者輸入的 name
- student_id = 使用者輸入的 student_id
- role = student

如果 users 表有 platform 欄位，請額外寫入：
- platform = discord

邏輯：
1. 取得 interaction.user.id
2. 取得 student_id、name
3. 查詢 users 是否已存在該 user_id
4. 如果不存在：新增一筆 student
5. 如果已存在：更新 display_name、student_id，role 保持原本值，除非原本沒有 role 才設為 student
6. 回覆 Discord

成功回覆：
✅ 綁定成功！
姓名：xxx
學號：xxx

失敗回覆：
❌ 綁定失敗，請稍後再試。

注意：
- 回覆使用 ephemeral: true
- 不要讓其他人看到學生資料
Phase 3：實作 /me
目標：
讓使用者查詢自己的綁定資料。

Slash Command：
/me

邏輯：
1. 取得 Discord user id
2. 查 users
3. 如果找不到，回覆：
   你尚未綁定學號，請先使用 /link student_id:你的學號 name:你的姓名
4. 如果找到，顯示：
   👤 我的資料
   姓名：xxx
   學號：xxx
   身分：student / teacher

注意：
- 回覆使用 ephemeral: true
Phase 4：實作 /list
目標：
列出 question_bank 最近 10 筆題目。

Slash Command：
/list

Supabase：
table: question_bank

邏輯：
1. 查詢 question_bank
2. 依 id 由大到小取 10 筆
3. 顯示時再反轉成 id 由小到大
4. 每題顯示：
   - id
   - category 或 metadata.topic
   - content 前 40 字

回覆格式：
📂 題庫總覽（最近 10 筆）
------------------
🆔 12 [資料庫]
什麼是 Primary Key？

🆔 13 [網路]
HTTP 與 HTTPS 的差異是什麼？

💡 使用 /question id:12 查看詳情

注意：
- 如果沒有題目，回覆「目前題庫沒有資料」
- 可以使用普通文字，不一定要 Embed
Phase 5：實作 /question
目標：
查詢指定題目詳情。

Slash Command：
/question id

參數：
- id：Integer，必填

Supabase：
table: question_bank

顯示內容：
- id
- category 或 metadata.topic
- question_type
- content
- 選擇題選項 A/B/C/D
- correct_answer
- explanation
- rubric
- embedding 是否存在

如果是 multiple_choice：
顯示 options 和 correct_answer

如果是 short_answer：
顯示 rubric

回覆格式：
🧐 題目詳情 ID: 12
📂 分類：xxx
📝 題目：
xxx

選項：
A. xxx
B. xxx
C. xxx
D. xxx

答案：A
解析：xxx

Vector：✅ 已生成 / ⬜ NULL
Phase 6：建立權限判斷
目標：
只有老師可以使用 /add、/open、/close、/check。

建立：
src/utils/roleGuard.ts

功能：
- isTeacher(interaction)
- requireTeacher(interaction)

判斷方式：
優先使用 Discord role：
- interaction.member.roles.cache.has(process.env.TEACHER_ROLE_ID)

如果抓不到 role，再 fallback 查 Supabase users.role === 'teacher'

沒有權限時回覆：
⛔ 你沒有權限使用此指令。

注意：
- 權限錯誤回覆使用 ephemeral: true
Phase 7：實作 /add
目標：
讓老師新增題目到 question_bank。

Slash Command：
/add content

參數：
- content：String，必填

先做簡化版，不接 AI 產題。

寫入 question_bank：
- content = content
- category = "一般"
- question_type = "multiple_choice"
- metadata = {
    "options": ["選項A", "選項B", "選項C", "選項D"],
    "correct_answer": "A",
    "explanation": ""
  }

注意：
這階段先讓資料庫寫入流程通，不需要 AI 自動產題。
之後再擴充成 AI JSON 產題。

成功回覆：
✅ 題目新增成功！
ID：xxx
題目：xxx
Phase 8：實作 /open
目標：
老師開放某一題，Bot 在目前頻道送出題目 Embed + A/B/C/D 按鈕。

Slash Command：
/open id

參數：
- id：Integer，必填

流程：
1. requireTeacher
2. 查 question_bank
3. 如果找不到，回覆找不到題目
4. 如果是 multiple_choice，送出 Embed + Buttons
5. Button custom_id 格式：
   answer:qid=12:opt=A
   answer:qid=12:opt=B
   answer:qid=12:opt=C
   answer:qid=12:opt=D

Embed 顯示：
📝 第 12 題
題目內容

A. xxx
B. xxx
C. xxx
D. xxx

按鈕：
A、B、C、D

成功後回覆老師：
✅ 已開放第 12 題
Phase 9：處理按鈕答題
目標：
學生點 A/B/C/D 後，寫入 quiz_responses，並回覆答題結果。

Interaction 類型：
Button interaction

custom_id 格式：
answer:qid=12:opt=A

流程：
1. parse custom_id，取得 question_id 和 selected_option
2. 取得 interaction.user.id
3. 查 users，若未註冊，回覆：
   請先使用 /link 綁定學號
4. 查 question_bank
5. 比對 metadata.correct_answer
6. 寫入 quiz_responses：
   - user_id = Discord user id
   - question_id
   - selected_option
   - is_correct
7. 如果 scoreboard 表存在，也寫入或更新：
   - user_id
   - display_name
   - student_id
   - question_id
   - selected_option
   - is_correct
8. 回覆學生：
   答對：✅ 答對了！
   答錯：❌ 答錯了，正確答案是 X

注意：
- 回覆使用 ephemeral: true
- 同一題同一人重複作答時，請更新舊紀錄或阻止重複作答，請選一種方式並註明
- 建議選擇「更新舊紀錄」
Phase 10：實作 /check
目標：
老師查看指定題目的答題統計。

Slash Command：
/check id

參數：
- id：Integer，必填

流程：
1. requireTeacher
2. 查 quiz_responses 或 scoreboard
3. 統計答對、答錯
4. 顯示名單：
   ✅ 答對人數
   ❌ 答錯人數

回覆格式：
📊 第 12 題完整統計

✅ 答對人數：3 人
1. 王小明 (110123456) [選A]

❌ 答錯人數：2 人
1. 李小華 (110123457) [選C]
Phase 11：實作 /rank
目標：
顯示學生排行榜。

Slash Command：
/rank

流程：
1. 從 quiz_responses 或 scoreboard 統計每個 user_id 答對數
2. 依答對數排序
3. 顯示前 10 名

回覆格式：
🏆 排行榜 Top 10

1. 王小明 - 10 分
2. 李小華 - 8 分
3. 陳小美 - 6 分
Phase 12：測試與清理
請完成以下測試：

1. /help 可正常回覆
2. /link 可寫入 users
3. /me 可查詢自己
4. /list 可列出題庫
5. /question 可查看題目詳情
6. 老師可用 /open
7. 學生點 A/B/C/D 可寫入 quiz_responses
8. /check 可顯示統計
9. /rank 可顯示排行榜
10. 沒有老師角色的人不能使用老師指令

最後請整理：
- 已新增檔案
- 已修改檔案
- 需要設定的 .env
- 如何啟動
- 如何註冊 slash commands
最後再補一句給 Codex
請先只完成 Phase 1 到 Phase 4，完成後停止，並列出你做了哪些檔案修改。不要一次實作到按鈕答題，避免範圍太大。