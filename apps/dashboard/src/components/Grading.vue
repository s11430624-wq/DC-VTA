<script setup>
import { ref, onMounted, watch, inject } from 'vue'
import { supabase } from '../supabase'
import { ClipboardCheck, Bot, Send, Loader2, FileText, RefreshCw, X, Award, Eye } from 'lucide-vue-next'
import { requestAiGrade } from '../services/aiGrading'
import { deriveShortAnswerCorrectness, normalizeShortAnswerScore } from '../utils/grading'

const props = defineProps({
  initialStatus: { type: String, default: 'pending' },
  initialQuestionId: { type: [String, Number], default: null },
  initialResponseId: { type: [String, Number], default: null },
})

const uiVariant = inject('uiVariant', ref('classic'))

const normalizeStatus = (status) => status === 'graded' ? 'graded' : 'pending'
const parseNumericId = (value) => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const currentTab = ref(normalizeStatus(props.initialStatus))
const pendingResponses = ref([])
const selectedResponse = ref(null)
const isMobileDrawerActive = ref(false)
const score = ref(null)
const feedback = ref('')
const editableRubric = ref('')
const isUpdatingRubric = ref(false)
const isLoading = ref(false)
const isAILoading = ref(false)
const isSubmitting = ref(false)
const isBatchGrading = ref(false)
const batchProgress = ref({ current: 0, total: 0 })
const errorMessage = ref('')

function getQuestionImageUrl(question) {
  const metadata = question?.metadata
  const parsed = typeof metadata === 'string' ? (() => {
    try {
      const value = JSON.parse(metadata)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch {
      return null
    }
  })() : metadata
  const imageUrl = parsed?.image_url
  return typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl) ? imageUrl : ''
}

const deepLinkTarget = ref({ responseId: null, questionId: null, attemptedTabs: new Set(), applied: false, missing: false })

function buildGradingPayload(response) {
  return {
    questionId: response.question_id,
    responseId: response.id,
    questionContent: response.question_bank?.content || '',
    rubric: response.question_bank?.rubric || '',
    answerText: response.answer_text || '',
  }
}

async function persistGradingResult(responseId, rawScore, rawFeedback) {
  const normalizedScore = normalizeShortAnswerScore(rawScore)
  if (normalizedScore === null) {
    throw new Error('分數格式錯誤。')
  }

  const { error } = await supabase
    .from('quiz_responses')
    .update({
      score: normalizedScore,
      ai_feedback: rawFeedback || '',
      status: 'graded',
      is_correct: deriveShortAnswerCorrectness(normalizedScore),
    })
    .eq('id', responseId)

  if (error) throw error
}

function resetEditorState() {
  selectedResponse.value = null
  isMobileDrawerActive.value = false
  score.value = null
  feedback.value = ''
  editableRubric.value = ''
}

function setDeepLinkTarget() {
  deepLinkTarget.value = {
    responseId: parseNumericId(props.initialResponseId),
    questionId: parseNumericId(props.initialQuestionId),
    attemptedTabs: new Set(),
    applied: false,
    missing: false,
  }
}

function hasDeepLinkTarget() {
  return deepLinkTarget.value.responseId !== null || deepLinkTarget.value.questionId !== null
}

function selectResponse(response) {
  selectedResponse.value = response
  isMobileDrawerActive.value = true
  errorMessage.value = ''
  if (response.status === 'graded') {
    score.value = response.score ?? null
    feedback.value = response.ai_feedback || ''
  } else {
    score.value = null
    feedback.value = ''
  }
  editableRubric.value = response.question_bank?.rubric || ''
}

function tryApplyDeepLinkSelection() {
  if (!hasDeepLinkTarget() || deepLinkTarget.value.applied) return false

  const matched = pendingResponses.value.find((response) => {
    if (deepLinkTarget.value.responseId !== null) return response.id === deepLinkTarget.value.responseId
    return response.question_id === deepLinkTarget.value.questionId
  })

  if (!matched) return false

  selectResponse(matched)
  deepLinkTarget.value.applied = true
  deepLinkTarget.value.missing = false
  return true
}

function showMissingDeepLinkMessage() {
  if (deepLinkTarget.value.missing || deepLinkTarget.value.applied) return
  deepLinkTarget.value.missing = true
  errorMessage.value = deepLinkTarget.value.responseId !== null
    ? `找不到指定的作答紀錄 #${deepLinkTarget.value.responseId}，可能已不存在或不屬於簡答題。`
    : `找不到題號 #${deepLinkTarget.value.questionId} 的簡答作答，可能尚未有人提交。`
}

