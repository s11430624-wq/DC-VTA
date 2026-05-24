<script setup>
import { ref, computed, onMounted, watch, inject } from 'vue'
import { supabase } from '../supabase'
import QuestionForm from './QuestionForm.vue'
import Analytics from './Analytics.vue'
import StudentAnalytics from './StudentAnalytics.vue'
import Leaderboard from './Leaderboard.vue'
import Grading from './Grading.vue'
import DiscordSettings from './DiscordSettings.vue'
import { 
  Plus, Edit2, Trash2, BookOpen, RefreshCw, BarChart3, 
  User, Search, Zap, Trophy, ClipboardCheck, ServerCog,
  Menu, X
} from 'lucide-vue-next'

const props = defineProps({
  initialTab: { type: String, default: 'live-feed' },
  gradingStatus: { type: String, default: 'pending' },
  gradingQuestionId: { type: [String, Number], default: null },
  gradingResponseId: { type: [String, Number], default: null },
})

const validTabs = ['live-feed', 'ranking', 'questions', 'analytics', 'student-analytics', 'grading', 'discord-settings']
const normalizeTab = (tab) => validTabs.includes(tab) ? tab : 'live-feed'

const currentTab = ref(normalizeTab(props.initialTab))
const uiVariant = inject('uiVariant', ref('classic'))

// UIUX: Custom tabs metadata config for premium icon rendering
const tabsConfig = [
  { id: 'live-feed', label: '最新戰況', icon: Zap },
  { id: 'ranking', label: '班級排行', icon: Trophy },
  { id: 'questions', label: '題目管理', icon: BookOpen },
  { id: 'analytics', label: '試題分析', icon: BarChart3 },
  { id: 'student-analytics', label: '學生分析', icon: User },
  { id: 'grading', label: '簡答批改', icon: ClipboardCheck },
  { id: 'discord-settings', label: 'Discord 設定', icon: ServerCog },
]

const isMobileDrawerOpen = ref(false)

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

