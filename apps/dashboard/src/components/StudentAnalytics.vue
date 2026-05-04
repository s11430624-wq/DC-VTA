<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { supabase } from '../supabase'
import { isResponseCountedAsCorrect, isResponseEligibleForAccuracy } from '../utils/grading'
import {
  Users, CheckCircle2, XCircle, TrendingUp, TrendingDown,
  Clock, BookOpen, Layers, Target, FileText, Activity, ArrowLeft, ChevronRight, BarChart3, Zap, User
} from 'lucide-vue-next'

// === 狀態變數 ===
const viewMode = ref('list') // 'list' | 'detail'

const students = ref([]) // 學生基本資料
const loadingStudents = ref(false)
const selectedStudentId = ref('')
const selectedStudent = ref(null) // Added ref for the selected student object
const selectedCategory = ref('') // Store the selected category name (Class Name)
const sortByAccuracyDesc = ref(true)

const studentResponses = ref([]) // 個人詳細頁面的答題紀錄
const loadingResponses = ref(false)

const availableClasses = ref([]) // 所有可用的分類 (Class Names)

// 儲存所有人的「原始」答題簡要紀錄
const allStudentRawResponses = ref(new Map())

// 儲存學生「去過」哪些群組
const studentGroupMembership = ref(new Map())

// === 1. 獲取資料 ===

// Fetch only the categories (Classes) for the dropdown initial load
async function fetchCategoriesOnly() {
  try {
    // We fetch categories similarly to Analytics.vue, by checking what categories exist in quiz_responses
    const { data: responsesData, error } = await supabase
      .from('quiz_responses')
      .select('question_bank(category)')
      
    if (error) throw error
    
    const classesSet = new Set()
    if (responsesData) {
      responsesData.forEach(r => {
        const category = r.question_bank?.category
        if (category) {
          classesSet.add(category)
        }
      })
    }
    
    availableClasses.value = Array.from(classesSet).sort()
  } catch (err) {
    console.error('載入班級(分類)列表失敗:', err)
  }
}

// Fetch students for the specifically selected category (Class Name)
async function fetchStudents() {
  if (!selectedCategory.value) {
    students.value = []
    allStudentRawResponses.value = new Map()
    studentGroupMembership.value = new Map() // Still tracking for backwards-compatibility or can be repurposed
    return
  }

  loadingStudents.value = true
  try {
    // We fetch quiz responses specifically for this category first
    // to determine which students belong here and what their stats are.
    // Notice the inner join requirement strictly for question_bank.category
    const { data: rawData, error: rawError } = await supabase
      .from('quiz_responses')
      .select('user_id, is_correct, status, score, created_at, group_id, groups(group_name), question_bank!inner(category, question_type)')
      .eq('question_bank.category', selectedCategory.value)
      
    if (rawError) throw rawError
    
    const rawResponses = new Map()
    const membership = new Map()
    const userIdsInGroup = new Set()
    
    rawData.forEach(r => {
      // Just keep track of where they answered it, though no longer strictly needed for category sorting
      const gId = r.group_id || 'null'
      userIdsInGroup.add(r.user_id)
      
      if (!membership.has(r.user_id)) {
        membership.set(r.user_id, new Set())
      }
      membership.get(r.user_id).add(gId)

      if (!rawResponses.has(r.user_id)) {
        rawResponses.set(r.user_id, [])
      }
      rawResponses.get(r.user_id).push({
        group_id: gId,
        is_correct: r.is_correct,
        status: r.status,
        score: r.score,
        question_bank: r.question_bank,
        created_at: r.created_at
      })
    })
    
    allStudentRawResponses.value = rawResponses
    studentGroupMembership.value = membership

    // Now fetch the user details only for the users who answered questions in this category
    if (userIdsInGroup.size > 0) {
      const { data: usersData, error: usersError } = await supabase
        .from('users')
        .select('user_id, display_name, student_id')
        .in('user_id', Array.from(userIdsInGroup))
        .order('display_name')
        
      if (usersError) throw usersError
      students.value = usersData || []
    } else {
      students.value = []
    }
    
  } catch (err) {
    console.error('載入班級分析失敗:', err)
  } finally {
    loadingStudents.value = false
  }
}

