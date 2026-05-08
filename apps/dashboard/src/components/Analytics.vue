<script setup>
import { ref, computed, onMounted } from 'vue'
import { supabase } from '../supabase'
import { 
  BarChart3, 
  TrendingDown, 
  TrendingUp, 
  Users, 
  CheckCircle2, 
  XCircle,
  Search,
  ChevronDown,
  ChevronUp,
  RefreshCw
} from 'lucide-vue-next'

const responses = ref([])
const loading = ref(false)
const searchQuery = ref('')
const sortBy = ref('latest')
const selectedGroup = ref('all')
const expandedQuestions = ref(new Set())

function normalizeQuestionType(rawType) {
  return String(rawType || '').trim().toLowerCase()
}

// 獲取所有答題記錄（包含問題和學生資訊）
async function fetchAnalytics() {
  loading.value = true
  try {
    const { data, error } = await supabase
      .from('quiz_responses')
      .select(`
        id,
        question_id,
        is_correct,
        score,
        reaction_time,
        created_at,
        group_id,
        answer_text,
        ai_feedback,
        status,
        groups (
          group_name
        ),
        users (
          display_name,
          student_id
        ),
        question_bank (
          id,
          content,
          category,
          metadata,
          last_sent_at,
          question_type
        )
      `)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('載入分析數據失敗:', error)
      alert('載入分析數據失敗: ' + error.message)
      responses.value = []
    } else {
      responses.value = data || []
    }
  } catch (err) {
    console.error('載入分析數據錯誤:', err)
    alert('載入分析數據錯誤: ' + err.message)
    responses.value = []
  } finally {
    loading.value = false
  }
}

// 獲取所有可用的分類(班級)
const availableClasses = computed(() => {
  const classesSet = new Set()
  
  responses.value.forEach(response => {
    const category = response.question_bank?.category
    if (category) {
      classesSet.add(category)
    }
  })
  
  return Array.from(classesSet).sort()
})