async function fetchResponses() {
  isLoading.value = true
  errorMessage.value = ''
  resetEditorState()

  try {
    const { data, error } = await supabase
      .from('quiz_responses')
      .select(`
        id,
        user_id,
        question_id,
        group_id,
        answer_text,
        score,
        ai_feedback,
        status,
        reaction_time,
        created_at,
        question_bank!inner ( rubric, content, metadata, question_type ),
        users ( display_name, student_id )
      `)
      .eq('status', currentTab.value)
      .eq('question_bank.question_type', 'short_answer')
      .order('created_at', { ascending: false })

    if (error) throw error

    pendingResponses.value = data || []

    if (tryApplyDeepLinkSelection()) {
      return
    }

    if (pendingResponses.value.length > 0) {
      selectResponse(pendingResponses.value[0])
    }

    if (hasDeepLinkTarget()) {
      deepLinkTarget.value.attemptedTabs.add(currentTab.value)
      const triedPending = deepLinkTarget.value.attemptedTabs.has('pending')
      const triedGraded = deepLinkTarget.value.attemptedTabs.has('graded')

      if (!triedPending || !triedGraded) {
        const alternateTab = currentTab.value === 'pending' ? 'graded' : 'pending'
        if (!deepLinkTarget.value.attemptedTabs.has(alternateTab)) {
          currentTab.value = alternateTab
          await fetchResponses()
          return
        }
      }

      showMissingDeepLinkMessage()
    }
  } catch (err) {
    console.error('撈取資料失敗:', err)
    errorMessage.value = '載入資料失敗，請重試。'
  } finally {
    isLoading.value = false
  }
}

function switchTab(tab) {
  if (tab === currentTab.value) return
  currentTab.value = tab
  if (hasDeepLinkTarget()) {
    deepLinkTarget.value.applied = false
    deepLinkTarget.value.missing = false
    deepLinkTarget.value.attemptedTabs = new Set()
  }
  fetchResponses()
}

async function handleAIAssist() {
  if (!selectedResponse.value) return
  isAILoading.value = true
  errorMessage.value = ''

  try {
    const data = await requestAiGrade(buildGradingPayload(selectedResponse.value))
    score.value = data.score
    feedback.value = data.feedback
  } catch (err) {
    console.error('AI 輔助批改失敗:', err)
    errorMessage.value = err instanceof Error ? err.message : 'AI 輔助批改失敗，請稍後重試或手動批改。'
  } finally {
    isAILoading.value = false
  }
}

async function handleBatchGrading() {
  if (pendingResponses.value.length === 0) return
  const total = pendingResponses.value.length
  if (!confirm(`確定要讓 AI 自動批改並送出清單中的 ${total} 份考卷嗎？`)) return

  isBatchGrading.value = true
  batchProgress.value = { current: 0, total }

  try {
    let failedCount = 0

    for (const response of pendingResponses.value) {
      try {
        const data = await requestAiGrade(buildGradingPayload(response))
        await persistGradingResult(response.id, data.score, data.feedback)
      } catch (err) {
        console.error(`批改 ID ${response.id} 發生例外:`, err)
        failedCount++
      }
      batchProgress.value.current++
    }

    alert(failedCount === 0 ? '🎉 全班自動批改完成！' : `⚠️ 批改完成，但有 ${failedCount} 份失敗，請手動確認。`)
    resetEditorState()
    errorMessage.value = ''
    await fetchResponses()
  } finally {
    isBatchGrading.value = false
    batchProgress.value = { current: 0, total: 0 }
  }
}

async function updateRubric() {
  if (!selectedResponse.value) return
  isUpdatingRubric.value = true
  errorMessage.value = ''

  try {
    const { error } = await supabase.from('question_bank').update({ rubric: editableRubric.value }).eq('id', selectedResponse.value.question_id)
    if (error) throw error
    if (selectedResponse.value.question_bank) selectedResponse.value.question_bank.rubric = editableRubric.value
    alert('✅ 評分標準已更新至題庫！')
  } catch (err) {
    console.error('更新評分標準失敗:', err)
    errorMessage.value = '更新評分標準失敗，請重試。'
  } finally {
    isUpdatingRubric.value = false
  }
}

