<script setup>
import { ref, onMounted, watch, inject } from 'vue'
import { supabase } from '../supabase'
import { Trophy, Clock, CheckCircle2, XCircle, Zap, HelpCircle, RefreshCw } from 'lucide-vue-next'
import { isPendingShortAnswerResponse } from '../utils/grading'

const props = defineProps({
  mode: {
    type: String,
    default: 'feed' // 'feed' | 'rank'
  }
})

const feedData = ref([])
const rankData = ref([])

// Replace groups with categories
const availableCategories = ref([])
const selectedCategory = ref('')
const loading = ref(false)

const uiVariant = inject('uiVariant', ref('classic'))

async function fetchCategories() {
  try {
    const { data: responsesData, error } = await supabase
      .from('quiz_responses')
      .select('question_bank!inner(category)')
      
    if (error) throw error
    
    const categoriesSet = new Set()
    if (responsesData) {
      responsesData.forEach(r => {
        const category = r.question_bank?.category
        if (category) {
          categoriesSet.add(category)
        }
      })
    }
    
    availableCategories.value = Array.from(categoriesSet).sort()
  } catch (err) {
    console.error('載入班級(分類)列表失敗:', err)
  }
}

async function fetchData() {
  if (props.mode === 'feed') {
    loading.value = true
    await fetchFeed()
    loading.value = false
  } else if (props.mode === 'rank') {
    if (availableCategories.value.length === 0) {
      await fetchCategories()
    }
    if (selectedCategory.value) {
      loading.value = true
      await fetchRank()
      loading.value = false
    } else {
      rankData.value = []
    }
  }
}

async function fetchFeed() {
  const { data, error } = await supabase
    .from('quiz_responses')
    .select(`
      created_at, is_correct, status,
      users ( display_name, student_id ),
      question_bank ( content, question_type )
    `)
    .order('created_at', { ascending: false })
    .limit(30)

  if (error) {
    console.error('載入最新動態失敗:', error)
  } else {
    feedData.value = data || []
  }
}

async function fetchRank() {
  if (!selectedCategory.value) return

  try {
    const { data: rawData, error } = await supabase
      .from('quiz_responses')
      .select(`
        user_id,
        is_correct,
        score,
        status,
        users!inner ( display_name, student_id ),
        question_bank!inner(category, question_type)
      `)
      .eq('question_bank.category', selectedCategory.value)

    if (error) throw error
    
    if (!rawData || rawData.length === 0) {
      rankData.value = []
      return
    }

    // Aggregate data by user
    const userStats = new Map()

    rawData
      .filter(r => !isPendingShortAnswerResponse(r))
      .forEach(r => {
      const uId = r.user_id
      if (!userStats.has(uId)) {
        userStats.set(uId, {
          user_id: uId,
          display_name: r.users?.display_name || '未知',
          total_score: 0,
          correct_count: 0
        })
      }
      
      const stats = userStats.get(uId)
      
      // Some DBs have score as null or undefined, default to 0
      stats.total_score += (r.score || 0)
      if (r.is_correct) {
        stats.correct_count += 1
      }
    })

    // Convert to array, sort by total_score desc, take top 10
    const aggregated = Array.from(userStats.values())
    aggregated.sort((a, b) => b.total_score - a.total_score)
    
    // Take top 10 and assign rank numbers to track visually later
    const top10 = aggregated.slice(0, 10)
    rankData.value = top10

  } catch (err) {
    console.error('載入排行榜失敗:', err)
    rankData.value = []
  }
}

onMounted(() => {
  fetchData()
})

watch(() => props.mode, () => {
  fetchData()
})

watch(selectedCategory, () => {
  if (props.mode === 'rank') {
    fetchData()
  }
})

/**
 * 判斷最新戰況中每筆資料的顯示狀態
 */
