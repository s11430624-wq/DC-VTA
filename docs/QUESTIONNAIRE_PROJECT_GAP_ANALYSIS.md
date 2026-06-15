# AI 課堂互動系統：研究問卷與專案差距分析

分析日期：2026-06-10  
分析文件：`論文計畫書_AI互動教學系統V3_含前後測問卷與訪談題綱.docx`

## 一、結論摘要

目前專案已是一套可運作的課堂互動產品，具備 Discord 選擇題、簡答題、問卷文字題、限時作答、立即解析、排行榜、教師分析、AI 出題與 AI 輔助批改。Bot 的 53 個單元測試與型別檢查通過，Dashboard 也可成功建置。

但它還不是一套可以直接支撐論文三軌驗證的「研究資料系統」。最大問題不是畫面不足，而是下列研究證據無法被穩定保存或還原：

1. 計畫書研究載具是 LINE/n8n，正式產品流程是 Discord/Node.js。
2. 正式 7 點量表沒有題組、版本、施測階段、完整性與配對資料模型。
3. AI 分數與教師分數共用欄位，無法可靠計算 ICC 與 MAE。
4. SAQ 的 AI 回饋沒有形成學生可見、可追蹤的介入閉環。
5. 沒有前後測題組、同構題配對、能力向度與總分結構。
6. 缺少模型、Prompt、人工修訂與分段效能的研究日誌。

若現在直接開始正式收案，最可能發生的問題是「功能能用，但研究假說沒有足夠資料可以驗證」。

## 二、問卷構面與系統覆蓋

| 構面/研究目標 | 現有支持 | 主要缺口 | 判定 |
|---|---|---|---|
| LI 介面低阻力 | Discord 內可直接開題、按鈕作答 | 研究文字仍指向 LINE；加入伺服器、安裝 Discord、綁定帳號也是摩擦 | 部分支持 |
| PEOU-MC | A/B/C/D 按鈕、限時、立即結果 | 缺少操作失敗、重試、裝置等客觀事件 | 支持較強 |
| PEOU-SA | Discord modal 文字輸入 | 輸入負擔、鍵盤中斷、取消、逾時與重試沒有完整紀錄 | 部分支持 |
| PU 感知有用性 | MCQ 有正誤、解析、個人統計；教師有分析 | SAQ 回饋不一定送達學生，難證明有助學習 | 部分支持 |
| AFQ AI 回饋品質 | AI 可產生分數與評語 | 回饋主要留在教師 Dashboard；沒有學生查看事件 | 目前不足 |
| GAM 遊戲化互動 | 限時、即時作答數、排行榜、群體同時作答 | 缺少排行榜曝光、互動事件與不同機制版本紀錄 | 部分支持 |
| ITU 持續使用意圖 | 可用後測問卷測量 | 系統內無正式量表流程 | 需補工具 |
| 學習成效 | 可建立 MCQ/SAQ 題目並收答案 | 無前後測 assessment、同構題、分項能力與固定計分 | 目前不足 |
| AI 評分可靠性 | AI 可輸出 0–100 分與評語 | AI/教師分數互相覆寫，無盲評與版本資料 | 關鍵不足 |
| MCQ 生成品質 | 有 AI 草稿與人工確認流程 | 正式題目未保留模型、Prompt、原稿、修訂軌跡 | 關鍵不足 |
| 工程效能 | 有反應時間與整體指令耗時 | 無 LLM、Supabase、Discord API 分段 latency 與錯誤率 | 目前不足 |
| 教師端成效 | 有批次出題、AI 批改、分析 Dashboard | 無備課/批改基準時間、人工修改量與節省時間紀錄 | 部分支持 |

## 三、最高優先改善項目

### P0：正式收案前一定要完成

1. **凍結研究載具與論文版本**
   - 若正式介入使用 Discord，就將 LINE、LIFF、n8n Webhook 等研究文字全面改成 Discord/Node.js。
   - LI 題項應改成不預設「不需下載軟體」，並加入受試者原本是否使用 Discord。
   - 舊 LINE LIFF 頁應標成 legacy 或移出正式研究流程，避免混用。

2. **建立正式問卷資料模型**
   - 至少需要 `study`、`instrument`、`instrument_version`、`item_code`、`phase`、`submission`、`response_value`。
   - 7 點量表必須限制為 1–7，保存一次完整提交，而不是每題各自成為一般問卷題。
   - 支援必填、進度、未完成狀態、反向題 AIA5、開放題與 CSV 匯出。

3. **分離 AI 評分與教師評分**
   - 不再共用單一 `score`。
   - 建議新增不可覆寫的 grading run：`grader_type`、`score`、`feedback`、`model`、`rubric_version`、`created_at`、`reviewer_id`。
   - 教師盲評時不可先看到 AI 分數；之後再以 response id 配對。

4. **建立前後測 assessment**
   - 明確保存 pre/post、測驗版本 A/B、題目對應能力、同構 pair、作答次序與總分。
   - 8 題 MCQ + 2 題 SAQ 應以一次 assessment attempt 管理。
   - 先決定 SAQ 使用 0–5 或 0–100，所有 AI、教師與 MAE 指標使用同一尺度。

5. **讓學生實際收到 AI 回饋**
   - 批改完成後提供 Discord 私密訊息、個人成績頁或 `/feedback` 查詢。
   - 保存 `feedback_delivered_at`、`feedback_viewed_at`、是否展開與是否追問。
   - 沒有這一步，不建議宣稱 AFQ 或「AI 回饋補償 SAQ 輸入阻力」已被實際操弄。

