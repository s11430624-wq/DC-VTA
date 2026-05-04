<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { supabase } from '../supabase'
import QuestionForm from './QuestionForm.vue'
import Analytics from './Analytics.vue'
import StudentAnalytics from './StudentAnalytics.vue'
import Leaderboard from './Leaderboard.vue'
import Grading from './Grading.vue'
import DiscordSettings from './DiscordSettings.vue'
import { Plus, Edit2, Trash2, BookOpen, RefreshCw, BarChart3, User, Search, Zap, Trophy, ClipboardCheck, ServerCog } from 'lucide-vue-next'

const props = defineProps({
  initialTab: { type: String, default: 'live-feed' },
  gradingStatus: { type: String, default: 'pending' },
  gradingQuestionId: { type: [String, Number], default: null },
  gradingResponseId: { type: [String, Number], default: null },
})

const validTabs = ['live-feed', 'ranking', 'questions', 'analytics', 'student-analytics', 'grading', 'discord-settings']
const normalizeTab = (tab) => validTabs.includes(tab) ? tab : 'live-feed'

const currentTab = ref(normalizeTab(props.initialTab))
const questions = ref([])
const loading = ref(false)
const showForm = ref(false)
const editingQuestion = ref(null)
const showAddForm = ref(false)
const searchQuery = ref('')
const sortBy = ref('newest')

const analyticsRef = ref(null)
const leaderboardFeedRef = ref(null)
const leaderboardRankRef = ref(null)
const gradingRef = ref(null)

const filteredAndSortedQuestions = computed(() => {
  let filtered = [...questions.value]
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(q => q.content?.toLowerCase().includes(query) || q.category?.toLowerCase().includes(query))
  }

  filtered.sort((a, b) => {
    if (sortBy.value === 'newest') return b.id - a.id
    if (sortBy.value === 'oldest') return a.id - b.id
    if (sortBy.value === 'latest-sent') {
      const timeA = a.last_sent_at ? new Date(a.last_sent_at).getTime() : 0
      const timeB = b.last_sent_at ? new Date(b.last_sent_at).getTime() : 0
      if (timeA === 0 && timeB === 0) return 0
      if (timeA === 0) return 1
      if (timeB === 0) return -1
      return timeB - timeA
    }
    return 0
  })

  return filtered
})

async function fetchQuestions() {
  loading.value = true
  const { data, error } = await supabase
    .from('question_bank')
    .select('*')
    .order('id', { ascending: false })
    .limit(50)

  if (error) {
    console.error('載入題目失敗:', error)
    alert('載入題目失敗: ' + error.message)
  } else {
    questions.value = data || []
  }
  loading.value = false
}

function handleAddQuestion() {
  editingQuestion.value = null
  showAddForm.value = true
  showForm.value = true
}

function handleEditQuestion(question) {
  editingQuestion.value = question
  showAddForm.value = false
  showForm.value = true
}

async function handleDeleteQuestion(question_id) {
  if (!window.confirm('確定要刪除此題目嗎？相關的學生作答紀錄也會一併被清空。')) return

  loading.value = true
  try {
    const { error } = await supabase.from('question_bank').delete().eq('id', question_id)
    if (error) {
      console.error('刪除失敗:', error)
      alert('❌ 刪除失敗：' + error.message)
    } else {
      alert('✅ 題目與相關紀錄已成功刪除')
      await fetchQuestions()
    }
  } catch (err) {
    console.error('發生非預期錯誤:', err)
  } finally {
    loading.value = false
  }
}

function handleFormSaved() {
  showForm.value = false
  editingQuestion.value = null
  showAddForm.value = false
  fetchQuestions()
}

function handleFormCancel() {
  showForm.value = false
  editingQuestion.value = null
  showAddForm.value = false
}

function handleTabChange(tab) {
  currentTab.value = tab
  if (tab === 'analytics' && analyticsRef.value) {
    analyticsRef.value.fetchAnalytics()
  } else if (tab === 'live-feed' && leaderboardFeedRef.value) {
    leaderboardFeedRef.value.fetchLeaderboard()
  } else if (tab === 'ranking' && leaderboardRankRef.value) {
    leaderboardRankRef.value.fetchLeaderboard()
  } else if (tab === 'grading' && gradingRef.value) {
    gradingRef.value.fetchResponses()
  }
}