function getQuestionImageUrls(question) {
  const metadata = question?.metadata
  const parsed = typeof metadata === 'string' ? (() => {
    try {
      const value = JSON.parse(metadata)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch {
      return null
    }
  })() : metadata
  const imageUrls = Array.isArray(parsed?.image_urls) ? parsed.image_urls : []
  const fallback = typeof parsed?.image_url === 'string' ? [parsed.image_url] : []
  return [...new Set([...imageUrls, ...fallback])]
    .filter((url) => typeof url === 'string')
    .map((url) => url.trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .map((url) => encodeURI(url))
}

function handleImageLoadError(event) {
  const target = event?.target
  if (!(target instanceof HTMLImageElement)) return
  console.warn('Image load failed:', target.src)
  target.style.display = 'none'
}

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
    <!-- ============================================== -->
    <!-- Option A: Redesigned UI -->
    <!-- ============================================== -->
    <div v-if="uiVariant === 'redesigned'" class="w-full pb-20 lg:pb-0">
      <div class="flex flex-col lg:flex-row gap-6 relative">
        <!-- Desktop Sidebar Navigation (lg:block hidden) -->
        <aside class="w-64 shrink-0 lg:block hidden">
          <div class="bg-white rounded-2xl border border-slate-200/60 p-4 sticky top-24 shadow-academic">
            <div class="px-3 py-2 text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">工作台導航</div>
            <nav class="space-y-1">
              <button
                v-for="tab in tabsConfig"
                :key="tab.id"
                @click="handleTabChange(tab.id)"
                class="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-semibold transition-smooth text-sm btn-academic-active text-left"
                :class="[
                  currentTab === tab.id
                    ? 'bg-blue-50 text-blue-600 shadow-sm'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'
                ]"
              >
                <component :is="tab.icon" class="w-4 h-4" />
                <span>{{ tab.label }}</span>
              </button>
            </nav>
          </div>
        </aside>

        <!-- Mobile Top Active Bar & Drawer Toggle (lg:hidden) -->
        <div class="lg:hidden flex items-center justify-between bg-white px-4 py-3 rounded-xl border border-slate-200/60 shadow-academic w-full mb-1">
          <div class="flex items-center gap-2">
            <button 
              @click="isMobileDrawerOpen = true" 
              class="p-2 -ml-2 text-slate-600 hover:text-slate-800 rounded-lg hover:bg-slate-50 touch-target flex items-center justify-center btn-academic-active"
              title="開啟選單"
            >
              <Menu class="w-5 h-5" />
            </button>
            <span class="text-sm font-bold text-slate-800">
              {{ tabsConfig.find(t => t.id === currentTab)?.label }}
            </span>
          </div>
          
          <span class="text-[10px] font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full uppercase tracking-wider">
            工作台
          </span>
        </div>

        <!-- Mobile Slide-out Drawer Panel (lg:hidden) -->
        <Transition name="drawer">
          <div v-if="isMobileDrawerOpen" class="lg:hidden fixed inset-0 z-50 flex">
            <!-- Backdrop overlay -->
            <div 
              class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity"
              @click="isMobileDrawerOpen = false"
            ></div>
            
            <!-- Drawer menu box -->
            <div class="relative flex flex-col w-72 max-w-[85vw] bg-white h-full shadow-2xl p-5 border-r border-slate-200">
              <div class="flex items-center justify-between pb-5 border-b border-slate-100 mb-5">
                <div class="flex items-center gap-2">
                  <Trophy class="w-5 h-5 text-blue-600" />
                  <span class="font-bold text-slate-800">教師工具箱</span>
                </div>
                <button 
                  @click="isMobileDrawerOpen = false" 
                  class="p-2 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-50 touch-target flex items-center justify-center btn-academic-active"
                  title="關閉選單"
                >
                  <X class="w-5 h-5" />
                </button>
              </div>
              
              <nav class="space-y-1.5 overflow-y-auto flex-1 no-scrollbar">
                <button
                  v-for="tab in tabsConfig"
                  :key="tab.id"
                  @click="handleTabChange(tab.id); isMobileDrawerOpen = false"
                  class="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-xl font-bold transition-smooth text-sm btn-academic-active text-left touch-target"
                  :class="[
                    currentTab === tab.id
                      ? 'bg-blue-50 text-blue-600'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'
                  ]"
                >
                  <component :is="tab.icon" class="w-5 h-5" />
                  <span>{{ tab.label }}</span>
                </button>
              </nav>
              
              <div class="pt-5 border-t border-slate-100 text-xs text-slate-400 font-medium">
                新版 v1.0.0
              </div>
            </div>
          </div>
        </Transition>

        <!-- Active Panel Workspace Container -->
        <div class="flex-1 min-w-0">
          <!-- Live Feed Panel -->
          <div v-if="currentTab === 'live-feed'">
            <Leaderboard mode="feed" ref="leaderboardFeedRef" />
          </div>

          <!-- Ranking Leaderboard Panel -->
          <div v-else-if="currentTab === 'ranking'">
            <Leaderboard mode="rank" ref="leaderboardRankRef" />
          </div>

          <!-- Question Bank Panel -->
          <div v-else-if="currentTab === 'questions'">
            <!-- Header and controls -->
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 sm:mb-6 bg-white p-4 rounded-xl border border-slate-200/60 shadow-academic">
              <div class="flex items-center gap-2.5">
                <div class="p-2 bg-blue-50 text-blue-600 rounded-lg">
                  <BookOpen class="w-5 h-5 sm:w-6 sm:h-6" />
                </div>
                <h2 class="text-lg sm:text-xl font-bold text-slate-800">題庫管理</h2>
              </div>
              <div class="flex flex-wrap gap-2 w-full sm:w-auto">
                <button 
                  @click="fetchQuestions" 
                  class="flex-1 sm:flex-none justify-center px-4 py-2 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg transition-smooth flex items-center gap-2 text-sm sm:text-base font-semibold btn-academic-active touch-target" 
                  :disabled="loading"
                >
                  <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
                  <span>重新整理</span>
                </button>
                <button 
                  v-if="!showForm" 
                  @click="handleAddQuestion" 
                  class="flex-1 sm:flex-none justify-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-smooth flex items-center gap-2 text-sm sm:text-base font-semibold shadow-sm shadow-blue-500/10 btn-academic-active touch-target"
                >
                  <Plus class="w-4 h-4" />
                  <span>新增題目</span>
                </button>
              </div>
            </div>

            <!-- Add / Edit Question Modal Overlay -->
            <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
              <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" @click="handleFormCancel"></div>
              <div class="relative w-full max-w-3xl max-h-[85vh] overflow-y-auto bg-transparent z-10 rounded-2xl shadow-2xl border border-slate-200/50">
                <QuestionForm :question="editingQuestion" @saved="handleFormSaved" @cancel="handleFormCancel" />
              </div>
            </div>

            <!-- Search & Filter Area -->
            <div v-if="!showForm" class="mb-5 sm:mb-6 flex flex-col md:flex-row gap-3">
              <div class="relative flex-1">
                <Search class="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4.5 h-4.5 text-slate-400" />
                <input 
                  v-model="searchQuery" 
                  type="text" 
                  placeholder="搜尋題目內容或分類..." 
                  class="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-smooth text-sm font-medium shadow-academic" 
                />
              </div>
              <select 
                v-model="sortBy" 
                class="px-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-smooth text-sm font-semibold text-slate-700 shadow-academic"
              >
                <option value="newest">🆕 最新建立 (Newest Created)</option>
                <option value="oldest">⏳ 最舊建立 (Oldest Created)</option>
                <option value="latest-sent">⚡ 最近發送 (Latest Sent)</option>
              </select>
            </div>

            <!-- Loading state -->
            <div v-if="loading" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
              <RefreshCw class="w-8 h-8 animate-spin mx-auto mb-3 text-blue-600" />
              <p class="font-medium text-sm">正在載入題目數據庫...</p>
            </div>

            <!-- Empty state -->
            <div v-else-if="filteredAndSortedQuestions.length === 0" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
              <BookOpen class="w-12 h-12 mx-auto mb-4 text-slate-300" />
              <p class="text-base font-bold text-slate-800 mb-2">{{ searchQuery ? '沒有找到符合搜尋條件的題目' : '目前還沒有題目' }}</p>
              <p class="text-xs text-slate-400 mb-6">新增一些題目，讓學生可以在 Discord 進行回答！</p>
              <button 
                v-if="!searchQuery" 
                @click="handleAddQuestion" 
                class="px-6 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold shadow-sm transition-smooth inline-flex items-center gap-2 btn-academic-active touch-target"
              >
                <Plus class="w-4 h-4" />
                新增第一個題目
              </button>
            </div>

            <!-- Questions List -->
            <div v-else class="space-y-4">
              <div 
                v-for="q in filteredAndSortedQuestions" 
                :key="q.id" 
                class="bg-white rounded-2xl shadow-academic border border-slate-200/60 p-4 sm:p-5 hover:border-blue-200 hover:shadow-academic-hover transition-smooth shadow-academic-hover animate-fadeIn"
              >
                <div class="flex items-start justify-between gap-4">
                  <div class="flex-1 min-w-0">
                    <div class="flex flex-wrap items-center gap-2 mb-3">
                      <span class="text-xs text-slate-400 font-mono font-bold tracking-tight bg-slate-50 px-2 py-0.5 rounded border border-slate-200/60">#{{ q.id }}</span>
                      <span v-if="q.category" class="px-2 py-0.5 text-[10px] sm:text-xs bg-blue-50 text-blue-600 font-bold rounded-lg">{{ q.category }}</span>
                      <span v-if="q.question_type === 'multiple_choice'" class="px-2 py-0.5 text-[10px] sm:text-xs bg-indigo-50 text-indigo-700 rounded-lg font-bold">選擇題</span>
                      <span v-else-if="q.question_type === 'survey'" class="px-2 py-0.5 text-[10px] sm:text-xs bg-emerald-50 text-emerald-700 rounded-lg font-bold">問卷題</span>
                      <span v-else class="px-2 py-0.5 text-[10px] sm:text-xs bg-purple-50 text-purple-700 rounded-lg font-bold">簡答題</span>
                    </div>
                    <p class="text-slate-800 text-sm sm:text-base font-semibold mb-3 leading-relaxed break-words">{{ q.content || '（無題目描述，僅提供選項）' }}</p>
                    
                    <div v-if="getQuestionImageUrls(q).length > 0" class="mb-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <img
                        v-for="(imageUrl, imageIndex) in getQuestionImageUrls(q)"
                        :key="`${q.id}-img-redesigned-${imageIndex}`"
                        :src="imageUrl"
                        @error="handleImageLoadError"
                        alt="題目圖片"
                        class="max-h-48 rounded-xl border border-slate-200/70 object-contain shadow-sm"
                      />
                    </div>
                    
                    <!-- Options for multiple choice -->
                    <div v-if="q.metadata?.options" class="flex flex-col sm:flex-row flex-wrap gap-2 mb-3.5">
                      <span 
                        v-for="(option, index) in q.metadata?.options || []" 
                        :key="index" 
                        class="text-xs px-3 py-1.5 rounded-lg border font-semibold flex items-center gap-1.5 transition-smooth"
                        :class="String.fromCharCode(65 + index) === q.metadata?.correct_answer 
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
                          : 'bg-slate-50 text-slate-600 border-slate-200/60'"
                      >
                        <span class="inline-block w-4 h-4 bg-white border rounded-full text-center text-[10px] leading-4 font-mono font-bold">{{ String.fromCharCode(65 + index) }}</span>
                        {{ option }}
                      </span>
                    </div>
                    <p v-if="q.explanation" class="text-xs sm:text-sm text-slate-500 italic bg-slate-50/50 p-2.5 rounded-xl border border-dashed border-slate-200/60">
                      💡 說明: {{ q.explanation }}
                    </p>
                  </div>
                  
                  <!-- Action buttons -->
                  <div class="flex sm:flex-col items-center gap-1.5 shrink-0">
                    <button 
                      @click="handleEditQuestion(q)" 
                      class="p-2.5 text-blue-600 hover:bg-blue-50 rounded-xl transition-smooth touch-target flex items-center justify-center btn-academic-active border border-transparent hover:border-blue-100" 
                      title="編輯題目"
                    >
                      <Edit2 class="w-4 h-4" />
                    </button>
                    <button 
                      @click="handleDeleteQuestion(q.id)" 
                      class="p-2.5 text-red-600 hover:bg-red-50 rounded-xl transition-smooth touch-target flex items-center justify-center btn-academic-active border border-transparent hover:border-red-100" 
                      title="刪除題目"
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Question Analytics Panel -->
          <div v-else-if="currentTab === 'analytics'">
            <Analytics ref="analyticsRef" />
          </div>

          <!-- Student Analytics Panel -->
          <div v-else-if="currentTab === 'student-analytics'">
            <StudentAnalytics />
          </div>

          <!-- Grading Panel -->
          <div v-else-if="currentTab === 'grading'">
            <Grading 
              ref="gradingRef" 
              :initial-status="gradingStatus" 
              :initial-question-id="gradingQuestionId" 
              :initial-response-id="gradingResponseId" 
            />
          </div>

          <!-- Discord Settings Panel -->
          <div v-else-if="currentTab === 'discord-settings'">
            <DiscordSettings />
          </div>
        </div>
      </div>

      <!-- Mobile Bottom Quick Navigation Bar (lg:hidden) -->
      <nav class="lg:hidden fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-slate-200/80 z-40 px-2 py-1.5 flex justify-around items-center shadow-[0_-4px_24px_rgba(30,64,175,0.04)] pb-safe-bottom">
        <button 
          v-for="item in tabsConfig.slice(0, 6)" 
          :key="item.id"
          @click="handleTabChange(item.id)"
          class="flex flex-col items-center justify-center flex-1 py-1 px-1 rounded-xl transition-smooth btn-academic-active animate-fadeIn"
          :class="currentTab === item.id ? 'text-blue-600 font-semibold shadow-sm bg-blue-50/40' : 'text-slate-400'"
        >
          <component :is="item.icon" class="w-5 h-5 mb-0.5" />
          <span class="text-[9px] tracking-tighter whitespace-nowrap">{{ item.label }}</span>
        </button>
      </nav>
    </div>

    <!-- ============================================== -->
    <!-- Option B: Classic UI (Original Green Tabs)     -->
    <!-- ============================================== -->
    <div v-else class="w-full">
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
                  <span v-else-if="q.question_type === 'survey'" class="px-2 py-1 text-xs bg-emerald-100 text-emerald-700 rounded font-medium">問卷題</span>
                  <span v-else class="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded font-medium">簡答題</span>
                </div>
                <p class="text-gray-800 mb-2">{{ q.content || '（無題目描述，僅提供選項）' }}</p>
                <div v-if="getQuestionImageUrls(q).length > 0" class="mb-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <img
                    v-for="(imageUrl, imageIndex) in getQuestionImageUrls(q)"
                    :key="`${q.id}-img-classic-${imageIndex}`"
                    :src="imageUrl"
                    @error="handleImageLoadError"
                    alt="題目圖片"
                    class="max-h-48 rounded-lg border border-gray-200 object-contain"
                  />
                </div>
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
  </div>
</template>