// === 2. 列表視圖的核心邏輯 ===
const sortedAndFilteredStudents = computed(() => {
  if (!selectedCategory.value) return []

  let processed = students.value.map(student => {
    const myResponses = allStudentRawResponses.value.get(student.user_id) || []
    const eligibleResponses = myResponses.filter(isResponseEligibleForAccuracy)
    
    const total = eligibleResponses.length
    const correct = eligibleResponses.filter(isResponseCountedAsCorrect).length
    const accuracy = total > 0 ? (correct / total) * 100 : 0
    
    let lastActive = null
    if (myResponses.length > 0) {
      const maxTime = Math.max(...myResponses.map(r => new Date(r.created_at).getTime()))
      lastActive = maxTime
    }

    return {
      ...student,
      totalAttempts: total,
      accuracy: accuracy,
      lastActive: lastActive,
      isInGroup: true // Already filtered in fetch logic
    }
  })
  
  return processed.sort((a, b) => {
    if (sortByAccuracyDesc.value) {
      if (a.totalAttempts === 0 && b.totalAttempts > 0) return 1
      if (b.totalAttempts === 0 && a.totalAttempts > 0) return -1
      return b.accuracy - a.accuracy
    } else {
      return a.accuracy - b.accuracy
    }
  })
})

// === 互動功能 ===

function onGroupChange() {
  if (viewMode.value === 'detail' && selectedStudentId.value) {
    fetchStudentData()
  }
}

watch(selectedCategory, () => {
    if (viewMode.value === 'list') {
       fetchStudents()
    }
})

function handleStudentClick(student) {
  selectedStudentId.value = student.user_id
  selectedStudent.value = student // Store the full student object
  viewMode.value = 'detail'
  fetchStudentData()
}

function goBackToList() {
  viewMode.value = 'list'
  selectedStudentId.value = ''
  selectedStudent.value = null // Clear the selection
  studentResponses.value = []
}

// 🔥 修正重點：載入詳情時，加入 reaction_time
async function fetchStudentData() {
  if (!selectedStudentId.value) {
    studentResponses.value = []
    return
  }
  
  loadingResponses.value = true
  try {
    let query = supabase
      .from('quiz_responses')
      .select(`
        id,
        question_id,
        selected_option,
        is_correct,
        created_at,
        reaction_time, 
        group_id,
        answer_text,
        ai_feedback,
        status,
        score,
        groups ( group_name ),
        question_bank!inner ( content, category, metadata, question_type )
      `)
      .eq('user_id', selectedStudentId.value)
      .order('created_at', { ascending: false })

    if (selectedCategory.value) {
       query = query.eq('question_bank.category', selectedCategory.value)
    }
      
    const { data, error } = await query
      
    if (error) throw error
    studentResponses.value = data || []
  } catch (err) {
    console.error('載入學生答題數據失敗:', err)
    studentResponses.value = []
  } finally {
    loadingResponses.value = false
  }
}

// === 詳細頁面計算 ===
const detailEligibleResponses = computed(() => studentResponses.value.filter(isResponseEligibleForAccuracy))
const detailTotalAttempted = computed(() => detailEligibleResponses.value.length)
const detailCorrectCount = computed(() => detailEligibleResponses.value.filter(isResponseCountedAsCorrect).length)
const detailIncorrectCount = computed(() => detailTotalAttempted.value - detailCorrectCount.value)
const detailOverallAccuracy = computed(() => {
  if (detailTotalAttempted.value === 0) return 0
  return Math.round((detailCorrectCount.value / detailTotalAttempted.value) * 100)
})

const detailLastActive = computed(() => {
  if (detailTotalAttempted.value === 0) return null
  return new Date(studentResponses.value[0].created_at).toLocaleString('zh-TW', { hour12: false })
})