watch(() => props.initialTab, (tab) => {
  const normalized = normalizeTab(tab)
  if (normalized !== currentTab.value) currentTab.value = normalized
})

onMounted(() => {
  fetchQuestions()
})

defineExpose({ fetchQuestions })
</script>

<template>
  <div class="w-full">
    <div class="bg-white border-b border-gray-200 mb-4 sm:mb-6 overflow-x-auto">
      <div class="flex min-w-max sm:min-w-0">
        <button @click="handleTabChange('live-feed')" :class="['flex-1 px-3 sm:px-6 py-3 sm:py-4 text-center font-medium transition-colors border-b-2', currentTab === 'live-feed' ? 'border-green-600 text-green-600' : 'border-transparent text-gray-500 hover:text-gray-700']">
          <div class="flex items-center justify-center gap-1 sm:gap-2"><Zap class="w-4 h-4 sm:w-5 sm:h-5" /><span class="text-sm sm:text-base whitespace-nowrap">最新戰況</span></div>
        </button>
        <button @click="handleTabChange('ranking')" :class="['flex-1 px-3 sm:px-6 py-3 sm:py-4 text-center font-medium transition-colors border-b-2', currentTab === 'ranking' ? 'border-yellow-500 text-yellow-600' : 'border-transparent text-gray-500 hover:text-gray-700']">
          <div class="flex items-center justify-center gap-1 sm:gap-2"><Trophy class="w-4 h-4 sm:w-5 sm:h-5" /><span class="text-sm sm:text-base whitespace-nowrap">班級排行</span></div>
        </button>
        <button @click="handleTabChange('questions')" :class="['flex-1 px-3 sm:px-6 py-3 sm:py-4 text-center font-medium transition-colors border-b-2', currentTab === 'questions' ? 'border-green-600 text-green-600' : 'border-transparent text-gray-500 hover:text-gray-700']">
          <div class="flex items-center justify-center gap-1 sm:gap-2"><BookOpen class="w-4 h-4 sm:w-5 sm:h-5" /><span class="text-sm sm:text-base whitespace-nowrap">題目管理</span></div>
        </button>
        <button @click="handleTabChange('analytics')" :class="['flex-1 px-3 sm:px-6 py-3 sm:py-4 text-center font-medium transition-colors border-b-2', currentTab === 'analytics' ? 'border-green-600 text-green-600' : 'border-transparent text-gray-500 hover:text-gray-700']">
          <div class="flex items-center justify-center gap-1 sm:gap-2"><BarChart3 class="w-4 h-4 sm:w-5 sm:h-5" /><span class="text-sm sm:text-base whitespace-nowrap">試題分析</span></div>
        </button>
        <button @click="handleTabChange('student-analytics')" :class="['flex-1 px-3 sm:px-6 py-3 sm:py-4 text-center font-medium transition-colors border-b-2', currentTab === 'student-analytics' ? 'border-green-600 text-green-600' : 'border-transparent text-gray-500 hover:text-gray-700']">
          <div class="flex items-center justify-center gap-1 sm:gap-2"><User class="w-4 h-4 sm:w-5 sm:h-5" /><span class="text-sm sm:text-base whitespace-nowrap">學生分析</span></div>
        </button>
        <button @click="handleTabChange('grading')" :class="['flex-1 px-3 sm:px-6 py-3 sm:py-4 text-center font-medium transition-colors border-b-2', currentTab === 'grading' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700']">
          <div class="flex items-center justify-center gap-1 sm:gap-2"><ClipboardCheck class="w-4 h-4 sm:w-5 sm:h-5" /><span class="text-sm sm:text-base whitespace-nowrap">簡答批改</span></div>
        </button>
        <button @click="handleTabChange('discord-settings')" :class="['flex-1 px-3 sm:px-6 py-3 sm:py-4 text-center font-medium transition-colors border-b-2', currentTab === 'discord-settings' ? 'border-slate-700 text-slate-700' : 'border-transparent text-gray-500 hover:text-gray-700']">
          <div class="flex items-center justify-center gap-1 sm:gap-2"><ServerCog class="w-4 h-4 sm:w-5 sm:h-5" /><span class="text-sm sm:text-base whitespace-nowrap">Discord 設定</span></div>
        </button>
      </div>
    </div>

    <div v-if="currentTab === 'live-feed'"><Leaderboard mode="feed" ref="leaderboardFeedRef" /></div>
    <div v-else-if="currentTab === 'ranking'"><Leaderboard mode="rank" ref="leaderboardRankRef" /></div>
    <div v-else-if="currentTab === 'questions'">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 sm:mb-6">
        <div class="flex items-center gap-2"><BookOpen class="w-5 h-5 sm:w-6 sm:h-6 text-green-600" /><h2 class="text-xl sm:text-2xl font-bold text-gray-800">題庫管理</h2></div>
        <div class="flex flex-wrap gap-2">
          <button @click="fetchQuestions" class="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2 text-sm sm:text-base" :disabled="loading"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" /><span class="hidden sm:inline">重新整理</span><span class="sm:hidden">重整</span></button>
          <button v-if="!showForm" @click="handleAddQuestion" class="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2 text-sm sm:text-base"><Plus class="w-4 h-4" />新增題目</button>
        </div>
      </div>

      <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" @click="handleFormCancel"></div>
        <div class="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-transparent z-10 rounded-lg shadow-xl shadow-black/20"><QuestionForm :question="editingQuestion" @saved="handleFormSaved" @cancel="handleFormCancel" /></div>
      </div>

      <div v-if="!showForm" class="mb-6 flex gap-4">
        <div class="relative flex-1"><Search class="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" /><input v-model="searchQuery" type="text" placeholder="搜尋題目內容或分類..." class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition" /></div>
        <select v-model="sortBy" class="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition bg-white text-gray-700"><option value="newest">最新建立 (Newest Created)</option><option value="oldest">最舊建立 (Oldest Created)</option><option value="latest-sent">最近發送 (Latest Sent)</option></select>
      </div>

      <div v-if="loading" class="text-center py-8 text-gray-500">載入中...</div>
      <div v-else-if="filteredAndSortedQuestions.length === 0" class="text-center py-12 text-gray-500">
        <p class="text-lg mb-4">{{ searchQuery ? '沒有找到符合搜尋條件的題目' : '目前還沒有題目' }}</p>
        <button v-if="!searchQuery" @click="handleAddQuestion" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors inline-flex items-center gap-2"><Plus class="w-4 h-4" />新增第一題</button>
      </div>

      <div v-else class="space-y-3">
        <div v-for="q in filteredAndSortedQuestions" :key="q.id" class="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow">
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-2">
                <span class="text-sm text-gray-500 font-mono">#{{ q.id }}</span>
                <span v-if="q.category" class="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded">{{ q.category }}</span>
                <span v-if="q.question_type === 'multiple_choice'" class="px-2 py-1 text-xs bg-indigo-100 text-indigo-700 rounded font-medium">選擇題</span>
                <span v-else class="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded font-medium">簡答題</span>
              </div>
              <p class="text-gray-800 mb-2">{{ q.content || '（無題目描述，僅提供選項）' }}</p>
              <div class="flex flex-wrap gap-2 mb-2">
                <span v-for="(option, index) in q.metadata?.options || []" :key="index" class="text-sm px-2 py-1 rounded" :class="String.fromCharCode(65 + index) === q.metadata?.correct_answer ? 'bg-green-100 text-green-700 font-semibold' : 'bg-gray-100 text-gray-600'">{{ String.fromCharCode(65 + index) }}: {{ option }}</span>
              </div>
              <p v-if="q.explanation" class="text-sm text-gray-600 italic">說明: {{ q.explanation }}</p>
            </div>
            <div class="ml-4 flex gap-2">
              <button @click="handleEditQuestion(q)" class="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="編輯"><Edit2 class="w-4 h-4" /></button>
              <button @click="handleDeleteQuestion(q.id)" class="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="刪除"><Trash2 class="w-4 h-4" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="currentTab === 'analytics'"><Analytics ref="analyticsRef" /></div>
    <div v-else-if="currentTab === 'student-analytics'"><StudentAnalytics /></div>
    <div v-else-if="currentTab === 'grading'"><Grading ref="gradingRef" :initial-status="gradingStatus" :initial-question-id="gradingQuestionId" :initial-response-id="gradingResponseId" /></div>
    <div v-else-if="currentTab === 'discord-settings'"><DiscordSettings /></div>
  </div>
</template>