function getStatus(item) {
  const qType = String(item.question_bank?.question_type || '').trim().toLowerCase()
  
  // 問卷不需批改，固定顯示已提交
  if (qType === 'survey') {
    return 'submitted'
  }

  // 只有簡答題會顯示待批改
  if (qType === 'short_answer' && item.status === 'pending') {
    return 'pending'
  }
  // 條件二（明確答對）
  if (item.is_correct === true) {
    return 'correct'
  }
  // 條件三（明確答錯）
  if (item.is_correct === false) {
    return 'wrong'
  }
  
  // 條件四（邊界防護）
  return 'unknown'
}

// 暴露方法供父組件調用
defineExpose({
  fetchLeaderboard: fetchData
})
</script>

<template>
  <div class="w-full">
    <!-- ============================================== -->
    <!-- Option A: Redesigned UI (Academic Workbench) -->
    <!-- ============================================== -->
    <div v-if="uiVariant === 'redesigned'" class="w-full">
      <!-- Title & Filters -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5 sm:mb-6 bg-white p-4 rounded-xl border border-slate-200/60 shadow-academic">
        <div class="flex items-center gap-2.5">
          <div class="p-2 rounded-lg" :class="mode === 'feed' ? 'bg-blue-50 text-blue-600' : 'bg-yellow-50 text-yellow-600'">
            <Zap v-if="mode === 'feed'" class="w-5 h-5 sm:w-6 sm:h-6" />
            <Trophy v-else class="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div>
            <h2 class="text-base sm:text-lg font-bold text-slate-800 tracking-wide font-sans">
              {{ mode === 'feed' ? '最新答題動態' : '班級排行榜 (Top 10)' }}
            </h2>
            <p class="text-[10px] sm:text-xs text-slate-400 font-medium">即時更新學員表現與學習軌跡</p>
          </div>
        </div>

        <!-- Class Filter only for rank mode -->
        <div v-if="mode === 'rank'" class="w-full sm:w-auto">
          <select
            v-model="selectedCategory"
            class="w-full sm:w-64 px-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-smooth text-sm font-semibold text-slate-700 shadow-academic"
          >
            <option value="" disabled>請選擇班級以查看排名</option>
            <option v-for="category in availableCategories" :key="category" :value="category">
              {{ category }}
            </option>
          </select>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
        <RefreshCw class="w-8 h-8 animate-spin mx-auto mb-3 text-blue-600" />
        <p class="font-medium text-sm">正在同步最新戰況數據...</p>
      </div>

      <!-- Empty State -->
      <div v-else-if="mode === 'feed' && feedData.length === 0" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
        <Zap class="w-12 h-12 mx-auto mb-4 text-slate-300" />
        <p class="text-base font-bold text-slate-800 mb-2">目前還沒有人答題喔！</p>
        <p class="text-xs text-slate-400 font-medium">當學生在 Discord 答題時，此處將即時推播動態。</p>
      </div>
      
      <div v-else-if="mode === 'rank' && !selectedCategory" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
        <Trophy class="w-12 h-12 mx-auto mb-4 text-slate-300" />
        <p class="text-base font-bold text-slate-800 mb-2">請選擇班級以查看排名</p>
        <p class="text-xs text-slate-400 font-medium">請從上方下拉選單選擇想要分析的班級。</p>
      </div>

      <div v-else-if="mode === 'rank' && selectedCategory && rankData.length === 0" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
        <Trophy class="w-12 h-12 mx-auto mb-4 text-slate-300" />
        <p class="text-base font-bold text-slate-800 mb-2">該班級目前還沒有排名資料！</p>
        <p class="text-xs text-slate-400 font-medium">此班級暫時沒有被採計分數的答題紀錄。</p>
      </div>

      <!-- Feed Mode Content -->
      <div v-else-if="mode === 'feed'" class="space-y-4">
        <div
          v-for="(item, index) in feedData"
          :key="index"
          class="bg-white rounded-2xl shadow-academic border border-slate-200/60 p-4 hover:border-blue-200 hover:shadow-academic-hover transition-smooth shadow-academic-hover animate-fadeIn"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex flex-wrap items-center gap-2 mb-2.5">
                <span class="text-xs text-slate-400 font-mono font-bold tracking-tight bg-slate-50 px-2 py-0.5 rounded border border-slate-200/60 flex items-center gap-1">
                  <Clock class="w-3.5 h-3.5" />
                  {{ new Date(item.created_at).toLocaleString('zh-TW', { hour12: false }) }}
                </span>
                <span v-if="item.question_bank?.category" class="px-2 py-0.5 text-[10px] bg-blue-50 text-blue-600 font-bold rounded-lg">
                  {{ item.question_bank.category }}
                </span>
              </div>
              <div class="flex items-center gap-2">
                <span class="font-bold text-slate-800 text-sm sm:text-base">
                  {{ item.users?.display_name || '未知學生' }}
                </span>
                <span class="text-xs text-slate-400 font-mono font-medium">
                  ({{ item.users?.student_id || 'N/A' }})
                </span>
              </div>
              <p class="text-slate-600 text-xs sm:text-sm line-clamp-2 bg-slate-50/50 p-2.5 rounded-xl border border-slate-250/30 mt-2.5 leading-relaxed font-semibold">
                {{ item.question_bank?.content || '（該題目已被刪除）' }}
              </p>
            </div>
            
            <div class="shrink-0">
              <template v-if="getStatus(item) === 'pending'">
                <div class="inline-flex items-center gap-1.5 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full text-xs font-bold border border-amber-200">
                  <Clock class="w-4 h-4 animate-pulse" />
                  <span>待批改</span>
                </div>
              </template>
              <template v-else-if="getStatus(item) === 'submitted'">
                <div class="inline-flex items-center gap-1.5 text-blue-600 bg-blue-50 px-3 py-1.5 rounded-full text-xs font-bold border border-blue-200/60">
                  <CheckCircle2 class="w-4 h-4" />
                  <span>已提交</span>
                </div>
              </template>
              <template v-else-if="getStatus(item) === 'correct'">
                <div class="inline-flex items-center gap-1.5 text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-full text-xs font-bold border border-emerald-200/60">
                  <CheckCircle2 class="w-4 h-4" />
                  <span>答對</span>
                </div>
              </template>
              <template v-else-if="getStatus(item) === 'wrong'">
                <div class="inline-flex items-center gap-1.5 text-red-600 bg-red-50 px-3 py-1.5 rounded-full text-xs font-bold border border-red-200/60">
                  <XCircle class="w-4 h-4" />
                  <span>答錯</span>
                </div>
              </template>
              <template v-else>
                <div class="inline-flex items-center gap-1.5 text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-full text-xs font-bold border border-emerald-200/60">
                  <HelpCircle class="w-4 h-4" />
                  <span>已批改</span>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Rank Mode Content -->
      <div v-else-if="mode === 'rank'" class="grid grid-cols-1 gap-3">
        <div
          v-for="(student, index) in rankData"
          :key="index"
          class="flex items-center justify-between p-4 rounded-2xl border transition-smooth shadow-academic hover:shadow-academic-hover bg-white hover:border-blue-255"
          :class="[
            index === 0 ? 'bg-gradient-to-r from-amber-50/50 to-yellow-50/10 border-yellow-200/80 shadow-sm' :
            index === 1 ? 'bg-gradient-to-r from-slate-50 to-white border-slate-200/80 shadow-sm' :
            index === 2 ? 'bg-gradient-to-r from-orange-50/20 to-white border-orange-200/60 shadow-sm' :
            'border-slate-250/30'
          ]"
        >
          <div class="flex items-center gap-3.5 min-w-0">
            <!-- Rank Trophy / Index Badge -->
            <div class="w-11 h-11 flex items-center justify-center font-bold text-lg rounded-full shrink-0 shadow-sm border font-sans"
              :class="[
                index === 0 ? 'bg-yellow-100/80 text-yellow-700 border-yellow-300' :
                index === 1 ? 'bg-slate-100 text-slate-700 border-slate-300' :
                index === 2 ? 'bg-orange-100/80 text-orange-700 border-orange-300' :
                'bg-slate-50 text-slate-400 border-slate-200/60'
              ]"
            >
              <span v-if="index === 0">🥇</span>
              <span v-else-if="index === 1">🥈</span>
              <span v-else-if="index === 2">🥉</span>
              <span v-else class="font-mono text-sm font-bold text-slate-450">{{ index + 1 }}</span>
            </div>
            
            <div class="min-w-0">
              <div class="font-bold text-slate-800 text-base sm:text-lg truncate">
                {{ student.display_name || '未知學生' }}
              </div>
              <div class="text-[10px] text-slate-450 font-mono font-bold mt-0.5 uppercase tracking-wide">
                {{ selectedCategory }} 班級學員
              </div>
            </div>
          </div>
          
          <div class="text-right shrink-0">
            <div class="text-xl sm:text-2xl font-black font-sans flex items-baseline justify-end gap-0.5"
              :class="[
                index === 0 ? 'text-yellow-600' :
                index === 1 ? 'text-slate-650' :
                index === 2 ? 'text-orange-600' :
                'text-blue-650'
              ]"
            >
              {{ student.total_score || 0 }}
              <span class="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider ml-1">pts</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================== -->
    <!-- Option B: Classic UI (Original Layout)          -->
    <!-- ============================================== -->
    <div v-else class="w-full">
      <!-- Header -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div class="flex items-center gap-2">
          <template v-if="mode === 'feed'">
            <Zap class="w-6 h-6 text-blue-500" />
            <h2 class="text-2xl font-bold text-gray-800">最新答題動態</h2>
          </template>
          <template v-else-if="mode === 'rank'">
            <Trophy class="w-6 h-6 text-yellow-500" />
            <h2 class="text-2xl font-bold text-gray-800">班級排行榜 (Top 10)</h2>
          </template>
        </div>

        <!-- Class Filter only for rank mode -->
        <div v-if="mode === 'rank'" class="w-full sm:w-auto">
          <select
            v-model="selectedCategory"
            class="w-full sm:w-64 px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:border-green-500 focus:ring-green-500 bg-white text-gray-700 font-medium"
          >
            <option value="" disabled>請選擇班級以查看排名</option>
            <option v-for="category in availableCategories" :key="category" :value="category">
              {{ category }}
            </option>
          </select>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-8 text-gray-500">
        載入中...
      </div>

      <!-- Empty State -->
      <div v-else-if="mode === 'feed' && feedData.length === 0" class="text-center py-12 text-gray-500">
        <p class="text-lg">目前還沒有人答題喔！</p>
      </div>
      
      <div v-else-if="mode === 'rank' && !selectedCategory" class="text-center py-12 text-gray-500 bg-white rounded-xl shadow-sm border border-gray-200">
        <p class="text-lg">請選擇班級以查看排名</p>
      </div>

      <div v-else-if="mode === 'rank' && selectedCategory && rankData.length === 0" class="text-center py-12 text-gray-500 bg-white rounded-xl shadow-sm border border-gray-200">
        <p class="text-lg">該班級目前還沒有排名資料！</p>
      </div>

      <!-- Feed Mode Content -->
      <div v-else-if="mode === 'feed'" class="space-y-3">
        <div
          v-for="(item, index) in feedData"
          :key="index"
          class="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow"
        >
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-2">
                <Clock class="w-4 h-4 text-gray-400" />
                <span class="text-sm text-gray-500">
                  {{ new Date(item.created_at).toLocaleString('zh-TW') }}
                </span>
              </div>
              <div class="flex items-center gap-2 mb-1">
                <span class="font-semibold text-gray-800">
                  {{ item.users?.display_name || '未知' }}
                </span>
                <span class="text-sm text-gray-500">
                  ({{ item.users?.student_id || 'N/A' }})
                </span>
              </div>
              <p class="text-sm text-gray-600 line-clamp-2 bg-gray-50 p-2 rounded mt-2">
                {{ item.question_bank?.content || '題目已刪除' }}
              </p>
            </div>
            <div class="ml-4 shrink-0">
              <template v-if="getStatus(item) === 'pending'">
                <div class="flex items-center gap-1 text-orange-600 bg-orange-50 px-3 py-1 rounded-full text-sm font-semibold border border-orange-200">
                  <Clock class="w-5 h-5" />
                  <span>待批改</span>
                </div>
              </template>
              <template v-else-if="getStatus(item) === 'submitted'">
                <div class="flex items-center gap-1 text-sky-700 bg-sky-50 px-3 py-1 rounded-full text-sm font-semibold border border-sky-200">
                  <CheckCircle2 class="w-5 h-5" />
                  <span>已提交</span>
                </div>
              </template>
              <template v-else-if="getStatus(item) === 'correct'">
                <div class="flex items-center gap-1 text-green-600 bg-green-50 px-3 py-1 rounded-full text-sm font-semibold border border-green-100">
                  <CheckCircle2 class="w-5 h-5" />
                  <span>答對</span>
                </div>
              </template>
              <template v-else-if="getStatus(item) === 'wrong'">
                <div class="flex items-center gap-1 text-red-600 bg-red-50 px-3 py-1 rounded-full text-sm font-semibold border border-red-100">
                  <XCircle class="w-5 h-5" />
                  <span>答錯</span>
                </div>
              </template>
              <template v-else>
                <div class="flex items-center gap-1 text-green-600 bg-green-50 px-3 py-1 rounded-full text-sm font-semibold border border-green-100">
                  <HelpCircle class="w-5 h-5" />
                  <span>已批改</span>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Rank Mode Content -->
      <div v-else-if="mode === 'rank'" class="space-y-2">
        <div
          v-for="(student, index) in rankData"
          :key="index"
          class="flex items-center justify-between p-4 rounded-xl border transition-all"
          :class="[
            index === 0 ? 'bg-gradient-to-r from-yellow-50 to-amber-50 border-yellow-200 shadow-sm' :
            index === 1 ? 'bg-gradient-to-r from-gray-50 to-slate-100 border-gray-200' :
            index === 2 ? 'bg-gradient-to-r from-orange-50 to-orange-100 border-orange-200' :
            'bg-white border-gray-100 hover:border-gray-200 hover:bg-gray-50'
          ]"
        >
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 flex items-center justify-center font-bold text-xl rounded-full shrink-0 shadow-sm"
              :class="[
                index === 0 ? 'bg-yellow-100 text-yellow-700 border border-yellow-300' :
                index === 1 ? 'bg-gray-100 text-gray-700 border border-gray-300' :
                index === 2 ? 'bg-orange-100 text-orange-700 border border-orange-300' :
                'bg-gray-50 text-gray-500 text-base border border-gray-200'
              ]"
            >
              <span v-if="index === 0">🥇</span>
              <span v-else-if="index === 1">🥈</span>
              <span v-else-if="index === 2">🥉</span>
              <span v-else>{{ index + 1 }}</span>
            </div>
            <div class="font-bold text-gray-800 text-lg md:text-xl">
              {{ student.display_name || '未知' }}
            </div>
          </div>
          <div class="text-right">
            <div class="text-2xl font-extrabold flex items-baseline gap-1"
              :class="[
                index === 0 ? 'text-yellow-600' :
                index === 1 ? 'text-gray-600' :
                index === 2 ? 'text-orange-600' :
                'text-indigo-600'
              ]"
            >
              {{ student.total_score || 0 }}
              <span class="text-sm font-medium text-gray-500">pts</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