// 按問題分組並計算統計
const questionStats = computed(() => {
  const grouped = {}
  
  // 計算所有問題的完整統計數據（不先過濾回應）
  responses.value.forEach(response => {
    const questionId = response.question_id
    const question = response.question_bank
    
    if (!question) return // 跳過已刪除的問題
    
    if (!grouped[questionId]) {
      const questionType = normalizeQuestionType(question.question_type)
      grouped[questionId] = {
        questionId: questionId,
        question: question,
        isShortAnswer: questionType === 'short_answer',
        isSurvey: questionType === 'survey',
        totalAttempts: 0,
        correctCount: 0,
        incorrectCount: 0,
        hasPending: false,
        totalScore: 0,
        gradedCount: 0,
        latestSubmissionAt: null,
        students: []
      }
    }
    
    const stat = grouped[questionId]
    stat.totalAttempts++
    
    if (!stat.isShortAnswer && !stat.isSurvey) {
      if (response.is_correct) {
        stat.correctCount++
      } else {
        stat.incorrectCount++
      }
    }

    // 簡答題：追蹤待批改狀態與累積分數
    if (stat.isShortAnswer) {
      if (response.status === 'pending') {
        stat.hasPending = true
      }
      if (response.status === 'graded' && response.score != null) {
        stat.totalScore += response.score
        stat.gradedCount++
      }
    }

    const submittedAt = response.created_at ? new Date(response.created_at).getTime() : 0
    if (submittedAt > 0 && (!stat.latestSubmissionAt || submittedAt > stat.latestSubmissionAt)) {
      stat.latestSubmissionAt = submittedAt
    }
    
    // 添加學生詳情
    stat.students.push({
      id: response.id,
      displayName: response.users?.display_name || '未知',
      studentId: response.users?.student_id || 'N/A',
      isCorrect: response.is_correct,
      score: response.score || 0,
      reactionTime: response.reaction_time,
      createdAt: response.created_at,
      answerText: response.answer_text || '',
      aiFeedback: response.ai_feedback || '',
      status: response.status || 'graded',
      questionType: question.question_type || 'multiple_choice'
    })
  })
  
  // 轉換為數組並計算準確率
  let result = Object.values(grouped).map(stat => {
    // 判斷是否為搶答題（簡答題不算搶答）
    stat.isSpeedQuiz = !stat.isShortAnswer && !stat.isSurvey && stat.students.some(s => s.score === 5);

    // 計算簡答題平均分
    stat.avgScore = stat.gradedCount > 0
      ? Math.round(stat.totalScore / stat.gradedCount)
      : null

    // 過濾名單
    if (stat.isSpeedQuiz) {
      stat.displayStudents = stat.students.filter(s => s.score === 5);
    } else {
      stat.displayStudents = [...stat.students];
    }

    // 找出答對的學生，按反應時間排序以給予排名（一般模式用）
    const correctStudents = stat.displayStudents
      .filter(s => s.isCorrect)
      .sort((a, b) => (a.reactionTime || 9999) - (b.reactionTime || 9999));
    
    // 分配 UI 狀態
    stat.displayStudents.forEach(s => {
      if (stat.isShortAnswer) {
        // ── 簡答題的卡片樣式 ──
        if (s.status === 'pending') {
          s.rankIcon = '⏳'
          s.statusText = '⏳ 待批改'
          s.cardClass = 'bg-gray-50 border-gray-300'
          s.textClass = 'font-semibold text-gray-700'
          s.badgeClass = 'bg-gray-100 text-gray-600 border border-gray-200'
        } else {
          // graded
          const score = s.score || 0
          s.rankIcon = score >= 80 ? '🌟' : score >= 60 ? '👍' : '📝'
          s.statusText = `${score} 分`
          if (score >= 80) {
            s.cardClass = 'bg-green-50 border-green-200'
            s.textClass = 'font-semibold text-green-800'
            s.badgeClass = 'bg-green-100 text-green-700 border border-green-200'
          } else if (score >= 60) {
            s.cardClass = 'bg-yellow-50 border-yellow-200'
            s.textClass = 'font-semibold text-yellow-800'
            s.badgeClass = 'bg-yellow-100 text-yellow-700 border border-yellow-200'
          } else {
            s.cardClass = 'bg-red-50 border-red-200'
            s.textClass = 'font-semibold text-red-800'
            s.badgeClass = 'bg-red-100 text-red-700 border border-red-200'
          }
        }
      } else if (stat.isSurvey) {
        s.rankIcon = '🗳️';
        s.statusText = '已提交';
        s.cardClass = 'bg-sky-50 border-sky-200';
        s.textClass = 'font-semibold text-sky-800';
        s.badgeClass = 'bg-sky-100 text-sky-700 border border-sky-200';
      } else {
        // ── 選擇題 / 搶答題的卡片樣式（原有邏輯）──
        // 分配一般名次圖示 (給排版用)
        if (s.isCorrect && !stat.isSpeedQuiz) {
          const rank = correctStudents.findIndex(cs => cs.id === s.id);
          if (rank === 0) s.rankIcon = '🥇';
          else if (rank === 1) s.rankIcon = '🥈';
          else if (rank === 2) s.rankIcon = '🥉';
          else s.rankIcon = '✅';
        } else if (s.isCorrect && stat.isSpeedQuiz) {
          s.rankIcon = '';
        } else {
          s.rankIcon = '❌';
        }

        // 卡片與標籤樣式
        if (s.score === 5) {
          s.isWinner = true;
          s.statusText = '✅ 答對';
          s.cardClass = 'bg-yellow-50 border-yellow-300 ring-2 ring-yellow-400';
          s.textClass = 'font-black text-yellow-800';
          s.badgeClass = 'bg-green-100 text-green-700 border border-green-200';
        } else if (s.isCorrect) {
          s.isWinner = false;
          s.statusText = '✅ 答對';
          s.cardClass = 'bg-green-50 border-green-200';
          s.textClass = 'font-semibold text-green-800';
          s.badgeClass = 'bg-green-100 text-green-700 border border-green-200';
        } else {
          s.isWinner = false;
          s.statusText = '❌ 答錯';
          s.cardClass = 'bg-red-50 border-red-200 opacity-90';
          s.textClass = 'font-semibold text-red-800';
          s.badgeClass = 'bg-red-100 text-red-700 border border-red-200';
        }
      }
    });

    return {
      ...stat,
      displaySentAt: stat.question.last_sent_at || (stat.latestSubmissionAt ? new Date(stat.latestSubmissionAt).toISOString() : null),
      accuracyRate: stat.totalAttempts > 0 
        ? Math.round((stat.correctCount / stat.totalAttempts) * 100)
        : null
    };
  })

  // 根據選定的班級(分類)過濾問題
  if (selectedGroup.value !== 'all') {
    result = result.filter(stat => stat.question.category === selectedGroup.value)
  }

  return result
})