async function submitGrading() {
  if (!selectedResponse.value) return
  if (score.value === null || score.value === '') {
    errorMessage.value = '請輸入分數後再送出。'
    return
  }

  isSubmitting.value = true
  errorMessage.value = ''
  const isReGrading = selectedResponse.value.status === 'graded'

  try {
    await persistGradingResult(selectedResponse.value.id, score.value, feedback.value)
    alert(isReGrading ? '✅ 成績已成功更新！' : '✅ 批改結果已成功送出！')
    resetEditorState()
    await fetchResponses()
  } catch (err) {
    console.error('送出批改失敗:', err)
    errorMessage.value = '送出批改失敗，請重試。'
  } finally {
    isSubmitting.value = false
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  return date.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatReactionTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)} 秒` : '—'
}

watch(() => [props.initialStatus, props.initialQuestionId, props.initialResponseId], () => {
  currentTab.value = normalizeStatus(props.initialStatus)
  setDeepLinkTarget()
  fetchResponses()
})

onMounted(() => {
  setDeepLinkTarget()
  fetchResponses()
})

defineExpose({ fetchResponses })
</script>

<template>
  <div class="w-full">
    <!-- ============================================== -->
    <!-- Option A: Redesigned UI Layout (Academic)      -->
    <!-- ============================================== -->
    <div v-if="uiVariant === 'redesigned'" class="w-full">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 sm:mb-6 bg-white p-4 rounded-xl border border-slate-200/60 shadow-academic animate-fadeIn">
        <div class="flex items-center gap-2.5">
          <div class="p-2 bg-blue-50 text-blue-600 rounded-lg">
            <ClipboardCheck class="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <h2 class="text-lg sm:text-xl font-bold text-slate-800">簡答題批改</h2>
          <span v-if="currentTab === 'pending' && pendingResponses.length > 0" class="px-2.5 py-0.5 text-xs font-bold bg-amber-50 text-amber-600 border border-amber-100 rounded-full animate-pulse">{{ pendingResponses.length }} 待審閱</span>
          <span v-if="currentTab === 'graded' && pendingResponses.length > 0" class="px-2.5 py-0.5 text-xs font-bold bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-full">{{ pendingResponses.length }} 已完成</span>
        </div>
      </div>

      <div v-if="errorMessage" class="mb-4 p-3.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl flex items-center justify-between shadow-sm animate-fadeIn">
        <span class="text-xs sm:text-sm font-semibold">{{ errorMessage }}</span>
        <button @click="errorMessage = ''" class="text-rose-400 hover:text-rose-600 text-lg leading-none touch-target btn-academic-active">&times;</button>
      </div>

      <!-- Main Dual Pane Workspace -->
      <div class="flex flex-col lg:flex-row gap-6 h-[calc(100vh-200px)] min-h-[600px] relative">
        
        <!-- Left Pane: Submissions list (Always visible) -->
        <div class="w-full lg:w-1/3 flex flex-col h-full shrink-0">
          <div class="bg-white rounded-2xl border border-slate-200/60 flex-1 flex flex-col overflow-hidden shadow-academic">
            <!-- Sidebar tabs -->
            <div class="flex border-b border-slate-100 bg-slate-50/50 p-1">
              <button 
                @click="switchTab('pending')" 
                class="flex-1 py-2.5 text-xs sm:text-sm font-bold text-center transition-smooth rounded-xl touch-target btn-academic-active" 
                :class="currentTab === 'pending' ? 'text-blue-600 bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800'"
              >
                📋 待批改
              </button>
              <button 
                @click="switchTab('graded')" 
                class="flex-1 py-2.5 text-xs sm:text-sm font-bold text-center transition-smooth rounded-xl touch-target btn-academic-active" 
                :class="currentTab === 'graded' ? 'text-emerald-700 bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800'"
              >
                ✅ 已批改
              </button>
            </div>

            <!-- Batch Grading Action -->
            <div v-if="currentTab === 'pending'" class="px-4 py-3 border-b border-slate-100 bg-slate-50/20">
              <button 
                @click="handleBatchGrading" 
                :disabled="pendingResponses.length === 0 || isBatchGrading" 
                class="w-full flex justify-center items-center gap-2 py-2.5 px-3 rounded-xl text-white font-semibold transition-smooth shadow-sm bg-gradient-to-r from-blue-500 to-indigo-600 hover:shadow-md btn-academic-active touch-target disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <template v-if="isBatchGrading">
                  <Loader2 class="w-4 h-4 animate-spin relative z-10" />
                  <span class="relative z-10 text-xs">AI 一鍵自動批改中 ({{ batchProgress.current }}/{{ batchProgress.total }})</span>
                </template>
                <template v-else>
                  <span class="text-base relative z-10">🪄</span>
                  <span class="text-xs relative z-10">AI 一鍵全自動批改</span>
                </template>
              </button>
            </div>

            <!-- List viewport -->
            <div v-if="isLoading" class="flex-1 flex flex-col items-center justify-center text-slate-400">
              <Loader2 class="w-6 h-6 animate-spin mr-2 text-blue-600 mb-2" />
              <span class="text-xs font-semibold">資料同步中...</span>
            </div>
            <div v-else-if="pendingResponses.length === 0" class="flex-1 flex flex-col items-center justify-center text-slate-400 px-4">
              <ClipboardCheck class="w-12 h-12 mb-3 text-slate-200" />
              <p class="text-xs font-semibold text-center">{{ currentTab === 'pending' ? '目前無待批改的簡答題' : '目前無已批改的紀錄' }}</p>
            </div>

            <div v-else class="flex-1 overflow-y-auto divide-y divide-slate-100">
              <button 
                v-for="response in pendingResponses" 
                :key="response.id" 
                @click="selectResponse(response)" 
                class="w-full text-left px-4 py-3.5 hover:bg-slate-50 transition-smooth focus:outline-none flex flex-col gap-1 touch-target border-l-4" 
                :class="selectedResponse?.id === response.id ? 'border-l-blue-600 bg-blue-50/30' : 'border-l-transparent'"
              >
                <div class="flex items-center justify-between mb-0.5">
                  <span class="font-bold text-slate-800 text-sm truncate">{{ response.users?.display_name || response.user_id }}</span>
                  <div class="flex items-center gap-1.5 ml-2 shrink-0">
                    <span v-if="response.status === 'graded' && response.score != null" class="text-[10px] font-bold px-1.5 py-0.5 rounded-full" :class="response.score >= 80 ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : response.score >= 60 ? 'bg-amber-50 text-amber-700 border border-amber-100' : 'bg-rose-50 text-rose-700 border border-rose-100'">{{ response.score }}分</span>
                    <span class="text-[10px] text-slate-400 font-mono font-bold bg-slate-50 px-1.5 py-0.2 border border-slate-100 rounded">#{{ response.question_id }}</span>
                  </div>
                </div>
                <p v-if="response.users?.student_id" class="text-[10px] font-semibold text-slate-400 leading-none mb-1">學號：{{ response.users.student_id }}</p>
                <p class="text-[10px] text-slate-400 font-medium mb-1.5">{{ formatTime(response.created_at) }}</p>
                <p class="text-xs text-slate-500 font-medium line-clamp-2 bg-slate-50 p-2 rounded-lg border border-slate-100/50">{{ response.answer_text || '（無作答內容）' }}</p>
              </button>
            </div>
          </div>
        </div>

        <!-- Right Pane: PC Workspace View (lg:block hidden) -->
        <div class="hidden lg:flex lg:w-2/3 flex-col h-full shrink-0">
          <div class="bg-white rounded-2xl border border-slate-200/60 flex-1 flex flex-col overflow-hidden shadow-academic">
            <div v-if="!selectedResponse" class="flex-1 flex flex-col items-center justify-center text-slate-400">
              <FileText class="w-16 h-16 mb-4 text-slate-200" />
              <p class="text-base font-bold text-slate-800 mb-1">學者雙欄對照工作台</p>
              <p class="text-xs text-slate-400">請從左側點選學生作答，開啟深度批改面板。</p>
            </div>

            <!-- Detail area (PC) -->
            <template v-else>
              <div class="p-6 border-b border-slate-100 flex-1 overflow-y-auto min-h-0 space-y-5">
                
                <!-- Student Header -->
                <div class="flex items-center gap-3 pb-4 border-b border-slate-100">
                  <div class="w-10 h-10 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-base shadow-sm">
                    {{ (selectedResponse.users?.display_name || selectedResponse.user_id || '?').charAt(0) }}
                  </div>
                  <div class="flex-1">
                    <p class="font-bold text-slate-800 text-base leading-tight">{{ selectedResponse.users?.display_name || selectedResponse.user_id }}</p>
                    <p class="text-[11px] text-slate-400 font-medium mt-0.5">題號 #{{ selectedResponse.question_id }} · 作答 #{{ selectedResponse.id }} · {{ formatTime(selectedResponse.created_at) }}</p>
                  </div>
                  <span v-if="selectedResponse.status === 'graded'" class="px-2.5 py-0.5 text-xs font-bold bg-emerald-50 text-emerald-700 rounded-full border border-emerald-100">已批改</span>
                  <span v-else class="px-2.5 py-0.5 text-xs font-bold bg-amber-50 text-amber-700 rounded-full border border-amber-100 animate-pulse">待審閱</span>
                </div>

                <!-- Question details -->
                <div v-if="selectedResponse.question_bank?.content || getQuestionImageUrl(selectedResponse.question_bank)">
                  <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5"><Eye class="w-4 h-4 text-slate-400" /> 📋 題目內容</h4>
                  <div v-if="selectedResponse.question_bank?.content" class="p-4 bg-slate-50 rounded-xl text-slate-700 text-sm leading-relaxed font-semibold border border-slate-100">{{ selectedResponse.question_bank.content }}</div>
                  <img
                    v-if="getQuestionImageUrl(selectedResponse.question_bank)"
                    :src="getQuestionImageUrl(selectedResponse.question_bank)"
                    alt="題目圖片"
                    class="mt-3 max-h-60 rounded-xl border border-slate-200 object-contain shadow-sm"
                  />
                </div>

                <!-- Student answers -->
                <div>
                  <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5"><FileText class="w-4 h-4 text-blue-500" /> ✍️ 學生作答內容</h4>
                  <div class="p-4 bg-blue-50/50 rounded-xl text-slate-800 text-sm font-semibold leading-relaxed border border-blue-100">{{ selectedResponse.answer_text || '（無作答內容）' }}</div>
                </div>

                <!-- Quick specs grid -->
                <div class="grid grid-cols-3 gap-4">
                  <div class="p-3 rounded-xl border border-slate-200/60 bg-white">
                    <p class="text-[10px] font-bold text-slate-400 mb-1">作答反應時間</p>
                    <p class="text-sm font-bold text-slate-800">{{ formatReactionTime(selectedResponse.reaction_time) }}</p>
                  </div>
                  <div class="p-3 rounded-xl border border-slate-200/60 bg-white">
                    <p class="text-[10px] font-bold text-slate-400 mb-1">群組小隊</p>
                    <p class="text-sm font-bold text-slate-800 truncate">{{ selectedResponse.group_id || '—' }}</p>
                  </div>
                  <div class="p-3 rounded-xl border border-slate-200/60 bg-white">
                    <p class="text-[10px] font-bold text-slate-400 mb-1">作答審核狀態</p>
                    <p class="text-sm font-bold text-slate-800 uppercase font-mono">{{ selectedResponse.status }}</p>
                  </div>
                </div>

                <!-- Score Rubrics -->
                <div>
                  <div class="flex items-center justify-between mb-2">
                    <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5"><Award class="w-4 h-4 text-purple-600" /> 📐 評分細則</h4>
                    <button @click="updateRubric" :disabled="isUpdatingRubric" class="flex items-center gap-1.5 px-3 py-1 bg-purple-50 text-purple-700 border border-purple-100 hover:bg-purple-100 rounded-lg text-xs font-bold transition-smooth btn-academic-active disabled:opacity-50 touch-target"><Loader2 v-if="isUpdatingRubric" class="w-3.5 h-3.5 animate-spin" /><span v-else>💾</span>{{ isUpdatingRubric ? '更新中' : '同步至題庫' }}</button>
                  </div>
                  <textarea v-model="editableRubric" rows="3" placeholder="請輸入評分標準..." class="w-full px-3.5 py-2.5 border border-purple-100 rounded-xl bg-purple-50/20 focus:ring-2 focus:ring-purple-500/10 focus:border-purple-400 outline-none transition-smooth resize-none text-sm text-slate-700 font-semibold leading-relaxed shadow-sm"></textarea>
                </div>
              </div>

              <!-- Grading inputs pane (PC Bottom) -->
              <div class="p-5 bg-slate-50 border-t border-slate-100 space-y-4 shrink-0 shadow-sm">
                <div class="grid grid-cols-4 gap-4">
                  <!-- Score input + quick buttons -->
                  <div class="col-span-1">
                    <label for="grading-score" class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">評定分數</label>
                    <input id="grading-score" v-model.number="score" type="number" min="0" max="100" placeholder="0–100" class="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-smooth text-center text-xl font-bold text-slate-800 shadow-sm" />
                    
                    <!-- Quick Scores -->
                    <div class="flex gap-1 mt-2">
                      <button v-for="val in [60, 80, 90, 100]" :key="val" @click="score = val" class="flex-1 py-1 text-[10px] font-bold border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 rounded-md transition-smooth btn-academic-active touch-target">{{ val }}</button>
                    </div>
                  </div>
                  
                  <!-- Feedback area -->
                  <div class="col-span-3">
                    <label for="grading-feedback" class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">評語與輔導建議</label>
                    <textarea id="grading-feedback" v-model="feedback" rows="2" placeholder="請輸入評語，或點擊左下「AI 輔助批改」自動評分與點評..." class="w-full px-3.5 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-smooth resize-none text-xs font-semibold text-slate-700 shadow-sm leading-relaxed"></textarea>
                  </div>
                </div>

                <div class="flex items-center gap-3 pt-1">
                  <button @click="handleAIAssist" :disabled="isAILoading" class="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-violet-500 to-indigo-600 text-white rounded-xl hover:shadow-md transition-smooth font-bold text-sm btn-academic-active touch-target disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"><Loader2 v-if="isAILoading" class="w-4 h-4 animate-spin" /><Bot v-else class="w-4 h-4" />{{ isAILoading ? 'AI 分析評估中...' : '🤖 AI 輔助批改' }}</button>
                  
                  <button @click="submitGrading" :disabled="isSubmitting || score === null || score === ''" class="flex items-center gap-2 px-5 py-2.5 text-white rounded-xl transition-smooth font-bold text-sm shadow-md disabled:opacity-50 disabled:cursor-not-allowed ml-auto btn-academic-active touch-target shadow-blue-500/10" :class="selectedResponse.status === 'graded' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'"><Loader2 v-if="isSubmitting" class="w-4 h-4 animate-spin" /><RefreshCw v-else-if="selectedResponse.status === 'graded'" class="w-4 h-4" /><Send v-else class="w-4 h-4" />{{ isSubmitting ? '送出中...' : (selectedResponse.status === 'graded' ? '🔄 更新批改成績' : '✅ 確認送出成績') }}</button>
                </div>
              </div>
            </template>
          </div>
        </div>

      </div>

      <!-- Option A: Mobile Drawer Overlay (lg:hidden) -->
      <Transition name="drawer">
        <div v-if="isMobileDrawerActive && selectedResponse" class="lg:hidden fixed inset-0 z-50 flex">
          <!-- Backdrop overlay -->
          <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" @click="isMobileDrawerActive = false"></div>
          
          <!-- Drawer sliding sheet -->
          <div class="relative flex flex-col w-full bg-white h-[90vh] mt-auto rounded-t-3xl shadow-2xl overflow-hidden border-t border-slate-200">
            <!-- Header bar -->
            <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0 bg-slate-50/50">
              <div class="flex items-center gap-2">
                <span class="text-base">📝</span>
                <span class="font-bold text-slate-800 text-sm">批改：{{ selectedResponse.users?.display_name || '學生作答' }}</span>
              </div>
              <button @click="isMobileDrawerActive = false" class="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 touch-target flex items-center justify-center btn-academic-active"><X class="w-5 h-5" /></button>
            </div>
            
            <!-- Drawer Body (Scrollable viewport) -->
            <div class="flex-1 overflow-y-auto px-5 py-4 space-y-4 no-scrollbar">
              <!-- Question Context -->
              <div v-if="selectedResponse.question_bank?.content">
                <h5 class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">📋 題目描述</h5>
                <div class="p-3 bg-slate-50 border border-slate-100 rounded-xl text-slate-700 text-xs font-semibold leading-relaxed">{{ selectedResponse.question_bank.content }}</div>
              </div>

              <!-- Student answer -->
              <div>
                <h5 class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">✍️ 學生回答</h5>
                <div class="p-3 bg-blue-50/50 border border-blue-100 rounded-xl text-slate-800 text-xs font-semibold leading-relaxed">{{ selectedResponse.answer_text || '（無作答內容）' }}</div>
              </div>

              <!-- AI Rubrics -->
              <div>
                <div class="flex items-center justify-between mb-1.5">
                  <h5 class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">📐 評分細則</h5>
                  <button @click="updateRubric" class="text-[10px] font-bold text-purple-600 bg-purple-50 border border-purple-100 px-2 py-0.5 rounded">{{ isUpdatingRubric ? '同步中' : '同步標準' }}</button>
                </div>
                <textarea v-model="editableRubric" rows="2" class="w-full p-2.5 border border-purple-100 rounded-xl bg-purple-50/20 text-xs font-semibold text-slate-700 outline-none leading-relaxed resize-none"></textarea>
              </div>

              <!-- Mobile inputs -->
              <div class="space-y-3 pt-2">
                <div class="flex gap-4">
                  <!-- score input -->
                  <div class="w-24 shrink-0">
                    <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">分數 (0-100)</label>
                    <input v-model.number="score" type="number" class="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-center font-bold text-lg text-slate-800 outline-none" />
                  </div>
                  <!-- quick scores -->
                  <div class="flex-1 flex flex-col justify-end">
                    <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">快速給分</label>
                    <div class="grid grid-cols-4 gap-1">
                      <button v-for="val in [60, 80, 90, 100]" :key="val" @click="score = val" class="py-2.5 font-bold border border-slate-200 bg-slate-50 rounded-xl text-xs text-slate-700 btn-academic-active touch-target">{{ val }}</button>
                    </div>
                  </div>
                </div>

                <!-- feedback -->
                <div>
                  <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">評語</label>
                  <textarea v-model="feedback" rows="3" placeholder="請輸入評語，或使用 AI 輔助產生..." class="w-full p-3 border border-slate-200 bg-slate-50 rounded-xl text-xs font-semibold text-slate-700 outline-none leading-relaxed resize-none"></textarea>
                </div>
              </div>
            </div>

            <!-- Drawer Footer (Sticky at bottom of drawer) -->
            <div class="p-4 bg-slate-50 border-t border-slate-100 flex gap-2 shrink-0 pb-safe-bottom">
              <button @click="handleAIAssist" :disabled="isAILoading" class="flex-1 flex items-center justify-center gap-1.5 py-3 bg-gradient-to-r from-violet-500 to-indigo-600 text-white rounded-xl text-xs font-bold btn-academic-active touch-target disabled:opacity-50"><Loader2 v-if="isAILoading" class="w-4.5 h-4.5 animate-spin" /><span v-else>🤖 AI 輔助</span></button>
              
              <button @click="submitGrading" :disabled="isSubmitting || score === null || score === ''" class="flex-1 flex items-center justify-center gap-1.5 py-3 text-white rounded-xl text-xs font-bold btn-academic-active touch-target disabled:opacity-50" :class="selectedResponse.status === 'graded' ? 'bg-blue-600' : 'bg-emerald-600'"><Loader2 v-if="isSubmitting" class="w-4.5 h-4.5 animate-spin" /><span v-else>✅ 送出批改</span></button>
            </div>
          </div>
        </div>
      </Transition>

    </div>

    <!-- ============================================== -->
    <!-- Option B: Classic UI Layout (Original Green)   -->
    <!-- ============================================== -->
    <div v-else class="w-full">
      <div class="flex items-center gap-2 mb-6">
        <ClipboardCheck class="w-6 h-6 text-indigo-600" />
        <h2 class="text-2xl font-bold text-gray-800">簡答題批改</h2>
        <span v-if="currentTab === 'pending' && pendingResponses.length > 0" class="ml-2 px-2.5 py-0.5 text-sm font-semibold bg-red-100 text-red-700 rounded-full">{{ pendingResponses.length }} 待批改</span>
        <span v-if="currentTab === 'graded' && pendingResponses.length > 0" class="ml-2 px-2.5 py-0.5 text-sm font-semibold bg-green-100 text-green-700 rounded-full">{{ pendingResponses.length }} 已批改</span>
      </div>

      <div v-if="errorMessage" class="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg flex items-center justify-between">
        <span>{{ errorMessage }}</span>
        <button @click="errorMessage = ''" class="text-red-400 hover:text-red-600 ml-4 text-lg leading-none">&times;</button>
      </div>

      <div class="flex gap-6 h-[calc(100vh-200px)] min-h-[600px]">
        <div class="w-1/3 flex flex-col">
          <div class="bg-white rounded-xl shadow-sm border border-gray-200 flex-1 flex flex-col overflow-hidden">
            <div class="flex border-b border-gray-200">
              <button @click="switchTab('pending')" class="flex-1 py-2.5 text-sm font-medium text-center transition-colors relative" :class="currentTab === 'pending' ? 'text-indigo-700 bg-indigo-50/60' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'">📋 待批改<div v-if="currentTab === 'pending'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600"></div></button>
              <button @click="switchTab('graded')" class="flex-1 py-2.5 text-sm font-medium text-center transition-colors relative" :class="currentTab === 'graded' ? 'text-green-700 bg-green-50/60' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'">✅ 已批改<div v-if="currentTab === 'graded'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-green-600"></div></button>
            </div>

            <div v-if="currentTab === 'pending'" class="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
              <button @click="handleBatchGrading" :disabled="pendingResponses.length === 0 || isBatchGrading" class="w-full flex justify-center items-center gap-2 py-2.5 px-3 rounded-lg text-white font-medium transition-all shadow-sm bg-gradient-to-r from-blue-500 relative overflow-hidden" :class="[pendingResponses.length === 0 ? 'to-blue-400 opacity-60 cursor-not-allowed' : 'to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:shadow-md hover:-translate-y-0.5']">
                <template v-if="isBatchGrading">
                  <Loader2 class="w-4 h-4 animate-spin relative z-10" />
                  <span class="relative z-10 text-sm">⏳ 自動批改中... ({{ batchProgress.current }}/{{ batchProgress.total }})</span>
                  <div class="absolute left-0 top-0 h-full bg-white/20 transition-all duration-300" :style="{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }"></div>
                </template>
                <template v-else><span class="text-base relative z-10">🪄</span><span class="text-sm relative z-10">AI 一鍵全自動批改</span></template>
              </button>
            </div>

            <div v-if="isLoading" class="flex-1 flex items-center justify-center text-gray-400"><Loader2 class="w-6 h-6 animate-spin mr-2" />載入中...</div>
            <div v-else-if="pendingResponses.length === 0" class="flex-1 flex flex-col items-center justify-center text-gray-400 px-4"><ClipboardCheck class="w-12 h-12 mb-3 text-gray-300" /><p class="text-center">{{ currentTab === 'pending' ? '目前無待批改的簡答題' : '目前無已批改的紀錄' }}</p></div>

            <div v-else class="flex-1 overflow-y-auto divide-y divide-gray-100">
              <button v-for="response in pendingResponses" :key="response.id" @click="selectResponse(response)" class="w-full text-left px-4 py-3 hover:bg-indigo-50/60 transition-colors focus:outline-none" :class="{ 'bg-indigo-50 border-l-4 border-indigo-500': selectedResponse?.id === response.id, 'border-l-4 border-transparent': selectedResponse?.id !== response.id }">
                <div class="flex items-center justify-between mb-1">
                  <span class="font-medium text-gray-800 text-sm truncate">{{ response.users?.display_name || response.user_id }}</span>
                  <div class="flex items-center gap-1.5 ml-2 shrink-0">
                    <span v-if="response.status === 'graded' && response.score != null" class="text-xs font-bold px-1.5 py-0.5 rounded" :class="response.score >= 80 ? 'bg-green-100 text-green-700' : response.score >= 60 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'">{{ response.score }}分</span>
                    <span class="text-xs text-gray-400 font-mono">#{{ response.question_id }}</span>
                  </div>
                </div>
                <p v-if="response.users?.student_id" class="text-xs text-gray-400 mb-1">學號：{{ response.users.student_id }}</p>
                <p class="text-xs text-gray-400">{{ formatTime(response.created_at) }}</p>
                <p class="text-xs text-gray-500 mt-1 line-clamp-2">{{ response.answer_text || '（無作答內容）' }}</p>
              </button>
            </div>
          </div>
        </div>

        <div class="w-2/3 flex flex-col">
          <div class="bg-white rounded-xl shadow-sm border border-gray-200 flex-1 flex flex-col overflow-hidden">
            <div v-if="!selectedResponse" class="flex-1 flex flex-col items-center justify-center text-gray-400"><FileText class="w-16 h-16 mb-4 text-gray-200" /><p class="text-lg">請從左側選擇要批改的作答</p></div>

            <template v-else>
              <div class="p-6 border-b border-gray-100 flex-1 overflow-y-auto min-h-0 space-y-5">
                <div class="flex items-center gap-3 pb-4 border-b border-gray-100">
                  <div class="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center"><span class="text-indigo-600 font-bold text-sm">{{ (selectedResponse.users?.display_name || selectedResponse.user_id || '?').charAt(0) }}</span></div>
                  <div class="flex-1"><p class="font-semibold text-gray-800">{{ selectedResponse.users?.display_name || selectedResponse.user_id }}</p><p class="text-xs text-gray-400">題號 #{{ selectedResponse.question_id }} · 作答 #{{ selectedResponse.id }} · {{ formatTime(selectedResponse.created_at) }}</p></div>
                  <span v-if="selectedResponse.status === 'graded'" class="px-2.5 py-1 text-xs font-bold bg-green-100 text-green-700 rounded-full border border-green-200">已批改</span>
                  <span v-else class="px-2.5 py-1 text-xs font-bold bg-amber-100 text-amber-700 rounded-full border border-amber-200">待批改</span>
                </div>

                <div v-if="selectedResponse.question_bank?.content || getQuestionImageUrl(selectedResponse.question_bank)">
                  <h4 class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">📋 題目內容</h4>
                  <div v-if="selectedResponse.question_bank?.content" class="p-4 bg-gray-50 rounded-lg text-gray-700 whitespace-pre-wrap text-sm leading-relaxed">{{ selectedResponse.question_bank.content }}</div>
                  <img
                    v-if="getQuestionImageUrl(selectedResponse.question_bank)"
                    :src="getQuestionImageUrl(selectedResponse.question_bank)"
                    alt="題目圖片"
                    class="mt-3 max-h-80 rounded-lg border border-gray-200 object-contain"
                  />
                </div>
                <div><h4 class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">✍️ 學生作答</h4><div class="p-4 bg-blue-50/60 rounded-lg text-gray-800 whitespace-pre-wrap text-sm leading-relaxed border border-blue-100">{{ selectedResponse.answer_text || '（無作答內容）' }}</div></div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div class="p-3 rounded-lg border border-gray-200 bg-white">
                    <p class="text-xs font-semibold text-gray-500 mb-1">作答反應時間</p>
                    <p class="text-sm font-medium text-gray-800">{{ formatReactionTime(selectedResponse.reaction_time) }}</p>
                  </div>
                  <div class="p-3 rounded-lg border border-gray-200 bg-white">
                    <p class="text-xs font-semibold text-gray-500 mb-1">群組 ID</p>
                    <p class="text-sm font-medium text-gray-800 break-all">{{ selectedResponse.group_id || '—' }}</p>
                  </div>
                  <div class="p-3 rounded-lg border border-gray-200 bg-white">
                    <p class="text-xs font-semibold text-gray-500 mb-1">目前狀態</p>
                    <p class="text-sm font-medium text-gray-800">{{ selectedResponse.status === 'graded' ? 'graded' : 'pending' }}</p>
                  </div>
                </div>
                <div>
                  <div class="flex items-center justify-between mb-2">
                    <h4 class="text-sm font-semibold text-gray-500 uppercase tracking-wide">📐 評分標準</h4>
                    <button @click="updateRubric" :disabled="isUpdatingRubric" class="flex items-center gap-1.5 px-3 py-1 bg-purple-100 text-purple-700 hover:bg-purple-200 transition-colors rounded text-xs font-semibold disabled:opacity-50"><Loader2 v-if="isUpdatingRubric" class="w-3 h-3 animate-spin" /><span v-else>💾</span>{{ isUpdatingRubric ? '更新中' : '更新標準' }}</button>
                  </div>
                  <textarea v-model="editableRubric" rows="4" placeholder="請輸入評分標準..." class="w-full px-3 py-2 border border-purple-200 rounded-lg bg-purple-50 focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none transition resize-none text-sm text-gray-800 leading-relaxed"></textarea>
                </div>
              </div>

              <div class="p-4 sm:p-6 bg-gray-50/50 border-t border-gray-100 space-y-4 shrink-0">
                <div class="grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <div class="sm:col-span-1"><label for="grading-score" class="block text-sm font-medium text-gray-700 mb-1">分數</label><input id="grading-score" v-model.number="score" type="number" min="0" max="100" placeholder="0–100" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition text-center text-lg font-semibold" /></div>
                  <div class="sm:col-span-3"><label for="grading-feedback" class="block text-sm font-medium text-gray-700 mb-1">評語</label><textarea id="grading-feedback" v-model="feedback" rows="3" placeholder="請輸入評語，或點擊「AI 輔助批改」自動生成..." class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition resize-none text-sm"></textarea></div>
                </div>

                <div class="flex items-center gap-3 pt-2">
                  <button @click="handleAIAssist" :disabled="isAILoading" class="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-purple-500 to-indigo-500 text-white rounded-lg hover:from-purple-600 hover:to-indigo-600 transition-all disabled:opacity-60 disabled:cursor-not-allowed shadow-sm hover:shadow-md"><Loader2 v-if="isAILoading" class="w-4 h-4 animate-spin" /><Bot v-else class="w-4 h-4" />{{ isAILoading ? 'AI 分析中...' : ' AI 輔助批改' }}</button>
                  <button @click="submitGrading" :disabled="isSubmitting || score === null || score === ''" class="flex items-center gap-2 px-5 py-2.5 text-white rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm hover:shadow-md ml-auto" :class="selectedResponse.status === 'graded' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-green-600 hover:bg-green-700'"><Loader2 v-if="isSubmitting" class="w-4 h-4 animate-spin" /><RefreshCw v-else-if="selectedResponse.status === 'graded'" class="w-4 h-4" /><Send v-else class="w-4 h-4" />{{ isSubmitting ? '送出中...' : (selectedResponse.status === 'graded' ? '🔄 更新成績' : '✅ 確認送出') }}</button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
