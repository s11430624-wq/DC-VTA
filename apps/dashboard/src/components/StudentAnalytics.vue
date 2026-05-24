<script setup>
import { ref, computed, onMounted, watch, inject } from 'vue'
import { supabase } from '../supabase'
import { isResponseCountedAsCorrect, isResponseEligibleForAccuracy } from '../utils/grading'
import {
  Users, CheckCircle2, XCircle, TrendingUp, TrendingDown,
  Clock, BookOpen, Layers, Target, FileText, Activity, ArrowLeft, ChevronRight, BarChart3, Zap, User, RefreshCw
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

const uiVariant = inject('uiVariant', ref('classic'))

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
    // 班級名冊作為母體：先抓 users.class_name，避免遺漏「應答但未作答」學生
    const { data: classUsers, error: classUsersError } = await supabase
      .from('users')
      .select('user_id, display_name, student_id')
      .eq('class_name', selectedCategory.value)
      .order('display_name')

    if (classUsersError) throw classUsersError
    const classUserIds = new Set((classUsers || []).map(u => u.user_id))

    // 再抓這個班級分類的作答紀錄，回填到每位學生
    const { data: rawData, error: rawError } = await supabase
      .from('quiz_responses')
      .select('user_id, question_id, is_correct, status, score, reaction_time, created_at, group_id, groups(group_name), question_bank!inner(category, question_type)')
      .eq('question_bank.category', selectedCategory.value)
      
    if (rawError) throw rawError
    
    const rawResponses = new Map()
    const membership = new Map()
    const userIdsInGroup = new Set()
    
    rawData.forEach(r => {
      // 只保留本班名冊學生，避免把其他班級作答混進來
      if (!classUserIds.has(r.user_id)) {
        return
      }
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
        question_id: r.question_id,
        group_id: gId,
        is_correct: r.is_correct,
        status: r.status,
        score: r.score,
        reaction_time: r.reaction_time,
        question_bank: r.question_bank,
        created_at: r.created_at
      })
    })
    
    allStudentRawResponses.value = rawResponses
    studentGroupMembership.value = membership

    // 以班級名冊為主，並補上「有作答但未掛 class_name」的歷史學生，避免資料斷層
    const rosterMap = new Map((classUsers || []).map(u => [u.user_id, u]))
    const missingResponderIds = Array.from(userIdsInGroup).filter(id => !rosterMap.has(id))
    if (missingResponderIds.length > 0) {
      const { data: fallbackUsers, error: fallbackUsersError } = await supabase
        .from('users')
        .select('user_id, display_name, student_id')
        .in('user_id', missingResponderIds)
      if (fallbackUsersError) throw fallbackUsersError
      ;(fallbackUsers || []).forEach(u => rosterMap.set(u.user_id, u))
    }
    students.value = Array.from(rosterMap.values()).sort((a, b) => {
      const aName = String(a.display_name || '')
      const bName = String(b.display_name || '')
      return aName.localeCompare(bName, 'zh-Hant')
    })
    
  } catch (err) {
    console.error('載入班級分析失敗:', err)
  } finally {
    loadingStudents.value = false
  }
}