// 過濾和排序後的問題統計
const filteredStats = computed(() => {
  let filtered = [...questionStats.value]
  
  // 搜索過濾
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(stat => 
      stat.question.content?.toLowerCase().includes(query) ||
      stat.question.category?.toLowerCase().includes(query)
    )
  }
  
  // 排序
  if (sortBy.value === 'hardest') {
    // 按準確率排序（最低的在前，即最難的問題）
    filtered.sort((a, b) => (a.accuracyRate ?? 101) - (b.accuracyRate ?? 101))
  } else {
    // 按發送時間排序（優先 displaySentAt：last_sent_at，若無則回退最近提交時間）
    filtered.sort((a, b) => {
      const timeA = a.displaySentAt ? new Date(a.displaySentAt).getTime() : 0;
      const timeB = b.displaySentAt ? new Date(b.displaySentAt).getTime() : 0;

      if (timeA === 0 && timeB === 0) return 0;
      if (timeA === 0) return 1; // 未發送的在底下
      if (timeB === 0) return -1; // 未發送的在底下

      if (sortBy.value === 'latest') {
        return timeB - timeA; // 降序
      } else {
        return timeA - timeB; // 升序
      }
    });
  }
  
  return filtered
})

// 切換展開/收起
function toggleExpand(questionId) {
  if (expandedQuestions.value.has(questionId)) {
    expandedQuestions.value.delete(questionId)
  } else {
    expandedQuestions.value.add(questionId)
  }
}

const studentSortBy = ref('correctness')

function getSortedStudents(students) {
  return [...students].sort((a, b) => {
    const questionType = normalizeQuestionType(a.questionType)
    if (questionType === 'survey') {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    }
    if (studentSortBy.value === 'fastest') {
      return (a.reactionTime || 9999) - (b.reactionTime || 9999);
    } else {
      if (a.isCorrect !== b.isCorrect) {
        return a.isCorrect ? -1 : 1;
      }
      return (a.reactionTime || 9999) - (b.reactionTime || 9999);
    }
  });
}

// 獲取準確率顏色
function getAccuracyColor(rate) {
  if (rate >= 80) return 'text-green-600 bg-green-50'
  if (rate >= 60) return 'text-yellow-600 bg-yellow-50'
  if (rate >= 40) return 'text-orange-600 bg-orange-50'
  return 'text-red-600 bg-red-50'
}

// 獲取分數對應顏色
function getScoreColor(score) {
  if (score >= 80) return 'text-green-600'
  if (score >= 60) return 'text-yellow-600'
  return 'text-red-600'
}

onMounted(() => {
  fetchAnalytics()
})

// 暴露方法供父組件調用
defineExpose({
  fetchAnalytics
})
</script>