// 🔥 計算平均反應時間
const averageReactionTime = computed(() => {
  // 過濾出有秒數的紀錄 (大於 0)
  const validResponses = studentResponses.value.filter(r => r.reaction_time > 0);
  
  if (validResponses.length === 0) return '無資料';

  // 總秒數
  const totalSeconds = validResponses.reduce((sum, r) => sum + r.reaction_time, 0);
  
  // 平均
  const avg = totalSeconds / validResponses.length;
  
  return avg.toFixed(1) + ' 秒';
})

const categoryStats = computed(() => {
  const stats = {}
  
  studentResponses.value.forEach(r => {
    // 略過簡答題，只計算選擇題的數據
    if (r.question_bank?.question_type === 'short_answer') return;

    const cat = r.question_bank?.category || '未分類 (Uncategorized)'
    if (!stats[cat]) {
      stats[cat] = { correct: 0, total: 0 }
    }
    stats[cat].total++
    if (r.is_correct) {
      stats[cat].correct++
    }
  })
  
  return Object.entries(stats).map(([category, data]) => {
    return {
      category,
      correct: data.correct,
      total: data.total,
      accuracy: Math.round((data.correct / data.total) * 100)
    }
  }).sort((a, b) => b.total - a.total)
})

onMounted(() => {
  fetchCategoriesOnly()
})
</script>

