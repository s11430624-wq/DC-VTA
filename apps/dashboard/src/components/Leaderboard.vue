<script setup>
import { ref, onMounted, watch } from 'vue'
import { supabase } from '../supabase'
import { Trophy, Clock, CheckCircle2, XCircle, Zap, HelpCircle } from 'lucide-vue-next'
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
  const qType = item.question_bank?.question_type
  
  // 條件一（優先攔截待批改狀態）： 當題目類型不是選擇題，且狀態確實為待批改 (pending)
  if (qType !== 'multiple_choice' && item.status === 'pending') {
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
</template>