<template>
  <div class="w-full">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 sm:mb-6">
      <div class="flex items-center gap-2">
        <BarChart3 class="w-5 h-5 sm:w-6 sm:h-6 text-green-600" />
        <h2 class="text-xl sm:text-2xl font-bold text-gray-800">試題分析</h2>
      </div>
      <button
        @click="fetchAnalytics"
        class="w-full sm:w-auto justify-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2 text-sm sm:text-base"
        :disabled="loading"
      >
        <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
        重新整理
      </button>
    </div>

    <!-- 搜索框與排序 -->
    <div class="mb-4 sm:mb-6 flex flex-col sm:flex-row gap-3 sm:gap-4">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜尋題目內容或分類..."
          class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition text-sm sm:text-base"
        />
      </div>
      <select
        v-model="selectedGroup"
        class="px-3 sm:px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition bg-white text-gray-700 w-full sm:max-w-[200px] truncate text-sm sm:text-base"
      >
        <option value="all">所有班級 (All Groups)</option>
        <option v-for="className in availableClasses" :key="className" :value="className">
          {{ className }}
        </option>
      </select>
      <select
        v-model="sortBy"
        class="px-3 sm:px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition bg-white text-gray-700 w-full sm:w-auto text-sm sm:text-base"
      >
        <option value="latest">最近發送 (Latest Sent)</option>
        <option value="oldest">最久以前 (Oldest Sent)</option>
        <option value="hardest">難易度由難到易 (Hardest)</option>
      </select>
    </div>

    <!-- 載入狀態 -->
    <div v-if="loading" class="text-center py-12 text-gray-500">
      <RefreshCw class="w-8 h-8 animate-spin mx-auto mb-2" />
      <p>載入分析數據中...</p>
    </div>

    <!-- 無數據 -->
    <div v-else-if="filteredStats.length === 0" class="text-center py-12 text-gray-500">
      <BarChart3 class="w-16 h-16 text-gray-400 mx-auto mb-4" />
      <p class="text-lg">
        {{ searchQuery ? '沒有找到符合搜尋條件的題目' : '目前還沒有答題記錄' }}
      </p>
    </div>

    <!-- 統計列表 -->
    <div v-else class="space-y-4">
      <div
        v-for="stat in filteredStats"
        :key="stat.questionId"
        class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden"
      >
        <!-- 問題摘要行 -->
        <div
          class="p-3 sm:p-4 cursor-pointer hover:bg-gray-50 transition-colors"
          @click="toggleExpand(stat.questionId)"
        >
          <div class="flex items-start justify-between">
            <div class="flex-1 min-w-0">
              <div class="flex flex-wrap items-center gap-2 mb-2">
                <span class="text-sm text-gray-500 font-mono">#{{ stat.questionId }}</span>
                <span
                  v-if="stat.question.category"
                  class="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded"
                >
                  {{ stat.question.category }}
                </span>
                <!-- 簡答題 Badge -->
                <span
                  v-if="stat.isShortAnswer"
                  class="px-2 py-1 text-xs font-semibold bg-purple-100 text-purple-700 border border-purple-200 rounded"
                >
                  ✍️ 簡答題
                </span>
                <span
                  v-if="stat.isSurvey"
                  class="px-2 py-1 text-xs font-semibold bg-sky-100 text-sky-700 border border-sky-200 rounded"
                >
                  🗳️ 問卷題
                </span>
                <!-- 待批改提示 -->
                <span
                  v-if="stat.isShortAnswer && stat.hasPending"
                  class="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200 rounded"
                >
                  ⏳ 待批改
                </span>
                <!-- 選擇題：準確率 Badge -->
                <span
                  v-if="!stat.isShortAnswer && !stat.isSurvey && !stat.isSpeedQuiz"
                  :class="[
                    'px-2 py-1 text-xs font-semibold rounded',
                    getAccuracyColor(stat.accuracyRate)
                  ]"
                >
                  {{ stat.accuracyRate }}% 準確率 <span class="hidden xl:inline">({{ stat.correctCount }}/{{ stat.totalAttempts }})</span>
                </span>
                <span
                  v-if="stat.isSpeedQuiz"
                  class="px-2 py-1 text-xs font-bold bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200 rounded shadow-sm"
                >
                  ⚡ 搶答挑戰
                </span>
                <span class="text-xs text-gray-500 ml-0 sm:ml-2 w-full sm:w-auto mt-1 sm:mt-0">
                  發送時間: {{ stat.displaySentAt ? new Date(stat.displaySentAt).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : '尚未發送' }}
                </span>
              </div>
              <p class="text-sm sm:text-base text-gray-800 mb-3 line-clamp-2">
                {{ stat.question.content || '（無題目描述，僅提供選項）' }}
              </p>

              <!-- 準確率進度條（只有選擇題且非搶答才顯示） -->
              <div v-if="!stat.isSpeedQuiz && !stat.isShortAnswer && !stat.isSurvey" class="mb-4">
                <div class="w-full bg-gray-200 rounded-full h-2">
                  <div class="h-2 rounded-full transition-all duration-500" 
                    :class="
                      stat.accuracyRate >= 80 ? 'bg-green-500' : 
                      stat.accuracyRate >= 60 ? 'bg-yellow-500' : 
                      stat.accuracyRate >= 40 ? 'bg-orange-500' : 'bg-red-500'
                    "
                    :style="{ width: stat.accuracyRate + '%' }"
                  ></div>
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-3 sm:gap-4 text-xs sm:text-sm text-gray-600">
                <div class="flex items-center gap-1">
                  <Users class="w-4 h-4" />
                  <span>{{ stat.isSpeedQuiz ? '入榜人數' : '已作答' }}<span class="hidden sm:inline">:</span> {{ stat.displayStudents.length }}</span>
                </div>

                <!-- 選擇題的答對/答錯統計 -->
                <template v-if="!stat.isShortAnswer && !stat.isSurvey && !stat.isSpeedQuiz">
                  <div class="flex items-center gap-1 text-green-600">
                    <CheckCircle2 class="w-4 h-4" />
                    <span>答對<span class="hidden sm:inline">:</span> {{ stat.correctCount }}</span>
                  </div>
                  <div class="flex items-center gap-1 text-red-600">
                    <XCircle class="w-4 h-4" />
                    <span>答錯<span class="hidden sm:inline">:</span> {{ stat.incorrectCount }}</span>
                  </div>
                  <div class="flex items-center gap-1 ml-auto sm:ml-0">
                    <TrendingDown
                      v-if="stat.accuracyRate < 50"
                      class="w-4 h-4 text-red-500"
                    />
                    <TrendingUp
                      v-else-if="stat.accuracyRate >= 80"
                      class="w-4 h-4 text-green-500"
                    />
                    <span
                      :class="[
                        'font-semibold',
                        stat.accuracyRate < 50 ? 'text-red-600' : 
                        stat.accuracyRate >= 80 ? 'text-green-600' : 'text-yellow-600'
                      ]"
                    >
                      {{ stat.accuracyRate < 50 ? '困難' : stat.accuracyRate >= 80 ? '簡單' : '中等' }}
                    </span>
                  </div>
                </template>

                <!-- 簡答題的平均分統計 -->
                <template v-if="stat.isShortAnswer">
                  <div v-if="stat.avgScore != null" class="flex items-center gap-1" :class="getScoreColor(stat.avgScore)">
                    <span class="font-semibold">平均得分: {{ stat.avgScore }} 分</span>
                  </div>
                  <div v-if="stat.hasPending" class="flex items-center gap-1 text-gray-500">
                    <span>{{ stat.students.filter(s => s.status === 'pending').length }} 份待批改</span>
                  </div>
                </template>
                <template v-if="stat.isSurvey">
                  <div class="flex items-center gap-1 text-sky-700">
                    <span>顯示問卷填寫內容（不計答對/答錯）</span>
                  </div>
                </template>
              </div>
            </div>
            <div class="ml-2 sm:ml-4 shrink-0 mt-1">
              <ChevronDown
                v-if="!expandedQuestions.has(stat.questionId)"
                class="w-5 h-5 text-gray-400"
              />
              <ChevronUp
                v-else
                class="w-5 h-5 text-gray-400"
              />
            </div>
          </div>
        </div>

        <!-- 展開的學生詳情 -->
        <Transition name="expand">
          <div
            v-if="expandedQuestions.has(stat.questionId)"
            class="border-t border-gray-200 bg-gray-50"
          >
            <div class="p-4 sm:p-5">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <h4 class="text-sm font-semibold text-gray-700">
                  學生答題詳情 (顯示 {{ stat.displayStudents.length }} 人)
                </h4>
                <select
                  v-if="!stat.isShortAnswer && !stat.isSurvey"
                  v-model="studentSortBy"
                  class="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none w-full sm:w-auto bg-white text-gray-700"
                >
                  <option value="correctness">預設排序 (答對在前)</option>
                  <option value="fastest">反應時間 (最快在前)</option>
                </select>
              </div>
              
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div
                  v-for="(student, index) in getSortedStudents(stat.displayStudents)"
                  :key="index"
                  :class="[
                    'p-4 rounded-lg shadow-sm flex flex-col hover:shadow-md transition-all duration-300 border',
                    student.cardClass
                  ]"
                >
                  <div class="flex items-start justify-between mb-2">
                    <div class="flex flex-col gap-1">
                      <div class="flex items-center gap-2 mt-1">
                        <span class="text-xl leading-none select-none">{{ student.rankIcon }}</span>
                        <span :class="['text-lg', student.textClass]">
                          {{ student.displayName }}
                        </span>
                      </div>
                    </div>
                    
                    <div class="flex flex-col items-end gap-1">
                      <span
                        :class="[
                          'text-xs px-2 py-1 rounded-full font-semibold whitespace-nowrap',
                          student.badgeClass
                        ]"
                      >
                        {{ student.statusText }}
                      </span>
                    </div>
                  </div>

                  <!-- 簡答題：學生回答 & AI 回饋 -->
                  <div v-if="(stat.isShortAnswer || stat.isSurvey) && (student.answerText || student.aiFeedback)" class="mb-3 space-y-2">
                    <div v-if="student.answerText" class="bg-purple-50 border border-purple-100 rounded-lg p-3">
                      <p class="text-xs font-medium text-purple-600 mb-1">{{ stat.isSurvey ? '🗳️ 問卷填寫內容' : '📝 學生回答' }}</p>
                      <p class="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{{ student.answerText }}</p>
                    </div>
                    <div v-if="stat.isShortAnswer && student.aiFeedback" class="bg-blue-50 border border-blue-100 rounded-lg p-3">
                      <p class="text-xs font-medium text-blue-600 mb-1">🤖 AI 回饋</p>
                      <p class="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed">{{ student.aiFeedback }}</p>
                    </div>
                  </div>
                  
                  <div class="flex items-center justify-between mt-auto pt-3 border-t border-black/5">
                    <span class="text-sm text-gray-500 font-mono">
                      {{ student.studentId }}
                    </span>
                    <template v-if="!stat.isShortAnswer && !stat.isSurvey">
                      <span v-if="student.reactionTime != null" class="text-sm font-medium" :class="student.reactionTime < 10 ? 'text-amber-600' : 'text-gray-600'">
                        ⚡ {{ student.reactionTime }} 秒
                      </span>
                      <span v-else class="text-sm text-gray-400">
                        ⚡ --
                      </span>
                    </template>
                    <template v-else-if="stat.isSurvey">
                      <span class="text-sm text-gray-500">
                        {{ new Date(student.createdAt).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) }}
                      </span>
                    </template>
                    <template v-else>
                      <span v-if="student.status === 'graded'" class="text-sm font-semibold" :class="getScoreColor(student.score)">
                        {{ student.score }} 分
                      </span>
                      <span v-else class="text-sm text-gray-400">
                        尚未批改
                      </span>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.expand-enter-active,
.expand-leave-active {
  transition: all 0.3s ease;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}

.expand-enter-to,
.expand-leave-from {
  max-height: 1000px;
  opacity: 1;
}
</style>