6. **補研究倫理與資料治理**
   - 受試同意、退出、去識別 study id、RLS、角色權限、匯出遮罩、資料保存與刪除期限。
   - 正式研究資料不要只依賴姓名、學號或 Discord ID。

### P1：支撐工程與教師研究

1. 新增 `system_events`，保存請求總時間、LLM latency、DB read/write latency、Discord API latency、成功/失敗與重試。
2. 新增 `question_generation_runs`，保存模型、Prompt、原始輸出、人工修訂、核准時間與最終 question id。
3. 保存教師批改操作時間、AI 建議採用/修改幅度、批次批改失敗率與人工覆寫率。
4. 建立研究匯出頁，輸出乾淨的問卷、assessment、grading pair、event log 與 codebook。
5. 為問卷、前後測、AI/教師評分與匯出邏輯增加自動測試。

### P2：提升解釋力與產品品質

1. 對 MCQ/SAQ 作答順序做隨機化或 counterbalancing，避免題目難度與順序影響 PEOU 比較。
2. 記錄裝置、入口、取消、逾時、重送與失敗原因，讓主觀易用性可和客觀摩擦交叉驗證。
3. 教師 Dashboard 增加研究模式，顯示收案完整率、缺失資料、前後測配對率與盲評進度。
4. 把問卷版本、模型版本、rubric 版本與研究批次鎖定，正式收案期間避免無紀錄改版。

## 四、研究方法上的直接建議

1. **不要把 PLS-SEM 的「適合小樣本」理解成 30–40 人一定足夠。**  
   目前有多個構面與 37 個後測題項，應依最小預期路徑與檢定力做事前 power analysis；若無法增加樣本，優先縮小模型與核心假說。

2. **MCQ 與 SAQ 是同一批學生的重複量測，不是天然的兩個獨立群組。**  
   PEOU-MC 與 PEOU-SA 用成對樣本 t 檢定合理；若要比較兩種情境的結構路徑，PLS-MGA 的群組獨立性與測量不變性需要另外處理。至少先把 MGA 降為探索性分析，或改用能處理相依資料的模型。

3. **若仍使用 MGA，必須先做 measurement invariance。**  
   SmartPLS 官方說明要求 MGA 前以 MICOM 檢查 configural、compositional、均數與變異數不變性。

4. **ICC 必須先定義清楚。**  
   除了 `ICC > .75`，還要寫明 two-way random 或 mixed、absolute agreement 或 consistency、single 或 average measures，並報告 95% CI。AI 與指定教師若是固定評分者，模型選擇不能只寫「ICC」。

5. **問卷應只有一個正式 master version。**  
   文件中同時存在早期單題 PEOU 版本與附錄四題版本，也有重複章節。正式施測前需清理章節、凍結 item code、計分規則與分析模型。

6. **把行為資料當成優勢，不要只靠同一份後測問卷。**  
   反應時間、完成率、取消率、回饋查看率、AI 建議採用率與教師覆寫率，可以降低共同方法偏誤，也能讓訪談與問卷更有說服力。

## 五、三種改善路線

### 路線 A：快速研究可用

使用外部表單工具完成前測、後測與開放題；專案只補：

- 匿名研究碼與學生配對
- AI/教師評分分離
- 前後測題組標記
- AI 回饋學生入口
- 研究事件日誌與 CSV 匯出

優點：改動較小，能較快避免資料不可用。  
缺點：學生會離開 Discord，LI/低摩擦主張會受到外部表單跳轉影響。

### 路線 B：內建「研究模式」（建議）

在 Dashboard/學生 Web 頁建立正式問卷與 assessment runner，Discord 只負責推播與帶入身分。

優點：

- 可一次完成 37 題量表與開放題
- 可控制版本、必填、前後測、配對、同構題與回饋曝光
- 最符合目前 Discord + Vue + Supabase 架構
- 可同時保留低摩擦入口與完整研究資料

缺點：需要新增資料表、學生頁與研究匯出模組。

### 路線 C：回到 LINE/n8n

重新讓 LINE LIFF/n8n 成為正式研究介入，並把 Discord 版本排除在本研究之外。

優點：符合目前計畫書文字。  
缺點：會捨棄或重做大量已成熟的 Discord/Node.js 功能，也增加雙系統維護與資料一致性風險。

**建議選路線 B。** 現有 Discord 系統已具備足夠產品基礎，沒有必要為了舊計畫文字退回 n8n；應修改研究操作化，並補上研究模式與資料可追溯性。

## 六、我對目前專案的看法

這個專案的產品功能其實比問卷工具完整：課堂互動、排行榜、教師分析、AI 出題與批改都已有相當基礎。真正落後的是研究資料工程。

我最在意的不是再加更多華麗功能，而是先確保三件事：

1. 學生到底接受了哪個介入，而且每個人接受的版本一致。
2. 每一項研究指標都能從不可覆寫、可追溯的原始資料重建。
3. 問卷所問的體驗真的曾在學生端發生，例如學生確實看過 AI 回饋。

這三件事補好後，現有系統才會從「好用的教學工具」變成「能支撐可信論文結論的研究工具」。

## 七、方法參考

- SmartPLS, Measurement Invariance Assessment (MICOM): https://www.smartpls.com/documentation/algorithms-and-techniques/micom/
- SmartPLS, Multigroup Analysis (MGA): https://www.smartpls.com/documentation/algorithms-and-techniques/multigroup-analysis/
- Kock & Hadaya (2018), Minimum sample size estimation in PLS-SEM: https://cits.tamiu.edu/kock/pubs/journals/2018/Kock_Hadaya_2018_ISJ_SampleSizePLS.pdf
- Koo & Li (2016), ICC selection and reporting guideline: https://pmc.ncbi.nlm.nih.gov/articles/PMC4913118/
