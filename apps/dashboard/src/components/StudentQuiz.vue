<script setup>
/**
 * StudentQuiz.vue - 舊版學生短答頁
 *
 * 這個路由原先是 LINE LIFF + n8n webhook。
 * 目前已改成直接寫入 Supabase，避免殘留 n8n 依賴。
 */

import { ref, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from '../supabase'
import liff from '@line/liff'

const route = useRoute()

const LIFF_ID = import.meta.env.VITE_LIFF_ID

// ─── 響應式狀態 ───

/** LINE 用戶 ID */
const userId = ref('')

/** LINE 用戶顯示名稱（用於 UI 問候） */
const displayName = ref('')

/** 從 URL 參數取得的題號 */
const questionId = ref(null)

/** 題目內容（從 Supabase 取得） */
const questionContent = ref('')

/** 題目最後發送時間（用於計算反應時間） */
const questionLastSentAt = ref(null)

/** 當前開放題目的群組 ID */
const activeGroupId = ref(null)

/** 學生輸入的答案 */
const answerText = ref('')

/** 頁面初始化載入狀態 */
const isInitializing = ref(true)

/** 送出按鈕的 Loading 狀態 */
const isSubmitting = ref(false)

/** 是否已成功送出 */
const isSubmitted = ref(false)

/** 是否已作答過（重複作答檢查） */
const isAnswered = ref(false)

/** 考試是否已結束（開放狀態檢查） */
const isClosed = ref(false)

/** 錯誤訊息 */
const errorMessage = ref('')

/** 送出按鈕是否可用 */
const canSubmit = computed(() => {
  return answerText.value.trim().length > 0 && !isSubmitting.value && !isSubmitted.value
})

// ─── 初始化流程 ───

onMounted(async () => {
  try {
    // 步驟 1：解析 URL 參數取得題號 (qid)
    // 採用「地毯式搜索」：優先從 URL 抓取，不論是在 search, liff.state 還是 hash 裡
    let qid = null

    // A. 嘗試標準解析 (vue-router)
    if (route.query.qid) {
      qid = route.query.qid
    }

    // B. 強力搜索解析：直接掃描完整的 URL 字串 (防止 LIFF 登入後將參數編碼或移位)
    if (!qid) {
      const fullUrl = window.location.href
      // 搜尋 "?qid=xxx" 或 "&qid=xxx" 或 "%3Fqid%3Dxxx"
      const qidMatch = fullUrl.match(/[?&]qid=([^&?#]+)/) || fullUrl.match(/%3Fqid%3D([^&%?#]+)/)
      if (qidMatch) {
        qid = qidMatch[1]
      }
    }

    // C. 若還沒抓到，嘗試解析 liff.state 內部
    if (!qid) {
      const urlParams = new URLSearchParams(window.location.search)
      const liffState = urlParams.get('liff.state')
      if (liffState) {
        const decodedState = decodeURIComponent(liffState)
        const stateMatch = decodedState.match(/[?&]qid=([^&?#]+)/)
        if (stateMatch) {
          qid = stateMatch[1]
        }
      }
    }

    if (!qid) {
      console.error('URL Debug:', window.location.href)
      throw new Error('缺少題號參數 (qid)，請確認連結是否正確。')
    }
    questionId.value = qid

    // 步驟 2：初始化 LIFF SDK
    await liff.init({ liffId: LIFF_ID })

    // 步驟 3：檢查登入狀態
    if (!liff.isLoggedIn()) {
      // 未登入 → 重導至 LINE 登入頁面（登入後會自動返回此頁面）
      liff.login()
      return
    }

    // 步驟 4：取得用戶 Profile
    const profile = await liff.getProfile()
    userId.value = profile.userId
    displayName.value = profile.displayName || ''

    // 步驟 5：檢查是否已作答（防止重複作答）
    const { data: existingResponse } = await supabase
      .from('quiz_responses')
      .select('id')
      .eq('question_id', qid)
      .eq('user_id', profile.userId)
      .limit(1)

    if (existingResponse && existingResponse.length > 0) {
      isAnswered.value = true
      return // 已作答，不需要繼續載入題目
    }

    // 步驟 6：檢查考試是否仍在開放中
    const { data: activeGroups } = await supabase
      .from('groups')
      .select('id, group_id')
      .eq('current_question_id', qid)
      .eq('is_active', true)
      .limit(1)

    if (!activeGroups || activeGroups.length === 0) {
      isClosed.value = true
      return // 考試已結束，不需要繼續載入題目
    }

    activeGroupId.value = activeGroups[0].group_id || null

    // 步驟 7：從 Supabase 取得題目內容
    await fetchQuestion(qid)
  } catch (err) {
    console.error('初始化失敗:', err)
    errorMessage.value = err.message || '頁面初始化失敗，請重新開啟。'
  } finally {
    isInitializing.value = false
  }
})

// ─── 抓取題目 ───

/**
 * 從 question_bank 表撈取對應題號的題目內容
 */
async function fetchQuestion(qid) {
  const { data, error } = await supabase
    .from('question_bank')
    .select('id, content, question_text, last_sent_at')
    .eq('id', qid)
    .single()

  if (error || !data) {
    throw new Error('找不到此題目，題號可能不存在。')
  }

  // 優先使用 question_text，若無則使用 content
  questionContent.value = data.question_text || data.content || '（題目內容為空）'
  questionLastSentAt.value = data.last_sent_at || null
}

// ─── 送出答案 ───

/**
 * 直接將學生作答寫入 quiz_responses
 */
async function submitAnswer() {
  if (!canSubmit.value) return

  isSubmitting.value = true
  errorMessage.value = ''

  try {
    const { data: latestActiveGroups, error: activeGroupError } = await supabase
      .from('groups')
      .select('group_id')
      .eq('current_question_id', questionId.value)
      .eq('is_active', true)
      .limit(1)

    if (activeGroupError) throw activeGroupError
    if (!latestActiveGroups || latestActiveGroups.length === 0) {
      isClosed.value = true
      throw new Error('這題目前已經關閉，無法再送出。')
    }

    activeGroupId.value = latestActiveGroups[0].group_id || activeGroupId.value

    // 步驟：計算作答反應時間 (秒)
    let reactionTime = null
    if (questionLastSentAt.value) {
      const nowTime = new Date()
      const sentTime = new Date(questionLastSentAt.value)
      // 計算相差的毫秒數並轉換為秒
      const diffMs = nowTime.getTime() - sentTime.getTime()
      // 將毫秒轉換為秒，並四捨五入取到小數點後第一位
      reactionTime = Math.round((diffMs / 1000) * 10) / 10
    }

    const requestBody = {
      user_id: userId.value,
      question_id: Number(questionId.value),
      group_id: activeGroupId.value,
      selected_option: null,
      is_correct: false,
      answer_text: answerText.value.trim(),
      reaction_time: reactionTime,
      status: 'pending'
    }

    const { error } = await supabase
      .from('quiz_responses')
      .insert(requestBody)

    if (error) {
      if (error.code === '23505') {
        isAnswered.value = true
        return
      }
      throw error
    }

    // 送出成功
    isSubmitted.value = true
    alert('✅ 作答成功！')

    // 關閉 LIFF 視窗（回到 LINE 聊天室）
    if (liff.isInClient()) {
      liff.closeWindow()
    }
  } catch (err) {
    console.error('送出作答失敗:', err)
    errorMessage.value = '送出失敗，請稍後再試。若仍失敗，請通知老師確認題目是否仍在開放中。'
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-gradient-to-b from-green-50 to-white flex flex-col">

    <!-- ===== 頂部標題列 ===== -->
    <header class="bg-green-600 text-white px-4 py-3 shadow-md sticky top-0 z-10">
      <div class="flex items-center gap-2">
        <span class="text-xl">📝</span>
        <h1 class="text-lg font-bold">簡答題作答</h1>
      </div>
    </header>

    <!-- ===== 主要內容區 ===== -->
    <main class="flex-1 px-4 py-5 max-w-lg mx-auto w-full">

      <!-- 初始化載入中 -->
      <div v-if="isInitializing" class="space-y-4 animate-pulse">
        <div class="h-4 bg-gray-200 rounded w-1/3"></div>
        <div class="h-24 bg-gray-200 rounded"></div>
        <div class="h-4 bg-gray-200 rounded w-1/4 mt-6"></div>
        <div class="h-32 bg-gray-200 rounded"></div>
        <p class="text-center text-gray-400 text-sm mt-4">載入題目中...</p>
      </div>

      <!-- 初始化錯誤 -->
      <div
        v-else-if="errorMessage && !questionContent && !isAnswered && !isClosed"
        class="bg-red-50 border border-red-200 rounded-xl p-6 text-center"
      >
        <p class="text-4xl mb-3">⚠️</p>
        <p class="text-red-700 font-medium">{{ errorMessage }}</p>
        <button
          @click="window.location.reload()"
          class="mt-4 px-5 py-2 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600 transition-colors"
        >
          重新載入
        </button>
      </div>

      <!-- ===== 已作答狀態 ===== -->
      <div
        v-else-if="isAnswered"
        class="mt-8 text-center"
      >
        <div class="mx-auto w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-5">
          <svg class="w-10 h-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 class="text-xl font-bold text-gray-800 mb-2">您已經完成作答</h2>
        <p class="text-gray-500 leading-relaxed">
          請耐心等待老師批改！
        </p>
        <div class="mt-6 inline-flex items-center gap-1.5 px-4 py-2 bg-green-50 text-green-700 rounded-full text-sm font-medium">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          題號 #{{ questionId }}
        </div>
      </div>

      <!-- ===== 考試已結束狀態 ===== -->
      <div
        v-else-if="isClosed"
        class="mt-8 text-center"
      >
        <div class="mx-auto w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mb-5">
          <svg class="w-10 h-10 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 class="text-xl font-bold text-gray-800 mb-2">考試時間已結束</h2>
        <p class="text-gray-500 leading-relaxed">
          作答連結已關閉，<br/>如有疑問請聯繫老師。
        </p>
        <div class="mt-6 inline-flex items-center gap-1.5 px-4 py-2 bg-red-50 text-red-600 rounded-full text-sm font-medium">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
          題號 #{{ questionId }}
        </div>
      </div>

      <!-- ===== 正常顯示：題目 + 作答 ===== -->
      <template v-else>

        <!-- 用戶問候（若有顯示名稱） -->
        <p v-if="displayName" class="text-sm text-gray-500 mb-4">
          👋 {{ displayName }}，請作答以下題目：
        </p>

        <!-- ── 題目區塊 ── -->
        <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-5">
          <div class="flex items-center gap-2 mb-3">
            <span class="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-semibold rounded-full">
              題號 #{{ questionId }}
            </span>
          </div>
          <p class="text-gray-800 leading-relaxed whitespace-pre-wrap">
            {{ questionContent }}
          </p>
        </section>

        <!-- ── 作答區塊 ── -->
        <section class="mb-5">
          <label for="student-answer" class="block text-sm font-medium text-gray-700 mb-2">
            ✍️ 你的回答
          </label>
          <textarea
            id="student-answer"
            v-model="answerText"
            rows="6"
            placeholder="請在此輸入您的答案..."
            :disabled="isSubmitted"
            class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition resize-none text-base leading-relaxed disabled:bg-gray-100 disabled:text-gray-500"
          ></textarea>
          <p class="text-xs text-gray-400 mt-1.5 text-right">
            已輸入 {{ answerText.length }} 字
          </p>
        </section>

        <!-- 操作中錯誤訊息 -->
        <div
          v-if="errorMessage && questionContent"
          class="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm"
        >
          {{ errorMessage }}
        </div>

        <!-- 已成功送出提示 -->
        <div
          v-if="isSubmitted"
          class="mb-4 p-4 bg-green-50 border border-green-200 text-green-700 rounded-xl text-center"
        >
          <p class="text-2xl mb-1">🎉</p>
          <p class="font-medium">作答已成功送出！</p>
          <p class="text-sm text-green-500 mt-1">你可以關閉此頁面回到 LINE。</p>
        </div>

        <!-- ── 送出按鈕 ── -->
        <button
          @click="submitAnswer"
          :disabled="!canSubmit"
          class="w-full py-3.5 rounded-xl font-semibold text-base transition-all shadow-sm flex items-center justify-center gap-2"
          :class="[
            canSubmit
              ? 'bg-green-600 text-white hover:bg-green-700 active:scale-[0.98] shadow-green-200'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          ]"
        >
          <svg
            v-if="isSubmitting"
            class="w-5 h-5 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          <span v-if="isSubmitting">送出中...</span>
          <span v-else-if="isSubmitted">✅ 已送出</span>
          <span v-else>✅ 確認送出</span>
        </button>
      </template>
    </main>

    <!-- ===== 底部安全間距（防止被手機鍵盤遮擋） ===== -->
    <div class="h-8 shrink-0"></div>
  </div>
</template>