// === 2. 列表視圖的核心邏輯 ===
const expectedQuestionIds = computed(() => {
  const ids = new Set()
  for (const myResponses of allStudentRawResponses.value.values()) {
    myResponses.forEach(r => {
      if (r.question_id != null) {
        ids.add(r.question_id)
      }
    })
  }
  return ids
})

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

    const answeredQuestionIds = new Set(
      myResponses
        .map(r => r.question_id)
        .filter(id => id != null)
    )
    const missingQuestionCount = Math.max(expectedQuestionIds.value.size - answeredQuestionIds.size, 0)

    return {
      ...student,
      submittedCount: myResponses.length,
      totalAttempts: total,
      accuracy: accuracy,
      missingQuestionCount,
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

// === MVP 學情篩選與 KPI 計算 ===
const activeTierFilter = ref(null) // 'top' | 'stable' | 'warn' | 'risk' | 'unsubmitted' | null

const studentTiers = computed(() => {
  const studentsList = sortedAndFilteredStudents.value
  const top = []
  const stable = []
  const warn = []
  const risk = []
  const unsubmitted = []

  studentsList.forEach(s => {
    // 缺作答獨立統計：有缺題就列入（不覆蓋學力梯隊）
    if (s.missingQuestionCount > 0) {
      unsubmitted.push(s)
    }

    // 學力梯隊只看有至少一次有效作答者
    if (s.totalAttempts <= 0) {
      return
    }
    if (s.accuracy >= 80) {
      top.push(s)
    } else if (s.accuracy >= 60) {
      stable.push(s)
    } else if (s.accuracy >= 40) {
      warn.push(s)
    } else {
      risk.push(s)
    }
  })

  return {
    top,
    stable,
    warn,
    risk,
    unsubmitted
  }
})

const displayedRosterStudents = computed(() => {
  const tiers = studentTiers.value
  if (!activeTierFilter.value) {
    return sortedAndFilteredStudents.value
  }
  return tiers[activeTierFilter.value] || []
})

const classKPIs = computed(() => {
  if (!selectedCategory.value) {
    return { accuracy: 0, avgReactionTime: '0.0', activeCount: 0, totalStudents: 0, pendingGrading: 0 }
  }

  let eligibleCount = 0
  let correctCount = 0
  let reactionTimesSum = 0
  let reactionTimesCount = 0
  let pendingGradingCount = 0

  for (const [userId, myResponses] of allStudentRawResponses.value.entries()) {
    myResponses.forEach(r => {
      if (isResponseEligibleForAccuracy(r)) {
        eligibleCount++
        if (isResponseCountedAsCorrect(r)) {
          correctCount++
        }
      }
      const qType = String(r.question_bank?.question_type || '').toLowerCase()
      if (qType !== 'survey' && qType !== 'short_answer') {
        if (r.reaction_time != null && r.reaction_time > 0) {
          reactionTimesSum += r.reaction_time
          reactionTimesCount++
        }
      }
      if (qType === 'short_answer' && r.status === 'pending') {
        pendingGradingCount++
      }
    })
  }

  const accuracy = eligibleCount > 0 ? Math.round((correctCount / eligibleCount) * 100) : 0
  const avgReactionTime = reactionTimesCount > 0 ? (reactionTimesSum / reactionTimesCount).toFixed(1) : '0.0'
  const totalStudents = students.value.length
  const activeCount = sortedAndFilteredStudents.value.filter(s => s.totalAttempts > 0).length

  return {
    accuracy,
    avgReactionTime,
    activeCount,
    totalStudents,
    pendingGrading: pendingGradingCount
  }
})

function toggleTierFilter(tier) {
  if (activeTierFilter.value === tier) {
    activeTierFilter.value = null
  } else {
    activeTierFilter.value = tier
  }
}

// === 互動功能 ===

function onGroupChange() {
  if (viewMode.value === 'detail' && selectedStudentId.value) {
    fetchStudentData()
  }
}

watch(selectedCategory, () => {
    activeTierFilter.value = null // 重置篩選器
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
    // 略過簡答題與問卷題，只計算選擇題的數據
    if (r.question_bank?.question_type === 'short_answer' || r.question_bank?.question_type === 'survey') return;

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
    <!-- ============================================== -->
    <!-- Option A: Redesigned UI (Academic Workbench) -->
    <!-- ============================================== -->
    <div v-if="uiVariant === 'redesigned'" class="w-full">
      <!-- Title Block -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-5 sm:mb-6">
        <div class="flex items-center gap-2.5">
          <div class="p-2 bg-blue-50 text-blue-600 rounded-lg">
            <Users class="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div>
            <h2 class="text-base sm:text-lg font-bold text-slate-800 tracking-wide font-sans">學生分析學程</h2>
            <p class="text-[10px] sm:text-xs text-slate-400 font-medium">深層探尋每位學員之答題正確率、思維反應與學習軌跡</p>
          </div>
        </div>
        <button 
          v-if="viewMode === 'detail'"
          @click="goBackToList"
          class="w-full sm:w-auto px-4 py-2 border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 rounded-xl transition-smooth flex items-center justify-center gap-2 text-sm sm:text-base font-semibold shadow-sm btn-academic-active touch-target"
        >
          <ArrowLeft class="w-4 h-4" /> 返回花名冊
        </button>
      </div>

      <!-- Class Filter panel -->
      <div class="bg-white p-4 rounded-2xl shadow-academic border border-slate-200/60 mb-5 sm:mb-6 flex flex-col sm:flex-row sm:items-center gap-4">
        <div class="flex items-center gap-2.5">
          <Layers class="w-4.5 h-4.5 text-slate-400 shrink-0" />
          <label class="text-sm font-semibold text-slate-700 whitespace-nowrap">選取班級</label>
        </div>
        <div class="flex-1 w-full max-w-sm">
          <select
            v-model="selectedCategory"
            @change="onGroupChange"
            class="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-smooth bg-white text-slate-700 text-sm font-semibold shadow-sm"
          >
            <option value="" disabled>請選擇班級...</option>
            <option v-for="category in availableClasses" :key="category" :value="category">
              {{ category }}
            </option>
          </select>
        </div>
        <div v-if="viewMode === 'list' && selectedCategory" class="text-xs text-slate-450 font-bold ml-auto hidden sm:block">
          💡 共登錄 {{ sortedAndFilteredStudents.length }} 名班級學員
        </div>
      </div>

      <!-- Empty State -->
      <div v-if="viewMode === 'list' && !selectedCategory" class="bg-white p-12 rounded-2xl shadow-academic border border-slate-200/60 text-center flex flex-col items-center justify-center min-h-[350px] transition-smooth">
        <div class="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-5">
          <Users class="w-8 h-8" />
        </div>
        <h3 class="text-base sm:text-lg font-bold text-slate-800 mb-2">請先選擇欲分析之班級</h3>
        <p class="text-slate-450 text-xs sm:text-sm max-w-xs mx-auto leading-relaxed">
          請點選上方下拉選單以解鎖該班級的所有學生答題數據、反應時長與學習歷程。
        </p>
      </div>

      <!-- Student List View -->
      <div v-else-if="viewMode === 'list' && selectedCategory">
        <div v-if="loadingStudents" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400 animate-fadeIn">
          <Activity class="w-8 h-8 animate-spin mx-auto mb-3 text-blue-600" />
          <p class="font-medium text-sm">正在讀取班級花名冊與成績統計...</p>
        </div>

        <div v-else class="space-y-6">
          <!-- Class-wide KPIs -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-fadeIn">
            <!-- KPI: 班級整體正確率 -->
            <div class="bg-white p-4 rounded-2xl shadow-academic border border-slate-200/60 flex flex-col justify-between min-h-[110px]">
              <span class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Target class="w-3.5 h-3.5 text-blue-500" /> 班級整體正確率
              </span>
              <div class="mt-2 flex items-baseline gap-1">
                <span class="text-2xl font-black text-slate-800 font-mono">{{ classKPIs.accuracy }}</span>
                <span class="text-xs font-semibold text-slate-400">%</span>
              </div>
              <p class="text-[10px] text-slate-450 mt-1">全班有效作答中答對比例</p>
            </div>

            <!-- KPI: 班級平均反應時間 -->
            <div class="bg-white p-4 rounded-2xl shadow-academic border border-slate-200/60 flex flex-col justify-between min-h-[110px]">
              <span class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Clock class="w-3.5 h-3.5 text-amber-500" /> 班級平均反應時間
              </span>
              <div class="mt-2 flex items-baseline gap-1">
                <span class="text-2xl font-black text-slate-800 font-mono">{{ classKPIs.avgReactionTime }}</span>
                <span class="text-xs font-semibold text-slate-400">秒</span>
              </div>
              <p class="text-[10px] text-slate-450 mt-1">排除問卷、簡答與無效秒數</p>
            </div>

            <!-- KPI: 已作答學員數 -->
            <div class="bg-white p-4 rounded-2xl shadow-academic border border-slate-200/60 flex flex-col justify-between min-h-[110px]">
              <span class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Users class="w-3.5 h-3.5 text-emerald-500" /> 已作答學員數
              </span>
              <div class="mt-2 flex items-baseline gap-1">
                <span class="text-2xl font-black text-slate-800 font-mono">{{ classKPIs.activeCount }}</span>
                <span class="text-xs font-semibold text-slate-400">/ {{ classKPIs.totalStudents }} 人</span>
              </div>
              <p class="text-[10px] text-slate-450 mt-1">至少參與過一次有效答題</p>
            </div>

            <!-- KPI: 待批改簡答題數 -->
            <div class="bg-white p-4 rounded-2xl shadow-academic border border-slate-200/60 flex flex-col justify-between min-h-[110px]">
              <span class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <FileText class="w-3.5 h-3.5 text-purple-500" /> 待批改簡答題
              </span>
              <div class="mt-2 flex items-baseline gap-1">
                <span class="text-2xl font-black" :class="classKPIs.pendingGrading > 0 ? 'text-purple-600 animate-pulse' : 'text-slate-800'">{{ classKPIs.pendingGrading }}</span>
                <span class="text-xs font-semibold text-slate-400">題</span>
              </div>
              <p class="text-[10px] text-slate-450 mt-1">需要老師手動進行批改評分</p>
            </div>
          </div>

          <!-- Ability Distribution Funnel -->
          <div class="bg-white p-4 sm:p-5 rounded-2xl shadow-academic border border-slate-200/60 animate-fadeIn">
            <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div>
                <h3 class="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <Activity class="w-4 h-4 text-blue-600" /> 班級學情梯隊分佈漏斗
                </h3>
                <p class="text-[10px] text-slate-400 mt-0.5 font-medium">點擊各梯隊區塊可「一鍵過濾」下方名冊學員</p>
              </div>
              <button
                v-if="activeTierFilter"
                @click="activeTierFilter = null"
                class="text-[10px] sm:text-xs px-2.5 py-1 text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg font-bold transition-colors cursor-pointer"
              >
                顯示全部名冊
              </button>
            </div>

            <!-- 5 Tiers Grid -->
            <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
              <!-- 🏆 頂尖層 -->
              <div
                @click="toggleTierFilter('top')"
                class="p-3 rounded-xl border-2 cursor-pointer transition-all duration-300 select-none flex flex-col justify-between min-h-[90px]"
                :class="[
                  activeTierFilter === 'top'
                    ? 'bg-emerald-50/70 border-emerald-500 ring-2 ring-emerald-500/20 scale-[1.02] shadow-sm'
                    : 'bg-slate-50/30 border-slate-100 hover:border-emerald-200 hover:bg-emerald-50/10'
                ]"
              >
                <div class="text-[10px] font-bold text-emerald-700 flex items-center gap-1">
                  <span>🏆</span> 頂尖層 (>=80%)
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-2xl font-black text-emerald-600 font-mono">{{ studentTiers.top.length }}</span>
                  <span class="text-[10px] font-bold text-slate-400">人</span>
                </div>
                <div class="text-[9px] text-slate-400 font-medium truncate">觀念精通學霸</div>
              </div>

              <!-- 📈 穩定層 -->
              <div
                @click="toggleTierFilter('stable')"
                class="p-3 rounded-xl border-2 cursor-pointer transition-all duration-300 select-none flex flex-col justify-between min-h-[90px]"
                :class="[
                  activeTierFilter === 'stable'
                    ? 'bg-blue-50/70 border-blue-500 ring-2 ring-blue-500/20 scale-[1.02] shadow-sm'
                    : 'bg-slate-50/30 border-slate-100 hover:border-blue-200 hover:bg-blue-50/10'
                ]"
              >
                <div class="text-[10px] font-bold text-blue-700 flex items-center gap-1">
                  <span>📈</span> 穩定層 (60-80%)
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-2xl font-black text-blue-600 font-mono">{{ studentTiers.stable.length }}</span>
                  <span class="text-[10px] font-bold text-slate-400">人</span>
                </div>
                <div class="text-[9px] text-slate-400 font-medium truncate">實力中流砥柱</div>
              </div>

              <!-- ⚠️ 待加強 -->
              <div
                @click="toggleTierFilter('warn')"
                class="p-3 rounded-xl border-2 cursor-pointer transition-all duration-300 select-none flex flex-col justify-between min-h-[90px]"
                :class="[
                  activeTierFilter === 'warn'
                    ? 'bg-amber-50/70 border-amber-500 ring-2 ring-amber-500/20 scale-[1.02] shadow-sm'
                    : 'bg-slate-50/30 border-slate-100 hover:border-amber-200 hover:bg-amber-50/10'
                ]"
              >
                <div class="text-[10px] font-bold text-amber-700 flex items-center gap-1">
                  <span>⚠️</span> 待加強 (40-60%)
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-2xl font-black text-amber-600 font-mono">{{ studentTiers.warn.length }}</span>
                  <span class="text-[10px] font-bold text-slate-400">人</span>
                </div>
                <div class="text-[9px] text-slate-400 font-medium truncate">觀念有些卡關</div>
              </div>

              <!-- 🚨 危機層 -->
              <div
                @click="toggleTierFilter('risk')"
                class="p-3 rounded-xl border-2 cursor-pointer transition-all duration-300 select-none flex flex-col justify-between min-h-[90px]"
                :class="[
                  activeTierFilter === 'risk'
                    ? 'bg-rose-50/70 border-rose-500 ring-2 ring-rose-500/20 scale-[1.02] shadow-sm'
                    : 'bg-slate-50/30 border-slate-100 hover:border-rose-200 hover:bg-rose-50/10'
                ]"
              >
                <div class="text-[10px] font-bold text-rose-700 flex items-center gap-1">
                  <span>🚨</span> 危機層 (&lt;40%)
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-2xl font-black text-rose-600 font-mono">{{ studentTiers.risk.length }}</span>
                  <span class="text-[10px] font-bold text-slate-400">人</span>
                </div>
                <div class="text-[9px] text-slate-400 font-medium truncate">落後需要關注</div>
              </div>

              <!-- 💤 缺作答 -->
              <div
                @click="toggleTierFilter('unsubmitted')"
                class="p-3 rounded-xl border-2 cursor-pointer transition-all duration-300 select-none flex flex-col justify-between min-h-[90px] col-span-2 md:col-span-1"
                :class="[
                  activeTierFilter === 'unsubmitted'
                    ? 'bg-slate-100 border-slate-400 ring-2 ring-slate-400/20 scale-[1.02] shadow-sm'
                    : 'bg-slate-50/30 border-slate-100 hover:border-slate-300 hover:bg-slate-100/30'
                ]"
              >
                <div class="text-[10px] font-bold text-slate-500 flex items-center gap-1">
                  <span>💤</span> 缺作答
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-2xl font-black text-slate-600 font-mono">{{ studentTiers.unsubmitted.length }}</span>
                  <span class="text-[10px] font-bold text-slate-400">人</span>
                </div>
                <div class="text-[9px] text-slate-400 font-medium truncate">仍有應答題目未提交</div>
              </div>
            </div>
          </div>

          <!-- Active Filter Banner -->
          <div v-if="activeTierFilter" class="p-3 bg-blue-50 border border-blue-100 rounded-xl flex items-center justify-between animate-fadeIn text-xs text-blue-700 font-semibold shadow-sm">
            <span class="flex items-center gap-1.5">
              <span>📍</span> 
              <span>
                正在依學情篩選：
                <span class="text-blue-950 font-extrabold underline">
                  {{
                    activeTierFilter === 'top' ? '🏆 頂尖層 (>=80%)' :
                    activeTierFilter === 'stable' ? '📈 穩定層 (60-80%)' :
                    activeTierFilter === 'warn' ? '⚠️ 待加強 (40-60%)' :
                    activeTierFilter === 'risk' ? '🚨 危機層 (<40%)' : '💤 缺作答'
                  }}
                </span>
                （共 {{ displayedRosterStudents.length }} 名學員）
              </span>
            </span>
            <button @click="activeTierFilter = null" class="text-blue-900 font-extrabold hover:underline cursor-pointer">
              清除篩選
            </button>
          </div>

          <!-- Student Roster Main Board -->
          <div class="bg-white rounded-2xl shadow-academic border border-slate-200/60 overflow-hidden">
            <!-- Roster Control Header -->
            <div class="px-5 py-4 border-b border-slate-200/80 bg-slate-50/50 flex justify-between items-center flex-wrap gap-2">
              <h3 class="font-bold text-slate-800 text-sm sm:text-base flex items-center gap-2">
                <BarChart3 class="w-5 h-5 text-blue-600" /> 班級學員表現總表
              </h3>
              <button 
                @click="sortByAccuracyDesc = !sortByAccuracyDesc"
                class="text-xs px-3 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 flex items-center gap-1.5 transition-smooth font-semibold btn-academic-active shadow-sm touch-target"
              >
                依答題準確率排序
                <TrendingUp v-if="!sortByAccuracyDesc" class="w-3.5 h-3.5 text-slate-450"/>
                <TrendingDown v-else class="w-3.5 h-3.5 text-slate-450"/>
              </button>
            </div>

            <!-- RWD Table with Mobile Cardification -->
            <div class="p-4 sm:p-0">
              <!-- Mobile View: Card Stack (lg:hidden) -->
              <div class="lg:hidden space-y-3.5">
                <div 
                  v-for="student in displayedRosterStudents" 
                  :key="student.user_id"
                  @click="handleStudentClick(student)"
                  class="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm hover:border-blue-200 transition-smooth btn-academic-active touch-target flex flex-col gap-3"
                >
                  <div class="flex justify-between items-center">
                    <div class="flex items-center gap-3">
                      <!-- SVG Donut Gauge as Avatar with numerical contrast percentage -->
                      <div class="relative w-11 h-11 flex items-center justify-center shrink-0">
                        <svg class="w-full h-full transform -rotate-90">
                          <circle cx="22" cy="22" r="18" stroke="#f1f5f9" stroke-width="3" fill="transparent" />
                          <circle
                            cx="22"
                            cy="22"
                            r="18"
                            :stroke="
                              student.totalAttempts === 0 ? '#cbd5e1' :
                              student.accuracy >= 80 ? '#10b981' :
                              student.accuracy >= 60 ? '#f59e0b' : '#f43f5e'
                            "
                            stroke-width="3.5"
                            fill="transparent"
                            stroke-linecap="round"
                            stroke-dasharray="113"
                            :stroke-dashoffset="113 - (113 * (student.totalAttempts > 0 ? student.accuracy : 0)) / 100"
                            class="transition-all duration-500 ease-out"
                          />
                        </svg>
                        <div class="absolute flex flex-col items-center justify-center text-[10px] font-black font-mono" :class="
                          student.totalAttempts === 0 ? 'text-slate-400' :
                          student.accuracy >= 80 ? 'text-emerald-600' :
                          student.accuracy >= 60 ? 'text-amber-600' : 'text-rose-600'
                        ">
                          {{ student.totalAttempts > 0 ? Math.round(student.accuracy) : '-' }}
                          <span v-if="student.totalAttempts > 0" class="text-[7px] font-bold -mt-0.5">%</span>
                        </div>
                      </div>
                      <div>
                        <div class="font-bold text-slate-800 text-sm">{{ student.display_name }}</div>
                        <div class="text-[10px] text-slate-400 font-mono font-medium mt-0.5">{{ student.student_id || '無學號' }}</div>
                      </div>
                    </div>
                    <ChevronRight class="w-5 h-5 text-slate-400" />
                  </div>
                  
                  <div class="grid grid-cols-2 gap-2 pt-2.5 border-t border-slate-100 text-xs">
                    <div>
                      <span class="text-slate-400 block mb-0.5">答題數</span>
                      <span class="font-semibold text-slate-700 bg-slate-50 px-2 py-0.5 rounded border border-slate-200/50">{{ student.totalAttempts }} 題</span>
                    </div>
                    <div>
                      <span class="text-slate-400 block mb-0.5">平均正確率</span>
                      <span 
                        class="px-2 py-0.5 rounded font-bold"
                        :class="[
                          student.accuracy >= 80 ? 'bg-emerald-50 text-emerald-700 border border-emerald-150' : 
                          student.accuracy >= 60 ? 'bg-amber-50 text-amber-700 border border-amber-150' : 
                          student.totalAttempts === 0 ? 'bg-slate-50 text-slate-450' : 'bg-rose-50 text-rose-700 border border-rose-150'
                        ]"
                      >
                        {{ student.totalAttempts > 0 ? Math.round(student.accuracy) + '%' : '未作答' }}
                      </span>
                    </div>
                  </div>

                  <div class="text-[10px] text-slate-400 pt-2 border-t border-dashed border-slate-100 flex items-center gap-1 font-medium">
                    <Clock class="w-3.5 h-3.5" />
                    <span>最後活動：{{ student.lastActive ? new Date(student.lastActive).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '無紀錄' }}</span>
                  </div>
                </div>
                
                <div v-if="displayedRosterStudents.length === 0" class="text-center py-12 text-slate-400 text-sm font-medium bg-white rounded-xl">
                  ⚠️ 該學情梯隊下尚無學員資料。
                </div>
              </div>

              <!-- Desktop View: Grid Table (hidden lg:table) -->
              <table class="w-full text-left border-collapse lg:table hidden">
                <thead>
                  <tr class="bg-slate-50 text-slate-500 text-xs border-b border-slate-200">
                    <th class="p-4 font-bold tracking-wide uppercase">姓名 / 學號</th>
                    <th class="p-4 font-bold tracking-wide uppercase w-32 border-l border-slate-100 text-center">該班答題數</th>
                    <th class="p-4 font-bold tracking-wide uppercase w-40 border-l border-slate-100 text-center">該班準確率</th>
                    <th class="p-4 font-bold tracking-wide uppercase w-48 border-l border-slate-100">最後活動時間</th>
                    <th class="p-4 w-24"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  <tr 
                    v-for="student in displayedRosterStudents" 
                    :key="student.user_id" 
                    class="bg-white hover:bg-blue-50/30 cursor-pointer transition-colors group"
                    @click="handleStudentClick(student)"
                  >
                    <td class="p-4">
                      <div class="flex items-center gap-3">
                        <!-- SVG Donut Gauge as Avatar with numerical contrast percentage -->
                        <div class="relative w-11 h-11 flex items-center justify-center shrink-0">
                          <svg class="w-full h-full transform -rotate-90">
                            <circle cx="22" cy="22" r="18" stroke="#f1f5f9" stroke-width="3" fill="transparent" />
                            <circle
                              cx="22"
                              cy="22"
                              r="18"
                              :stroke="
                                student.totalAttempts === 0 ? '#cbd5e1' :
                                student.accuracy >= 80 ? '#10b981' :
                                student.accuracy >= 60 ? '#f59e0b' : '#f43f5e'
                              "
                              stroke-width="3.5"
                              fill="transparent"
                              stroke-linecap="round"
                              stroke-dasharray="113"
                              :stroke-dashoffset="113 - (113 * (student.totalAttempts > 0 ? student.accuracy : 0)) / 100"
                              class="transition-all duration-500 ease-out"
                            />
                          </svg>
                          <div class="absolute flex flex-col items-center justify-center text-[10px] font-black font-mono" :class="
                            student.totalAttempts === 0 ? 'text-slate-400' :
                            student.accuracy >= 80 ? 'text-emerald-600' :
                            student.accuracy >= 60 ? 'text-amber-600' : 'text-rose-600'
                          ">
                            {{ student.totalAttempts > 0 ? Math.round(student.accuracy) : '-' }}
                            <span v-if="student.totalAttempts > 0" class="text-[7px] font-bold -mt-0.5">%</span>
                          </div>
                        </div>
                        <div>
                          <div class="font-bold text-slate-800 text-sm group-hover:text-blue-600 transition-colors">{{ student.display_name }}</div>
                          <div class="text-xs text-slate-400 font-mono font-medium mt-0.5">{{ student.student_id ? student.student_id : '無學號' }}</div>
                        </div>
                      </div>
                    </td>
                    <td class="p-4 text-center border-l border-slate-50 text-sm">
                      <span class="inline-block bg-slate-50 text-slate-700 px-2.5 py-1 rounded-lg border border-slate-200/60 font-semibold text-xs">
                        {{ student.totalAttempts }} 題
                      </span>
                    </td>
                    <td class="p-4 text-center border-l border-slate-50 text-sm">
                      <span 
                        class="inline-block px-2.5 py-1 rounded-lg font-bold text-xs"
                        :class="[
                          student.accuracy >= 80 ? 'bg-emerald-50 text-emerald-700 border border-emerald-150' : 
                          student.accuracy >= 60 ? 'bg-amber-50 text-amber-700 border border-amber-150' : 
                          student.totalAttempts === 0 ? 'bg-slate-50 text-slate-450' : 'bg-rose-50 text-rose-700 border border-rose-150'
                        ]"
                      >
                        {{ student.totalAttempts > 0 ? Math.round(student.accuracy) + '%' : '未作答' }}
                      </span>
                    </td>
                    <td class="p-4 text-slate-500 text-xs font-medium border-l border-slate-50 font-mono">
                      {{ student.lastActive ? new Date(student.lastActive).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '無紀錄' }}
                    </td>
                    <td class="p-4 text-right">
                      <ChevronRight class="w-5 h-5 text-slate-400 group-hover:text-blue-500 transition-smooth transform group-hover:translate-x-1 ml-auto" />
                    </td>
                  </tr>
                  <tr v-if="displayedRosterStudents.length === 0">
                    <td colspan="5" class="p-8 text-center text-slate-450 text-sm font-medium">
                      ⚠️ 該學情梯隊下尚無學員資料。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Student Detail/Report View -->
      <div v-else-if="viewMode === 'detail'">
        <!-- Profile summary card -->
        <div v-if="selectedStudent" class="bg-gradient-to-r from-blue-50/50 via-slate-50/30 to-white p-5 sm:p-6 rounded-2xl border border-blue-100 mb-6 flex items-center gap-4 sm:gap-5 shadow-sm">
          <div class="w-12 h-12 sm:w-14 sm:h-14 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center shrink-0 border border-blue-200/60 shadow-sm">
            <User class="w-6 h-6 sm:w-7 sm:h-7" />
          </div>
          <div class="min-w-0">
            <h3 class="text-lg sm:text-xl font-bold text-slate-800 leading-tight">
              {{ selectedStudent.display_name || '未知學生' }}
            </h3>
            <div class="text-blue-600 mt-1 flex items-center gap-2">
              <span class="text-[10px] sm:text-xs font-bold border border-blue-200 px-2 py-0.5 rounded-lg bg-white">
                 學籍編號: {{ selectedStudent.student_id ? selectedStudent.student_id : '無學號' }}
              </span>
            </div>
          </div>
        </div>

        <div v-if="loadingResponses" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
          <Activity class="w-8 h-8 animate-spin mx-auto mb-3 text-blue-600" />
          <p class="font-medium text-sm">正在深度分析學生報告與學歷存根...</p>
        </div>

        <div v-else-if="studentResponses.length === 0" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
          <FileText class="w-12 h-12 text-slate-350 mx-auto mb-4" />
          <p class="font-bold text-slate-800">該學員在此班級無任何答題紀錄</p>
        </div>

        <div v-else class="space-y-6">
          <!-- KPI Grid -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div class="bg-white p-4 sm:p-5 rounded-2xl shadow-academic border border-slate-200/60">
              <div class="text-slate-400 text-[10px] sm:text-xs font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Layers class="w-3.5 h-3.5 text-slate-400" /> 
                累積答題數
              </div>
              <div class="text-xl sm:text-2xl font-black text-slate-800 font-sans">{{ detailTotalAttempted }} <span class="text-xs sm:text-sm font-semibold text-slate-400">題</span></div>
            </div>

            <div class="bg-white p-4 sm:p-5 rounded-2xl shadow-academic border border-slate-200/60">
              <div class="text-slate-400 text-[10px] sm:text-xs font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Target class="w-3.5 h-3.5 text-slate-400" /> 平均正確率
              </div>
              <div class="text-xl sm:text-2xl font-black font-sans" :class="detailOverallAccuracy >= 60 ? 'text-emerald-600' : 'text-rose-600'">
                {{ detailOverallAccuracy }}%
              </div>
            </div>

            <div class="bg-white p-4 sm:p-5 rounded-2xl shadow-academic border border-slate-200/60">
              <div class="text-slate-400 text-[10px] sm:text-xs font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Zap class="w-3.5 h-3.5 text-yellow-500" /> 答題反應速度
              </div>
              <div class="text-xl sm:text-2xl font-black text-slate-800 font-sans">
                {{ averageReactionTime }}
              </div>
            </div>

            <div class="bg-white p-4 sm:p-5 rounded-2xl shadow-academic border border-slate-200/60 col-span-2 lg:col-span-1">
              <div class="text-slate-400 text-[10px] sm:text-xs font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Clock class="w-3.5 h-3.5 text-slate-400" /> 最近活動
              </div>
              <div class="text-xs sm:text-sm font-semibold text-slate-700 truncate">
                {{ detailLastActive || '尚未有活動紀錄' }}
              </div>
            </div>
          </div>

          <!-- Subject progression list -->
          <div class="bg-white p-5 rounded-2xl shadow-academic border border-slate-200/60">
            <h3 class="text-sm sm:text-base font-bold text-slate-800 mb-4 flex items-center gap-2 border-b border-slate-100 pb-3">
              <BarChart3 class="w-4 h-4 text-blue-600" /> 科目知識點正確率分佈
            </h3>
            <div class="space-y-4">
              <div v-for="cat in categoryStats" :key="cat.category" class="pt-1">
                <div class="flex justify-between items-end mb-1.5">
                  <div class="text-xs sm:text-sm font-bold text-slate-700">
                    {{ cat.category }}
                    <span v-if="cat.accuracy < 50" class="ml-2 text-[10px] bg-rose-50 text-rose-600 px-2 py-0.5 rounded-lg border border-rose-100 font-bold">
                      需加強
                    </span>
                  </div>
                  <div class="text-xs text-slate-400 font-mono font-bold">
                    {{ cat.accuracy }}% 
                    <span class="text-[10px] font-normal text-slate-400">({{ cat.correct }}/{{ cat.total }})</span>
                  </div>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-2">
                  <div class="h-2 rounded-full transition-all duration-500"
                    :class="
                      cat.accuracy >= 80 ? 'bg-emerald-500 shadow-sm shadow-emerald-500/10' : 
                      cat.accuracy >= 60 ? 'bg-amber-500 shadow-sm shadow-amber-500/10' : 
                      cat.accuracy >= 50 ? 'bg-orange-400 shadow-sm shadow-orange-400/10' : 'bg-rose-500 shadow-sm shadow-rose-500/10'
                    "
                    :style="{ width: cat.accuracy + '%' }"
                  ></div>
                </div>
              </div>
            </div>
          </div>

          <!-- History Feed list -->
          <div class="bg-white rounded-2xl shadow-academic border border-slate-200/60 overflow-hidden">
            <div class="p-5 border-b border-slate-200/80 bg-slate-50/50">
              <h3 class="text-sm sm:text-base font-bold text-slate-800 flex items-center gap-2">
                <Activity class="w-5 h-5 text-blue-600" />
                學員答題歷史存根
              </h3>
            </div>
            
            <div class="p-4 sm:p-0">
              <!-- Mobile view Card list (lg:hidden) -->
              <div class="lg:hidden space-y-4">
                <div 
                  v-for="res in studentResponses" 
                  :key="res.id"
                  class="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm flex flex-col gap-3"
                >
                  <div class="flex justify-between items-center">
                    <span class="text-[10px] text-slate-400 font-mono font-bold flex items-center gap-1">
                      <Clock class="w-3.5 h-3.5" />
                      {{ new Date(res.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) }}
                    </span>
                    
                    <!-- Grading state badges -->
                    <div>
                      <template v-if="res.question_bank?.question_type === 'short_answer'">
                        <span v-if="res.status === 'pending'" class="inline-flex items-center gap-1 text-slate-550 bg-slate-100 px-2 py-0.5 rounded-lg text-[10px] font-bold border border-slate-200">
                          ⏳ 待批改
                        </span>
                        <span v-else class="inline-flex items-center gap-1 text-blue-700 bg-blue-50 px-2 py-0.5 rounded-lg text-[10px] font-bold border border-blue-150">
                          {{ res.score }} 分
                        </span>
                      </template>
                      <template v-else-if="res.question_bank?.question_type === 'survey'">
                        <span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-lg text-[10px] font-bold border border-emerald-150">
                          問卷
                        </span>
                      </template>
                      <template v-else>
                        <span v-if="res.is_correct" class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-lg text-[10px] font-bold border border-emerald-150">
                          <CheckCircle2 class="w-3 h-3" /> 答對
                        </span>
                        <span v-else class="inline-flex items-center gap-1 text-rose-700 bg-rose-50 px-2 py-0.5 rounded-lg text-[10px] font-bold border border-rose-150">
                          <XCircle class="w-3 h-3" /> 答錯
                        </span>
                      </template>
                    </div>
                  </div>

                  <div>
                    <span class="text-[9px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md mb-1.5 inline-block" v-if="res.question_bank?.category">
                      {{ res.question_bank.category }}
                    </span>
                    <p class="text-xs font-semibold text-slate-700 leading-relaxed">{{ res.question_bank?.content || '（該題目已被刪除）' }}</p>
                  </div>

                  <div class="pt-3 border-t border-slate-100 flex flex-col gap-2">
                    <div class="text-xs">
                      <span class="text-slate-400 mr-2">學員回答</span>
                      <template v-if="res.question_bank?.question_type === 'short_answer' || res.question_bank?.question_type === 'survey'">
                        <p class="mt-1 bg-slate-50 p-2.5 rounded-xl border border-slate-200/50 text-slate-700 text-xs leading-relaxed break-words whitespace-pre-wrap">{{ res.answer_text || '（未作答）' }}</p>
                      </template>
                      <template v-else>
                        <span class="font-bold text-slate-800 font-mono">{{ res.selected_option }}</span>
                      </template>
                    </div>

                    <!-- AI Feedback in popup details bubble -->
                    <div v-if="res.question_bank?.question_type === 'short_answer' && res.ai_feedback" class="bg-purple-50/50 border border-purple-100 rounded-xl p-3">
                      <p class="text-[10px] font-bold text-purple-600 mb-1 flex items-center gap-1">🤖 AI 批改與引導</p>
                      <p class="text-xs text-purple-800 leading-relaxed whitespace-pre-wrap">{{ res.ai_feedback }}</p>
                    </div>
                    
                    <div class="text-[10px] text-slate-400 font-mono font-medium flex justify-between items-center mt-1">
                      <span>反應耗時: {{ res.reaction_time ? res.reaction_time + ' 秒' : '-' }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Desktop view Grid (hidden lg:table) -->
              <table class="w-full text-left border-collapse lg:table hidden">
                <thead>
                  <tr class="bg-slate-50 text-slate-500 text-xs border-b border-slate-200">
                    <th class="p-4 font-bold tracking-wide uppercase w-32">時間</th>
                    <th class="p-4 font-bold tracking-wide uppercase w-5/12">題目</th>
                    <th class="p-4 font-bold tracking-wide uppercase">該生回答</th>
                    <th class="p-4 font-bold tracking-wide uppercase w-24 text-center">結果</th>
                    <th class="p-4 font-bold tracking-wide uppercase w-24 text-center">秒數</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 text-sm">
                  <tr 
                    v-for="res in studentResponses" 
                    :key="res.id" 
                    class="bg-white hover:bg-slate-50/50 transition-colors"
                  >
                    <td class="p-4 text-slate-500 text-xs font-mono">
                      {{ new Date(res.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) }}
                    </td>
                    
                    <td class="p-4 text-slate-800">
                      <div class="line-clamp-2 text-sm font-semibold">
                        {{ res.question_bank?.content || '（題目已遭刪除）' }}
                      </div>
                      <div class="text-[10px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md mt-1.5 inline-block font-bold" v-if="res.question_bank?.category">
                        {{ res.question_bank.category }}
                      </div>
                    </td>
                    
                    <td class="p-4 text-slate-700 font-medium text-xs md:text-sm border-l border-slate-50">
                      <!-- 簡答題 -->
                      <template v-if="res.question_bank?.question_type === 'short_answer' || res.question_bank?.question_type === 'survey'">
                        <div
                          v-if="res.answer_text"
                          class="line-clamp-2 hover:line-clamp-none transition-all cursor-pointer text-xs font-semibold"
                          :title="res.answer_text"
                        >
                          {{ res.answer_text }}
                        </div>
                        <span v-else class="text-slate-400 text-xs">（未作答）</span>
                        
                        <!-- AI Feedback -->
                        <div v-if="res.question_bank?.question_type === 'short_answer' && res.ai_feedback" class="mt-2 bg-purple-50/50 border border-purple-100 rounded-xl p-2.5">
                          <p class="text-[9px] font-bold text-purple-600 mb-0.5">🤖 AI 評語</p>
                          <p class="text-xs text-purple-800 leading-relaxed whitespace-pre-wrap line-clamp-3 hover:line-clamp-none cursor-pointer">{{ res.ai_feedback }}</p>
                        </div>
                      </template>
                      <!-- 選擇題 -->
                      <template v-else>
                        <span class="font-mono bg-slate-50 px-2.5 py-1 rounded border border-slate-200/50 font-bold text-slate-800">{{ res.selected_option }}</span>
                      </template>
                    </td>
                    
                    <td class="p-4 text-center border-l border-slate-50">
                      <template v-if="res.question_bank?.question_type === 'short_answer'">
                        <span v-if="res.status === 'pending'" class="inline-flex items-center gap-1 text-slate-500 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg text-xs font-bold">
                          ⏳ 待批改
                        </span>
                        <span v-else class="inline-flex items-center gap-1 text-blue-700 bg-blue-50 border border-blue-150 px-2.5 py-1 rounded-lg text-xs font-bold">
                          {{ res.score }} 分
                        </span>
                      </template>
                      <template v-else-if="res.question_bank?.question_type === 'survey'">
                        <span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 border border-emerald-150 px-2.5 py-1 rounded-lg text-xs font-bold">
                          問卷
                        </span>
                      </template>
                      <template v-else>
                        <span v-if="res.is_correct" class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 border border-emerald-150 px-2.5 py-1 rounded-lg text-xs font-bold">
                          <CheckCircle2 class="w-3.5 h-3.5" /> 對
                        </span>
                        <span v-else class="inline-flex items-center gap-1 text-rose-700 bg-rose-50 border border-rose-150 px-2.5 py-1 rounded-lg text-xs font-bold">
                          <XCircle class="w-3.5 h-3.5" /> 錯
                        </span>
                      </template>
                    </td>
                    
                    <td class="p-4 text-center text-slate-500 font-mono text-xs border-l border-slate-50">
                      {{ res.reaction_time ? res.reaction_time + 's' : '-' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================== -->
    <!-- Option B: Classic UI (Original Design)          -->
    <!-- ============================================== -->
    <div v-else class="w-full">
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
        <div class="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mb-4">
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

        <div v-else class="space-y-6">
          <!-- Class-wide KPIs (Classic Style) -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <!-- KPI: 班級整體正確率 -->
            <div class="bg-white p-4 rounded-lg shadow-sm border border-gray-200 flex flex-col justify-between min-h-[110px]">
              <span class="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                <Target class="w-4 h-4 text-green-600" /> 班級整體正確率
              </span>
              <div class="mt-2 flex items-baseline gap-1">
                <span class="text-2xl font-bold text-gray-800 font-mono">{{ classKPIs.accuracy }}</span>
                <span class="text-xs font-medium text-gray-500">%</span>
              </div>
              <p class="text-[10px] text-gray-500 mt-1">全班有效作答中答對比例</p>
            </div>

            <!-- KPI: 班級平均反應時間 -->
            <div class="bg-white p-4 rounded-lg shadow-sm border border-gray-200 flex flex-col justify-between min-h-[110px]">
              <span class="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                <Clock class="w-4 h-4 text-yellow-600" /> 班級平均反應時間
              </span>
              <div class="mt-2 flex items-baseline gap-1">
                <span class="text-2xl font-bold text-gray-800 font-mono">{{ classKPIs.avgReactionTime }}</span>
                <span class="text-xs font-medium text-gray-500">秒</span>
              </div>
              <p class="text-[10px] text-gray-500 mt-1">排除問卷、簡答與無效秒數</p>
            </div>

            <!-- KPI: 已作答學員數 -->
            <div class="bg-white p-4 rounded-lg shadow-sm border border-gray-200 flex flex-col justify-between min-h-[110px]">
              <span class="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                <Users class="w-4 h-4 text-blue-600" /> 已作答學員數
              </span>
              <div class="mt-2 flex items-baseline gap-1">
                <span class="text-2xl font-bold text-gray-800 font-mono">{{ classKPIs.activeCount }}</span>
                <span class="text-xs font-medium text-gray-500">/ {{ classKPIs.totalStudents }} 人</span>
              </div>
              <p class="text-[10px] text-gray-500 mt-1">至少參與過一次有效答題</p>
            </div>

            <!-- KPI: 待批改簡答題數 -->
            <div class="bg-white p-4 rounded-lg shadow-sm border border-gray-200 flex flex-col justify-between min-h-[110px]">
              <span class="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                <FileText class="w-4 h-4 text-purple-600" /> 待批改簡答題
              </span>
              <div class="mt-2 flex items-baseline gap-1">
                <span class="text-2xl font-bold text-gray-800 font-mono" :class="classKPIs.pendingGrading > 0 ? 'text-purple-600' : 'text-gray-800'">{{ classKPIs.pendingGrading }}</span>
                <span class="text-xs font-medium text-gray-500">題</span>
              </div>
              <p class="text-[10px] text-gray-500 mt-1">需要老師手動進行批改評分</p>
            </div>
          </div>

          <!-- Ability Distribution Funnel (Classic Style) -->
          <div class="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
            <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div>
                <h3 class="text-sm font-bold text-gray-800 flex items-center gap-2">
                  <Activity class="w-4 h-4 text-green-600" /> 班級學情梯隊分佈
                </h3>
                <p class="text-[10px] text-gray-500 mt-0.5">點擊各梯隊區塊可「一鍵過濾」下方名冊學員</p>
              </div>
              <button
                v-if="activeTierFilter"
                @click="activeTierFilter = null"
                class="text-xs px-2.5 py-1 text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded font-semibold transition-colors cursor-pointer"
              >
                顯示全部名冊
              </button>
            </div>

            <!-- 5 Tiers Grid -->
            <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
              <!-- 🏆 頂尖層 -->
              <div
                @click="toggleTierFilter('top')"
                class="p-3 rounded border-2 cursor-pointer transition-all duration-200 select-none flex flex-col justify-between min-h-[85px]"
                :class="[
                  activeTierFilter === 'top'
                    ? 'bg-green-50 border-green-500 ring-2 ring-green-500/10'
                    : 'bg-gray-50/50 border-gray-100 hover:border-green-300 hover:bg-green-50/10'
                ]"
              >
                <div class="text-[10px] font-bold text-green-700">
                  🏆 頂尖層 (>=80%)
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-xl font-bold text-green-600 font-mono">{{ studentTiers.top.length }}</span>
                  <span class="text-[10px] font-medium text-gray-400">人</span>
                </div>
              </div>

              <!-- 📈 穩定層 -->
              <div
                @click="toggleTierFilter('stable')"
                class="p-3 rounded border-2 cursor-pointer transition-all duration-200 select-none flex flex-col justify-between min-h-[85px]"
                :class="[
                  activeTierFilter === 'stable'
                    ? 'bg-blue-50 border-blue-500 ring-2 ring-blue-500/10'
                    : 'bg-gray-50/50 border-gray-100 hover:border-blue-300 hover:bg-blue-50/10'
                ]"
              >
                <div class="text-[10px] font-bold text-blue-700">
                  📈 穩定層 (60-80%)
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-xl font-bold text-blue-600 font-mono">{{ studentTiers.stable.length }}</span>
                  <span class="text-[10px] font-medium text-gray-400">人</span>
                </div>
              </div>

              <!-- ⚠️ 待加強 -->
              <div
                @click="toggleTierFilter('warn')"
                class="p-3 rounded border-2 cursor-pointer transition-all duration-200 select-none flex flex-col justify-between min-h-[85px]"
                :class="[
                  activeTierFilter === 'warn'
                    ? 'bg-yellow-50 border-yellow-500 ring-2 ring-yellow-500/10'
                    : 'bg-gray-50/50 border-gray-100 hover:border-yellow-300 hover:bg-yellow-50/10'
                ]"
              >
                <div class="text-[10px] font-bold text-yellow-700">
                  ⚠️ 待加強 (40-60%)
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-xl font-bold text-yellow-600 font-mono">{{ studentTiers.warn.length }}</span>
                  <span class="text-[10px] font-medium text-gray-400">人</span>
                </div>
              </div>

              <!-- 🚨 危機層 -->
              <div
                @click="toggleTierFilter('risk')"
                class="p-3 rounded border-2 cursor-pointer transition-all duration-200 select-none flex flex-col justify-between min-h-[85px]"
                :class="[
                  activeTierFilter === 'risk'
                    ? 'bg-red-50 border-red-500 ring-2 ring-red-500/10'
                    : 'bg-gray-50/50 border-gray-100 hover:border-red-300 hover:bg-red-50/10'
                ]"
              >
                <div class="text-[10px] font-bold text-red-700">
                  🚨 危機層 (&lt;40%)
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-xl font-bold text-red-600 font-mono">{{ studentTiers.risk.length }}</span>
                  <span class="text-[10px] font-medium text-gray-400">人</span>
                </div>
              </div>

              <!-- 💤 缺作答 -->
              <div
                @click="toggleTierFilter('unsubmitted')"
                class="p-3 rounded border-2 cursor-pointer transition-all duration-200 select-none flex flex-col justify-between min-h-[85px] col-span-2 md:col-span-1"
                :class="[
                  activeTierFilter === 'unsubmitted'
                    ? 'bg-gray-150 border-gray-400 ring-2 ring-gray-400/10'
                    : 'bg-gray-50/50 border-gray-100 hover:border-gray-300 hover:bg-gray-150/20'
                ]"
              >
                <div class="text-[10px] font-bold text-gray-500">
                  💤 缺作答
                </div>
                <div class="flex items-baseline gap-1 mt-2">
                  <span class="text-xl font-bold text-gray-600 font-mono">{{ studentTiers.unsubmitted.length }}</span>
                  <span class="text-[10px] font-medium text-gray-400">人</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Active Filter Banner (Classic Style) -->
          <div v-if="activeTierFilter" class="p-3 bg-green-50 border border-green-100 rounded flex items-center justify-between text-xs text-green-700 font-semibold">
            <span>
              📍 正在顯示：
              <span class="font-bold underline text-green-900">
                {{
                  activeTierFilter === 'top' ? '🏆 頂尖層 (>=80%)' :
                  activeTierFilter === 'stable' ? '📈 穩定層 (60-80%)' :
                  activeTierFilter === 'warn' ? '⚠️ 待加強 (40-60%)' :
                  activeTierFilter === 'risk' ? '🚨 危機層 (<40%)' : '💤 缺作答'
                }}
              </span>
              （共 {{ displayedRosterStudents.length }} 名學員）
            </span>
            <button @click="activeTierFilter = null" class="text-green-900 font-bold hover:underline cursor-pointer">
              清除篩選
            </button>
          </div>

          <!-- Student Roster Main Board (Classic Style) -->
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div class="p-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
              <h3 class="font-bold text-gray-800 flex items-center gap-2">
                <BarChart3 class="w-5 h-5 text-green-600" /> 面板花名冊 (Student Roster)
              </h3>
              <button 
                @click="sortByAccuracyDesc = !sortByAccuracyDesc"
                class="text-sm px-3 py-1.5 bg-white border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-1 transition-colors font-medium text-gray-700 shadow-sm"
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
                    <th class="p-4 font-semibold w-32 border-l border-gray-100 text-center">該班答題數</th>
                    <th class="p-4 font-semibold w-40 border-l border-gray-100 text-center">該班準確率</th>
                    <th class="p-4 font-semibold w-48 border-l border-gray-100">最後活動時間</th>
                    <th class="p-4 font-semibold w-24"></th>
                  </tr>
                </thead>
                <tbody class="block md:table-row-group divide-y md:divide-y-0 divide-gray-100">
                  <tr 
                    v-for="student in displayedRosterStudents" 
                    :key="student.user_id" 
                    class="block md:table-row bg-white hover:bg-blue-50/50 cursor-pointer transition-colors group mb-3 md:mb-0 rounded-lg shadow-sm md:shadow-none border md:border-b border-gray-200 md:border-gray-100"
                    @click="handleStudentClick(student)"
                  >
                    <!-- 卡片頂部：姓名等 -->
                    <td class="block md:table-cell p-3 md:p-4 border-b md:border-none border-gray-100">
                      <div class="flex justify-between items-center md:flex md:items-center gap-3">
                        <div class="flex items-center gap-3">
                          <!-- Standalone SVG Donut Gauge -->
                          <div class="relative w-11 h-11 flex items-center justify-center shrink-0">
                            <svg class="w-full h-full transform -rotate-90">
                              <circle cx="22" cy="22" r="18" stroke="#f3f4f6" stroke-width="3" fill="transparent" />
                              <circle
                                cx="22"
                                cy="22"
                                r="18"
                                :stroke="
                                  student.totalAttempts === 0 ? '#cbd5e1' :
                                  student.accuracy >= 80 ? '#22c55e' :
                                  student.accuracy >= 60 ? '#eab308' : '#ef4444'
                                "
                                stroke-width="3.5"
                                fill="transparent"
                                stroke-linecap="round"
                                stroke-dasharray="113"
                                :stroke-dashoffset="113 - (113 * (student.totalAttempts > 0 ? student.accuracy : 0)) / 100"
                                class="transition-all duration-500 ease-out"
                              />
                            </svg>
                            <div class="absolute flex flex-col items-center justify-center text-[10px] font-black font-mono" :class="
                              student.totalAttempts === 0 ? 'text-gray-400' :
                              student.accuracy >= 80 ? 'text-green-600' :
                              student.accuracy >= 60 ? 'text-yellow-600' : 'text-red-600'
                            ">
                              {{ student.totalAttempts > 0 ? Math.round(student.accuracy) : '-' }}
                              <span v-if="student.totalAttempts > 0" class="text-[7px] font-bold -mt-0.5">%</span>
                            </div>
                          </div>
                          <div>
                            <div class="font-medium text-gray-800 text-base md:text-sm">{{ student.display_name }}</div>
                            <div class="text-xs text-gray-500 mt-0.5">{{ student.student_id ? student.student_id : '無學號' }}</div>
                          </div>
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
                        <span class="md:hidden text-gray-500 text-xs">該班準確度</span>
                        <span 
                          :class="[
                            'inline-block px-2 py-1 rounded font-bold text-xs md:text-sm',
                            student.accuracy >= 80 ? 'bg-green-100 text-green-700' : 
                            student.accuracy >= 60 ? 'bg-yellow-100 text-yellow-700' : 
                            student.totalAttempts === 0 ? 'bg-gray-100 text-gray-500' : 'bg-red-100 text-red-700'
                          ]"
                        >
                          {{ student.totalAttempts > 0 ? Math.round(student.accuracy) + '%' : '未作答' }}
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
                  <tr v-if="displayedRosterStudents.length === 0">
                    <td colspan="5" class="p-8 text-center text-gray-500">
                      ⚠️ 該學情梯隊下尚無學員資料。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="viewMode === 'detail'">
        
        <!-- User Details Header -->
        <div class="bg-indigo-50/50 p-4 sm:p-6 rounded-xl border border-indigo-100 mb-6 flex items-center gap-3 sm:gap-5 flex-wrap sm:flex-nowrap">
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

        <div class="space-y-8">
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
                              {{ res.score }} 分
                            </span>
                          </template>
                          <template v-else-if="res.question_bank?.question_type === 'survey'">
                            <span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded text-[10px] font-bold">
                              問卷
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
                      <template v-if="res.question_bank?.question_type === 'short_answer' || res.question_bank?.question_type === 'survey'">
                        <div class="md:hidden text-gray-500 text-xs mb-1">學生回答</div>
                        <div
                          v-if="res.answer_text"
                          class="line-clamp-2 hover:line-clamp-none transition-all cursor-pointer text-sm"
                          :title="res.answer_text"
                        >
                          {{ res.answer_text }}
                        </div>
                        <span v-else class="text-gray-400 text-xs">（未作答）</span>
                        <!-- AI 評語（僅簡答題） -->
                        <div v-if="res.question_bank?.question_type === 'short_answer' && res.ai_feedback" class="mt-2 bg-purple-50 border border-purple-100 rounded-lg p-2.5">
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
                          {{ res.score }} 分
                        </span>
                      </template>
                      <template v-else-if="res.question_bank?.question_type === 'survey'">
                        <span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-100 px-2 py-1 rounded text-xs font-bold">
                          問卷
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
  </div>
</template>

<style scoped>
/* Custom transitions for premium feel */
.animate-fadeIn {
  animation: fadeIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