<template>
  <div class="w-full">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
      <div class="flex items-center gap-2">
        <Users class="w-5 h-5 sm:w-6 sm:h-6 text-blue-600" />
        <h2 class="text-xl sm:text-2xl font-bold text-gray-800">學生分析 <span class="hidden sm:inline">(Student Management)</span></h2>
      </div>
      <button 
        v-if="viewMode === 'detail'"
        @click="goBackToList"
        class="w-full sm:w-auto px-4 py-2 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors flex items-center justify-center gap-2 bg-white text-sm sm:text-base"
      >
        <ArrowLeft class="w-4 h-4" /> 返回列表
      </button>
    </div>

    <!-- Group Filter header -->
    <div class="bg-white p-3 sm:p-4 rounded-lg shadow-sm border border-gray-200 mb-4 sm:mb-6 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
      <div class="flex items-center gap-2 mb-1 sm:mb-0">
        <Users class="w-4 h-4 sm:w-5 sm:h-5 text-gray-400 shrink-0" />
        <label class="text-sm font-medium text-gray-700 whitespace-nowrap">班級/群組</label>
      </div>
      <div class="flex-1 w-full max-w-sm flex items-center gap-2 sm:gap-3">
        <select
          v-model="selectedCategory"
          @change="onGroupChange"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition bg-white text-gray-700 text-sm sm:text-base"
        >
          <option value="" disabled>請選擇班級...</option>
          <option v-for="category in availableClasses" :key="category" :value="category">
            {{ category }}
          </option>
        </select>
      </div>
      <div v-if="viewMode === 'list' && selectedCategory" class="text-xs sm:text-sm text-gray-500 ml-auto hidden sm:block">
        顯示: {{ sortedAndFilteredStudents.length }} 位學生
      </div>
    </div>

    <!-- Empty State -> Requires Selection first! -->
    <div v-if="viewMode === 'list' && !selectedCategory" class="bg-white p-12 rounded-lg shadow-sm border border-gray-200 text-center flex flex-col items-center justify-center min-h-[400px]">
      <div class="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center justify-center mb-4">
        <Users class="w-10 h-10 text-blue-400" />
      </div>
      <h3 class="text-xl font-bold text-gray-800 mb-2">請先選擇班級</h3>
      <p class="text-gray-500 max-w-sm mx-auto">
        從上方的下拉選單選擇一個班級以查看學生的答題分析資料與名單。
      </p>
    </div>

    <div v-else-if="viewMode === 'list' && selectedCategory">
      
      <div v-if="loadingStudents" class="text-center py-12 text-gray-500 flex flex-col items-center min-h-[400px] justify-center">
        <Activity class="w-10 h-10 animate-spin mb-4 text-blue-500" />
        <p class="text-lg">載入學生資料中...</p>
      </div>

      <div v-else class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div class="p-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
          <h3 class="font-bold text-gray-800 flex items-center gap-2">
            <BarChart3 class="w-5 h-5 text-blue-600" /> 面板花名冊 (Student Roster)
          </h3>
          <button 
            @click="sortByAccuracyDesc = !sortByAccuracyDesc"
            class="text-sm px-3 py-1.5 bg-white border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-1 transition-colors"
          >
            準確率排序
            <TrendingUp v-if="!sortByAccuracyDesc" class="w-4 h-4 text-gray-500"/>
            <TrendingDown v-else class="w-4 h-4 text-gray-500"/>
          </button>
        </div>

        <div class="overflow-x-hidden md:overflow-x-auto p-2 md:p-0 bg-gray-50 md:bg-transparent">
          <table class="w-full text-left border-collapse block md:table">
            <thead class="hidden md:table-header-group">
              <tr class="bg-white text-gray-500 text-sm border-b border-gray-200">
                <th class="p-4 font-semibold">姓名 / 學號</th>
                <th class="p-4 font-semibold w-32 border-l border-gray-100 text-center">
                  該班答題數
                </th>
                <th class="p-4 font-semibold w-40 border-l border-gray-100 text-center">
                  該班準確率
                </th>
                <th class="p-4 font-semibold w-48 border-l border-gray-100">最後活動時間</th>
                <th class="p-4 font-semibold w-24"></th>
              </tr>
            </thead>
            <tbody class="block md:table-row-group divide-y md:divide-y-0 divide-gray-100">
              <tr 
                v-for="student in sortedAndFilteredStudents" 
                :key="student.user_id" 
                class="block md:table-row bg-white hover:bg-blue-50/50 cursor-pointer transition-colors group mb-3 md:mb-0 rounded-lg shadow-sm md:shadow-none border md:border-b border-gray-200 md:border-gray-100"
                @click="handleStudentClick(student)"
              >
                <!-- 卡片頂部：姓名等 -->
                <td class="block md:table-cell p-3 md:p-4 border-b md:border-none border-gray-100">
                  <div class="flex justify-between items-center md:block">
                    <div>
                      <div class="font-medium text-gray-800 text-base md:text-sm">{{ student.display_name }}</div>
                      <div class="text-xs text-gray-500 mt-0.5">{{ student.student_id ? student.student_id : '無學號' }}</div>
                    </div>
                    <ChevronRight class="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-colors md:hidden" />
                  </div>
                </td>
                
                <!-- 卡片數據行 -->
                <td class="block md:table-cell px-3 py-2 md:p-4 text-left md:text-center md:border-l md:border-gray-50 text-sm">
                  <div class="flex justify-between items-center md:block">
                    <span class="md:hidden text-gray-500 text-xs">該班答題數</span>
                    <span class="inline-block bg-gray-100 text-gray-700 px-2 py-1 rounded text-xs md:text-sm font-medium">
                      {{ student.totalAttempts }} 題
                    </span>
                  </div>
                </td>
                <td class="block md:table-cell px-3 py-2 md:p-4 text-left md:text-center md:border-l md:border-gray-50 text-sm border-t md:border-t-0 border-gray-50">
                  <div class="flex justify-between items-center md:block">
                    <span class="md:hidden text-gray-500 text-xs">該班準確率</span>
                    <span 
                      :class="[
                        'inline-block px-2 py-1 rounded font-bold text-xs md:text-sm',
                        student.accuracy >= 80 ? 'bg-green-100 text-green-700' : 
                        student.accuracy >= 60 ? 'bg-yellow-100 text-yellow-700' : 
                        student.totalAttempts === 0 ? 'bg-gray-100 text-gray-500' : 'bg-red-100 text-red-700'
                      ]"
                    >
                      {{ student.totalAttempts > 0 ? Math.round(student.accuracy) + '%' : '-' }}
                    </span>
                  </div>
                </td>
                <td class="block md:table-cell px-3 py-2 md:p-4 text-gray-500 text-xs md:text-sm md:border-l md:border-gray-50 border-t md:border-t-0 border-gray-50 bg-gray-50/50 md:bg-transparent rounded-b-lg md:rounded-none">
                  <div class="flex justify-between items-center md:block">
                    <span class="md:hidden text-gray-400">最後活動</span>
                    <span>{{ student.lastActive ? new Date(student.lastActive).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '無紀錄' }}</span>
                  </div>
                </td>
                <td class="hidden md:table-cell p-4 text-right">
                  <ChevronRight class="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-colors ml-auto" />
                </td>
              </tr>
              <tr v-if="sortedAndFilteredStudents.length === 0">
                <td colspan="5" class="p-8 text-center text-gray-500">
                  尚無學生資料或查無符合條件之學生。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-else-if="viewMode === 'detail'">
      
      <!-- User Details Header -->
      <div v-if="selectedStudent" class="bg-indigo-50/50 p-4 sm:p-6 rounded-xl border border-indigo-100 mb-6 flex items-center gap-3 sm:gap-5 flex-wrap sm:flex-nowrap">
        <div class="w-12 h-12 sm:w-14 sm:h-14 bg-indigo-100 rounded-full flex items-center justify-center shrink-0 border border-indigo-200">
          <User class="w-6 h-6 sm:w-8 sm:h-8 text-indigo-500" />
        </div>
        <div>
          <h3 class="text-xl sm:text-2xl font-bold text-gray-900 leading-tight">
            {{ selectedStudent.display_name || '未知學生' }}
          </h3>
          <div class="text-indigo-600/80 mt-1 font-medium flex items-center gap-2">
            <span class="text-xs sm:text-sm border border-indigo-200 px-2 py-0.5 rounded-md bg-white">
               學號: {{ selectedStudent.student_id ? selectedStudent.student_id : '無學號' }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="loadingResponses" class="text-center py-12 text-gray-500">
        <Activity class="w-8 h-8 animate-spin mx-auto mb-2 text-blue-500" />
        <p>載入學生詳細報告中...</p>
      </div>

      <div v-else-if="studentResponses.length === 0" class="text-center py-12 text-gray-500 bg-gray-50 rounded-lg border border-dashed border-gray-300">
        <FileText class="w-12 h-12 text-gray-400 mx-auto mb-3" />
        <p>該學生目前沒有任何答題紀錄</p>
      </div>

      <div v-else class="space-y-8">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div class="text-gray-500 text-sm mb-1 flex items-center gap-2">
            <Layers class="w-4 h-4" /> 
            本班答題數
          </div>
          <div class="text-3xl font-bold text-gray-800">{{ detailTotalAttempted }} 題</div>
        </div>

        <div class="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div class="text-gray-500 text-sm mb-1 flex items-center gap-2">
            <Target class="w-4 h-4" /> 準確率
          </div>
          <div class="text-3xl font-bold flex items-baseline gap-2" :class="detailOverallAccuracy >= 60 ? 'text-green-600' : 'text-orange-500'">
            {{ detailOverallAccuracy }}%
          </div>
        </div>

        <div class="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div class="text-gray-500 text-sm mb-1 flex items-center gap-2">
            <Zap class="w-4 h-4 text-yellow-500" /> 平均反應速度
          </div>
          <div class="text-3xl font-bold text-gray-800">
            {{ averageReactionTime }}
          </div>
        </div>

        <div class="bg-white p-5 rounded-lg shadow-sm border border-gray-200">
          <div class="text-gray-500 text-sm mb-1 flex items-center gap-2">
            <Clock class="w-4 h-4" /> 最近答題
          </div>
          <div class="text-sm font-medium text-gray-800 mt-2 line-clamp-2">
            {{ detailLastActive || '尚未有活動紀錄' }}
          </div>
        </div>
      </div>

      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
        <div class="space-y-4">
          <div v-for="cat in categoryStats" :key="cat.category" class="pt-2">
            <div class="flex justify-between items-end mb-1">
              <div class="font-medium text-gray-700">
                {{ cat.category }}
                <span v-if="cat.accuracy < 50" class="ml-2 text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded font-semibold">
                  需加強 (Needs Improvement)
                </span>
              </div>
              <div class="text-sm text-gray-500 font-mono">
                {{ cat.accuracy }}% 
                <span class="text-xs">({{ cat.correct }}/{{ cat.total }})</span>
              </div>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-2">
              <div class="h-2 rounded-full transition-all duration-500"
                :class="
                  cat.accuracy >= 80 ? 'bg-green-500' : 
                  cat.accuracy >= 60 ? 'bg-yellow-500' : 
                  cat.accuracy >= 50 ? 'bg-orange-400' : 'bg-red-500'
                "
                :style="{ width: cat.accuracy + '%' }"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div class="p-6 border-b border-gray-200">
          <h3 class="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Activity class="w-5 h-5 text-indigo-600" />
            答題歷史記錄
          </h3>
        </div>
        
        <div class="overflow-x-hidden md:overflow-x-auto p-2 md:p-0 bg-gray-50 md:bg-transparent">
          <table class="w-full text-left border-collapse block md:table">
            <thead class="hidden md:table-header-group">
              <tr class="bg-gray-50 text-gray-600 text-sm border-b border-gray-200">
                <th class="p-4 font-semibold w-32">時間</th>
                <th class="p-4 font-semibold w-5/12">題目</th>
                <th class="p-4 font-semibold">該生回答</th>
                <th class="p-4 font-semibold w-24 text-center">結果</th>
                <th class="p-4 font-semibold w-24 text-center">秒數</th>
              </tr>
            </thead>
            <tbody class="block md:table-row-group divide-y md:divide-y-0 divide-gray-100 text-sm">
              <tr 
                v-for="res in studentResponses" 
                :key="res.id" 
                class="block md:table-row bg-white hover:bg-gray-50 transition-colors mb-3 md:mb-0 rounded-lg shadow-sm md:shadow-none border md:border-b border-gray-200 md:border-gray-100"
              >
                <!-- 卡片：時間與結果 -->
                <td class="block md:table-cell p-3 md:p-4 text-gray-500 text-xs md:text-sm border-b md:border-none border-gray-100">
                  <div class="flex justify-between items-center md:block">
                    <span>{{ new Date(res.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) }}</span>
                    <!-- 手機版右側顯示對錯/狀態標籤 -->
                    <div class="md:hidden">
                      <template v-if="res.question_bank?.question_type === 'short_answer'">
                        <span v-if="res.status === 'pending'" class="inline-flex items-center gap-1 text-gray-600 bg-gray-100 px-2 py-0.5 rounded text-[10px] font-bold">
                          ⏳ 待批改
                        </span>
                        <span v-else class="inline-flex items-center gap-1 text-blue-700 bg-blue-100 px-2 py-0.5 rounded text-[10px] font-bold">
                          🎯 {{ res.score }} 分
                        </span>
                      </template>
                      <template v-else>
                        <span v-if="res.is_correct" class="inline-flex items-center gap-1 text-green-700 bg-green-100 px-2 py-0.5 rounded text-[10px] font-bold">
                          <CheckCircle2 class="w-3 h-3" /> 對
                        </span>
                        <span v-else class="inline-flex items-center gap-1 text-red-700 bg-red-100 px-2 py-0.5 rounded text-[10px] font-bold">
                          <XCircle class="w-3 h-3" /> 錯
                        </span>
                      </template>
                    </div>
                  </div>
                </td>
                
                <!-- 卡片：題目 -->
                <td class="block md:table-cell px-3 py-2 md:p-4 text-gray-800">
                  <div class="md:hidden text-[10px] text-gray-400 mb-1">題目內容</div>
                  <div class="line-clamp-2 md:line-clamp-3 text-sm">
                    {{ res.question_bank?.content || '（題目已遭刪除）' }}
                  </div>
                  <div class="text-xs text-blue-500 mt-1" v-if="res.question_bank?.category">
                    {{ res.question_bank.category }}
                  </div>
                </td>
                
                <!-- 卡片：該生回答 -->
                <td class="block md:table-cell px-3 py-2 md:p-4 text-gray-700 font-medium text-xs md:text-sm md:border-l md:border-gray-50 border-t md:border-t-0 border-gray-50">
                  <!-- 簡答題：顯示答案文字 -->
                  <template v-if="res.question_bank?.question_type === 'short_answer'">
                    <div class="md:hidden text-gray-500 text-xs mb-1">學生回答</div>
                    <div
                      v-if="res.answer_text"
                      class="line-clamp-2 hover:line-clamp-none transition-all cursor-pointer text-sm"
                      :title="res.answer_text"
                    >
                      {{ res.answer_text }}
                    </div>
                    <span v-else class="text-gray-400 text-xs">（未作答）</span>
                    <!-- AI 評語 -->
                    <div v-if="res.ai_feedback" class="mt-2 bg-purple-50 border border-purple-100 rounded-lg p-2.5">
                      <p class="text-[10px] font-semibold text-purple-600 mb-1">🤖 AI 評語</p>
                      <p class="text-xs text-purple-800 leading-relaxed whitespace-pre-wrap line-clamp-3 hover:line-clamp-none cursor-pointer">{{ res.ai_feedback }}</p>
                    </div>
                  </template>
                  <!-- 選擇題：顯示選項 -->
                  <template v-else>
                    <div class="flex justify-between items-center md:block">
                      <span class="md:hidden text-gray-500 text-xs">作答選項</span>
                      <span class="font-mono">{{ res.selected_option }}</span>
                    </div>
                  </template>
                </td>
                
                <!-- 桌面版：結果 -->
                <td class="hidden md:table-cell p-4 text-center">
                  <template v-if="res.question_bank?.question_type === 'short_answer'">
                    <span v-if="res.status === 'pending'" class="inline-flex items-center gap-1 text-gray-600 bg-gray-100 px-2 py-1 rounded text-xs font-bold">
                      ⏳ 待批改
                    </span>
                    <span v-else class="inline-flex items-center gap-1 text-blue-700 bg-blue-100 px-2 py-1 rounded text-xs font-bold">
                      🎯 {{ res.score }} 分
                    </span>
                  </template>
                  <template v-else>
                    <span v-if="res.is_correct" class="inline-flex items-center gap-1 text-green-700 bg-green-100 px-2 py-1 rounded text-xs font-bold">
                      <CheckCircle2 class="w-3 h-3" /> 對
                    </span>
                    <span v-else class="inline-flex items-center gap-1 text-red-700 bg-red-100 px-2 py-1 rounded text-xs font-bold">
                      <XCircle class="w-3 h-3" /> 錯
                    </span>
                  </template>
                </td>
                
                <!-- 卡片：平均花費秒數 -->
                <td class="block md:table-cell px-3 py-2 md:p-4 text-center md:text-gray-500 md:font-mono text-xs md:border-l md:border-gray-50 border-t md:border-t-0 border-gray-50 bg-gray-50/50 md:bg-transparent rounded-b-lg md:rounded-none">
                  <div class="flex justify-between items-center md:block">
                    <span class="md:hidden text-gray-400">反應秒數</span>
                    <span class="font-mono">{{ res.reaction_time ? res.reaction_time + 's' : '-' }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      
      </div>
    </div>
  </div>
</template>

<style scoped>
/* You can add custom styling here if needed */
</style>
