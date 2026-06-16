<script setup>
import { ref, computed, onMounted, inject } from 'vue'
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
  RefreshCw,
  Clock,
  PieChart,
  HelpCircle,
  Award,
  BookOpen,
  Eye,
  EyeOff
} from 'lucide-vue-next'

const uiVariant = inject('uiVariant', ref('classic'))

const responses = ref([])
const loading = ref(false)
const searchQuery = ref('')
const sortBy = ref('latest')
const selectedGroup = ref('all')
const expandedQuestions = ref(new Set())
const showGlobalDashboard = ref(true) // 控制全局統計儀表板的收合
const showStudentDetails = ref(true) // 控制學生作答詳情的顯示與隱藏

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
        selected_option,
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
      // 排除簡答題 (short_answer) 與問卷題 (survey)，只針對選擇題與搶答挑戰進行試題統計分析
      responses.value = (data || []).filter(r => {
        const qType = normalizeQuestionType(r.question_bank?.question_type)
        return qType !== 'short_answer' && qType !== 'survey'
      })
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

// 全局巨觀統計數據
const overallStats = computed(() => {
  // 先依據目前選定的班級(分類)過濾所有回應數據
  const filteredResponses = selectedGroup.value === 'all'
    ? responses.value
    : responses.value.filter(r => r.question_bank?.category === selectedGroup.value)

  // 篩選出選擇題
  const mcResponses = filteredResponses.filter(r => {
    const qType = normalizeQuestionType(r.question_bank?.question_type)
    return qType === 'multiple_choice' && r.is_correct !== null
  })
  
  const totalMC = mcResponses.length
  const correctMC = mcResponses.filter(r => r.is_correct).length
  const avgAccuracy = totalMC > 0 ? Math.round((correctMC / totalMC) * 100) : 0
  
  // 反應時間統計
  const responsesWithTime = filteredResponses.filter(r => r.reaction_time != null && r.reaction_time > 0)
  const totalTime = responsesWithTime.reduce((sum, r) => sum + r.reaction_time, 0)
  const avgResponseTime = responsesWithTime.length > 0 ? (totalTime / responsesWithTime.length).toFixed(1) : '0.0'
  
  // 分門別類的群組數
  const uniqueGroups = new Set(filteredResponses.map(r => r.group_id).filter(Boolean))
  
  return {
    avgAccuracy,
    avgResponseTime,
    totalResponses: filteredResponses.length,
    activeQuestions: new Set(filteredResponses.map(r => r.question_id).filter(Boolean)).size,
    groupCount: uniqueGroups.size
  }
})

// 單元分類 (Category) 表現橫條圖數據
const categoryPerformance = computed(() => {
  const categories = {}
  responses.value.forEach(r => {
    const category = r.question_bank?.category
    const qType = normalizeQuestionType(r.question_bank?.question_type)
    if (!category || qType === 'short_answer' || qType === 'survey' || r.is_correct === null) return
    
    if (!categories[category]) {
      categories[category] = { name: category, total: 0, correct: 0 }
    }
    categories[category].total++
    if (r.is_correct) {
      categories[category].correct++
    }
  })
  
  return Object.values(categories).map(cat => ({
    name: cat.name,
    accuracy: Math.round((cat.correct / cat.total) * 100),
    total: cat.total
  })).sort((a, b) => b.accuracy - a.accuracy)
})

// 答題準確率歷程趨勢數據
const accuracyTrend = computed(() => {
  // 按發送時間排序的問題統計（從舊到新）
  const sorted = [...questionStats.value]
    .filter(q => q.accuracyRate !== null && q.displaySentAt)
    .sort((a, b) => new Date(a.displaySentAt).getTime() - new Date(b.displaySentAt).getTime())
  
  return sorted.map((q, index) => ({
    index: index + 1,
    questionId: q.questionId,
    category: q.question.category || '未分類',
    content: q.question.content ? (q.question.content.substring(0, 15) + '...') : `題目 #${q.questionId}`,
    accuracy: q.accuracyRate
  }))
})

// 計算 SVG 折線圖的寬度（適應數據點多時自動寬展以提供橫向滾動）
const chartWidth = computed(() => {
  const len = accuracyTrend.value.length
  if (len === 0) return 500
  // 每個點給予至少 55px 的寬度，首尾各留 60px 邊距，若點少於 8 點則直接等比例鋪滿 500px
  return Math.max(500, (len - 1) * 55 + 120)
})

// SVG 折線圖路徑計算
const trendPoints = computed(() => {
  const trends = accuracyTrend.value
  if (trends.length === 0) return []
  
  const width = chartWidth.value
  const height = 240
  const paddingX = 60
  const paddingTop = 10
  const paddingBottom = 30
  
  const xSpan = width - paddingX * 2
  const ySpan = height - paddingTop - paddingBottom
  
  return trends.map((item, idx) => {
    const x = trends.length > 1 
      ? paddingX + (idx / (trends.length - 1)) * xSpan
      : width / 2
    const y = height - paddingBottom - (item.accuracy / 100) * ySpan
    return {
      x,
      y,
      ...item
    }
  })
})

const trendPath = computed(() => {
  const pts = trendPoints.value
  if (pts.length === 0) return ''
  return pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
})

const trendAreaPath = computed(() => {
  const pts = trendPoints.value
  if (pts.length === 0) return ''
  const height = 240
  const paddingBottom = 30
  const first = pts[0]
  const last = pts[pts.length - 1]
  
  const linePath = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  return `${linePath} L ${last.x} ${height - paddingBottom} L ${first.x} ${height - paddingBottom} Z`
})

// 按問題分組並計算統計
const questionStats = computed(() => {
  const grouped = {}
  
  // 計算所有問題的完整統計數據
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
      questionType: question.question_type || 'multiple_choice',
      selectedOption: response.selected_option
    })
  })
  
  // 轉換為數組並計算準確率、選項得票分佈與秒數分佈
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

    // 計算單題選項得票分佈
    const metadata = stat.question.metadata || {}
    const options = metadata.options || []
    const correctAnswer = metadata.correct_answer || ''
    
    const optionCounts = {}
    options.forEach((optText, index) => {
      const letter = String.fromCharCode(65 + index) // 0 -> A, 1 -> B ...
      optionCounts[letter] = {
        letter,
        text: optText,
        count: 0,
        isCorrect: letter === correctAnswer,
        percentage: 0
      }
    })
    
    // 如果是選擇題但是 metadata 沒提供 options 列表，則默認建立 A, B, C, D 佔位
    if (options.length === 0 && !stat.isShortAnswer && !stat.isSurvey) {
      ;['A', 'B', 'C', 'D'].forEach(letter => {
        optionCounts[letter] = {
          letter,
          text: `選項 ${letter}`,
          count: 0,
          isCorrect: letter === correctAnswer,
          percentage: 0
        }
      })
    }

    // 計算反應時間區間分布
    const reactionTimeBuckets = [
      { label: '⚡ 0~5秒', range: [0, 5], count: 0, color: 'bg-indigo-500' },
      { label: '🕒 5~15秒', range: [5, 15], count: 0, color: 'bg-emerald-500' },
      { label: '🐢 15~30秒', range: [15, 30], count: 0, color: 'bg-amber-500' },
      { label: '⏳ 30秒以上', range: [30, Infinity], count: 0, color: 'bg-rose-500' }
    ]

    // 分發學生數據
    stat.students.forEach(s => {
      // 累計選項
      if (s.selectedOption && optionCounts[s.selectedOption]) {
        optionCounts[s.selectedOption].count++
      }
      // 累計反應時間
      if (s.reactionTime != null) {
        const bucket = reactionTimeBuckets.find(b => s.reactionTime >= b.range[0] && s.reactionTime < b.range[1])
        if (bucket) bucket.count++
      }
    })

    // 計算百分比
    const mcTotal = stat.students.filter(s => s.selectedOption).length
    Object.keys(optionCounts).forEach(letter => {
      optionCounts[letter].percentage = mcTotal > 0
        ? Math.round((optionCounts[letter].count / mcTotal) * 100)
        : 0
    })
    stat.optionStats = Object.values(optionCounts).sort((a, b) => a.letter.localeCompare(b.letter))

    // 反應時間百分比
    const totalWithTime = stat.students.filter(s => s.reactionTime != null).length
    reactionTimeBuckets.forEach(b => {
      b.percentage = totalWithTime > 0
        ? Math.round((b.count / totalWithTime) * 100)
        : 0
    })
    stat.reactionTimeStats = reactionTimeBuckets

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
        // ── 選擇題 / 搶答題的卡片樣式 ──
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
  
  // 搜尋過濾
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
    // 按發送時間排序
    filtered.sort((a, b) => {
      const timeA = a.displaySentAt ? new Date(a.displaySentAt).getTime() : 0;
      const timeB = b.displaySentAt ? new Date(b.displaySentAt).getTime() : 0;

      if (timeA === 0 && timeB === 0) return 0;
      if (timeA === 0) return 1;
      if (timeB === 0) return -1;

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

const highlightedQuestionId = ref(null)

function scrollToQuestion(questionId) {
  searchQuery.value = ''
  expandedQuestions.value.add(questionId)
  highlightedQuestionId.value = questionId
  setTimeout(() => {
    const el = document.getElementById(`question-card-${questionId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    setTimeout(() => {
      if (highlightedQuestionId.value === questionId) {
        highlightedQuestionId.value = null
      }
    }, 2000)
  }, 100)
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
    <!-- ============================================== -->
    <!-- Option A: Redesigned UI Layout (Academic)      -->
    <!-- ============================================== -->
    <div v-if="uiVariant === 'redesigned'" class="w-full">
      <!-- 標題欄 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 sm:mb-6 bg-white p-4 rounded-xl border border-slate-200/60 shadow-academic animate-fadeIn">
        <div class="flex items-center gap-2.5">
          <div class="p-2 bg-blue-50 text-blue-600 rounded-lg">
            <BarChart3 class="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div>
            <h2 class="text-lg sm:text-xl font-bold text-slate-800">試題分析</h2>
            <p class="text-xs text-slate-500 font-medium">基於學生於 Discord 作答與 AI 批改的多維度統計分析</p>
          </div>
        </div>
        <div class="flex gap-2 w-full sm:w-auto">
          <button
            @click="showGlobalDashboard = !showGlobalDashboard"
            class="flex-1 sm:flex-none justify-center px-3.5 py-2 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg transition-all flex items-center gap-1.5 text-sm font-semibold touch-target"
          >
            <component :is="showGlobalDashboard ? EyeOff : Eye" class="w-4 h-4 text-slate-500" />
            {{ showGlobalDashboard ? '隱藏儀表板' : '顯示儀表板' }}
          </button>
          <button
            @click="fetchAnalytics"
            class="flex-1 sm:flex-none justify-center px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg shadow-sm transition-all flex items-center gap-2 text-sm font-semibold touch-target"
            :disabled="loading"
          >
            <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
            重新整理
          </button>
        </div>
      </div>

      <!-- 全局統計儀表板 (SVG Charts + Metrics) -->
      <Transition name="expand">
        <div v-if="showGlobalDashboard && !loading && responses.length > 0" class="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-5 animate-fadeIn">
          <!-- KPI Metrics Cards -->
          <div class="bg-white p-5 rounded-2xl border border-slate-200/60 shadow-academic flex flex-col justify-between gap-4">
            <h3 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
              <Award class="w-4 h-4 text-slate-400" /> 核心指標 (Core KPI)
            </h3>
            
            <div class="grid grid-cols-2 gap-4 my-auto">
              <!-- KPI: 答對率 -->
              <div class="flex flex-col p-3.5 bg-slate-50/50 rounded-xl border border-slate-100 hover:border-blue-100 transition-colors">
                <span class="text-xs font-semibold text-slate-500 mb-1">平均答對率</span>
                <div class="flex items-baseline gap-1.5">
                  <span class="text-2xl font-extrabold text-blue-600 font-mono">{{ overallStats.avgAccuracy }}</span>
                  <span class="text-sm font-bold text-slate-400">%</span>
                </div>
                <div class="text-[10px] text-slate-400 mt-1 font-medium flex items-center gap-0.5">
                  <TrendingUp class="w-3 h-3 text-emerald-500 inline" />
                  僅計算選擇題
                </div>
              </div>
              <!-- KPI: 平均秒數 -->
              <div class="flex flex-col p-3.5 bg-slate-50/50 rounded-xl border border-slate-100 hover:border-blue-100 transition-colors">
                <span class="text-xs font-semibold text-slate-500 mb-1">平均反應秒數</span>
                <div class="flex items-baseline gap-1.5">
                  <span class="text-2xl font-extrabold text-slate-800 font-mono">{{ overallStats.avgResponseTime }}</span>
                  <span class="text-sm font-bold text-slate-400">秒</span>
                </div>
                <div class="text-[10px] text-slate-400 mt-1 font-medium flex items-center gap-0.5">
                  <Clock class="w-3 h-3 text-amber-500 inline" />
                  不含簡答/問卷題
                </div>
              </div>
              <!-- KPI: 作答總人次 -->
              <div class="flex flex-col p-3.5 bg-slate-50/50 rounded-xl border border-slate-100 hover:border-blue-100 transition-colors">
                <span class="text-xs font-semibold text-slate-500 mb-1">累積作答總數</span>
                <div class="flex items-baseline gap-1.5">
                  <span class="text-2xl font-extrabold text-slate-800 font-mono">{{ overallStats.totalResponses }}</span>
                  <span class="text-sm font-bold text-slate-400">人次</span>
                </div>
                <div class="text-[10px] text-slate-400 mt-1 font-medium">全平台作答樣本</div>
              </div>
              <!-- KPI: 題目總數 -->
              <div class="flex flex-col p-3.5 bg-slate-50/50 rounded-xl border border-slate-100 hover:border-blue-100 transition-colors">
                <span class="text-xs font-semibold text-slate-500 mb-1">已分析題目</span>
                <div class="flex items-baseline gap-1.5">
                  <span class="text-2xl font-extrabold text-slate-800 font-mono">{{ overallStats.activeQuestions }}</span>
                  <span class="text-sm font-bold text-slate-400">題</span>
                </div>
                <div class="text-[10px] text-slate-400 mt-1 font-medium">分佈於 {{ overallStats.groupCount }} 個 Discord 班級</div>
              </div>
            </div>
          </div>

          <!-- 折線圖：單題答對率趨勢 (SVG) -->
          <div class="lg:col-span-2 bg-white p-5 rounded-2xl border border-slate-200/60 shadow-academic flex flex-col justify-between">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                <TrendingUp class="w-4 h-4 text-slate-400" /> 單題答對率歷程趨勢
              </h3>
              <span class="text-[10px] text-blue-600 bg-blue-50 px-2 py-0.5 font-bold rounded-full">依時間正序</span>
            </div>
            
            <div v-if="accuracyTrend.length >= 2" class="w-full overflow-x-auto scrollbar-thin pb-2 mt-1">
              <!-- Native SVG Trend Line Chart -->
              <svg :viewBox="`0 0 ${chartWidth} 240`" :style="{ width: chartWidth + 'px', minWidth: '100%' }" class="h-auto overflow-visible">
                <!-- Grid Lines -->
                <line x1="60" y1="10" :x2="chartWidth - 60" y2="10" stroke="#f1f5f9" stroke-dasharray="3" />
                <line x1="60" y1="110" :x2="chartWidth - 60" y2="110" stroke="#f1f5f9" stroke-dasharray="3" />
                <line x1="60" y1="210" :x2="chartWidth - 60" y2="210" stroke="#cbd5e1" stroke-width="1" />
                
                <!-- Y Labels -->
                <text x="15" y="14" font-size="12" font-weight="bold" class="fill-slate-500 font-mono">100%</text>
                <text x="15" y="114" font-size="12" font-weight="bold" class="fill-slate-500 font-mono">50%</text>
                <text x="15" y="214" font-size="12" font-weight="bold" class="fill-slate-500 font-mono">0%</text>

                <!-- X Labels (Question IDs) -->
                <text
                  v-for="(pt, idx) in trendPoints"
                  :key="'lbl-academic-' + idx"
                  :x="pt.x"
                  y="230"
                  font-size="10"
                  font-weight="bold"
                  text-anchor="middle"
                  class="fill-slate-400 font-mono transition-colors duration-150 group-hover/dot:fill-slate-600 cursor-pointer hover:fill-slate-800"
                  @click="scrollToQuestion(pt.questionId)"
                >
                  #{{ pt.questionId }}
                </text>

                <!-- Vertical Projection Lines (from point to baseline) -->
                <line
                  v-for="(pt, idx) in trendPoints"
                  :key="'proj-academic-' + idx"
                  :x1="pt.x"
                  :y1="pt.y"
                  :x2="pt.x"
                  y2="210"
                  stroke="#cbd5e1"
                  stroke-dasharray="2 3"
                  stroke-width="1.2"
                  class="opacity-50 transition-opacity duration-150"
                />

                <!-- Gradient Line -->
                <path
                  :d="trendPath"
                  fill="none"
                  stroke="url(#line-grad-academic)"
                  stroke-width="3.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                
                <!-- Gradient Area -->
                <path
                  :d="trendAreaPath"
                  fill="url(#area-grad-academic)"
                />

                <!-- Interactive Points -->
                <g v-for="(pt, idx) in trendPoints" :key="idx" class="group/dot cursor-pointer" @click="scrollToQuestion(pt.questionId)">
                  <circle
                    :cx="pt.x"
                    :cy="pt.y"
                    r="5.5"
                    class="fill-white stroke-[3.5] transition-all duration-150"
                    :class="pt.accuracy >= 60 ? 'stroke-blue-500 hover:stroke-blue-600' : 'stroke-rose-500 hover:stroke-rose-600'"
                  />
                  <circle
                    :cx="pt.x"
                    :cy="pt.y"
                    r="10"
                    class="fill-transparent hover:fill-blue-500/10"
                  />
                  <!-- HTML Default Tooltip on hover -->
                  <title>第 {{ pt.index }} 題 (ID: #{{ pt.questionId }}): {{ pt.accuracy }}% 答對率</title>
                </g>

                <!-- Defs -->
                <defs>
                  <linearGradient id="line-grad-academic" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#3b82f6" />
                    <stop offset="100%" stop-color="#10b981" />
                  </linearGradient>
                  <linearGradient id="area-grad-academic" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.12" />
                    <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.00" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <div v-else class="py-10 text-center text-slate-400 text-xs font-medium">
              數據點不足（需至少 2 題選擇題答題數據）來繪製趨勢圖
            </div>
          </div>
        </div>
      </Transition>

      <!-- Search & Filters -->
      <div class="mb-5 sm:mb-6 flex flex-col md:flex-row gap-3">
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
          v-model="selectedGroup"
          class="px-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-smooth text-sm font-semibold text-slate-700 shadow-academic touch-target"
        >
          <option value="all">所有班級 (All Groups)</option>
          <option v-for="className in availableClasses" :key="className" :value="className">
            {{ className }}
          </option>
        </select>
        <select
          v-model="sortBy"
          class="px-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-smooth text-sm font-semibold text-slate-700 shadow-academic touch-target"
        >
          <option value="latest">最近發送 (Latest Sent)</option>
          <option value="oldest">最久以前 (Oldest Sent)</option>
          <option value="hardest">🔥 難易度排序 (Hardest)</option>
        </select>
      </div>

      <!-- Loading State -->
      <div v-if="loading" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
        <RefreshCw class="w-8 h-8 animate-spin mx-auto mb-3 text-blue-600" />
        <p class="font-medium text-sm">正在分析答題數據...</p>
      </div>

      <!-- Empty State -->
      <div v-else-if="filteredStats.length === 0" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
        <BarChart3 class="w-12 h-12 mx-auto mb-4 text-slate-300" />
        <p class="text-base font-bold text-slate-800 mb-1">{{ searchQuery ? '沒有找到符合搜尋條件的題目' : '目前還沒有答題記錄' }}</p>
        <p class="text-xs text-slate-400">當學生在 Discord 完成作答後，此處將自動產生深度分析報告。</p>
      </div>

      <!-- Statistics list -->
      <div v-else class="space-y-4">
        <div
          v-for="stat in filteredStats"
          :key="stat.questionId"
          :id="'question-card-' + stat.questionId"
          class="bg-white rounded-2xl shadow-academic border-2 overflow-hidden transition-all duration-300"
          :class="[
            highlightedQuestionId === stat.questionId
              ? 'ring-4 ring-blue-500/50 scale-[1.015] border-blue-500 shadow-xl z-10 relative'
              : stat.isShortAnswer
                ? 'border-purple-300/90 hover:border-purple-400'
                : stat.isSurvey
                  ? 'border-emerald-300/90 hover:border-emerald-400'
                  : stat.isSpeedQuiz
                    ? 'border-fuchsia-300/90 hover:border-fuchsia-400'
                    : 'border-blue-300/90 hover:border-blue-400'
          ]"
        >
          <!-- Summary header card -->
          <div
            class="p-4 sm:p-5 cursor-pointer hover:bg-slate-50/50 transition-smooth"
            @click="toggleExpand(stat.questionId)"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-2 mb-2.5">
                  <span class="text-xs text-slate-400 font-mono font-bold tracking-tight bg-slate-50 px-2 py-0.5 rounded border border-slate-200/60">#{{ stat.questionId }}</span>
                  <span
                    v-if="stat.question.category"
                    class="px-2 py-0.5 text-[10px] sm:text-xs bg-blue-50 text-blue-600 font-bold rounded-lg"
                  >
                    {{ stat.question.category }}
                  </span>
                  
                  <span
                    v-if="stat.isShortAnswer"
                    class="px-2 py-0.5 text-[10px] sm:text-xs font-bold bg-purple-50 text-purple-700 border border-purple-100 rounded-lg"
                  >
                    ✍️ 簡答題
                  </span>
                  <span
                    v-if="stat.isSurvey"
                    class="px-2 py-0.5 text-[10px] sm:text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-lg"
                  >
                    🗳️ 問卷題
                  </span>
                  
                  <span
                    v-if="stat.isShortAnswer && stat.hasPending"
                    class="px-2 py-0.5 text-[10px] sm:text-xs font-bold bg-amber-50 text-amber-600 border border-amber-100 rounded-lg animate-pulse"
                  >
                    ⏳ 待批改
                  </span>
                  
                  <span
                    v-if="!stat.isShortAnswer && !stat.isSurvey && !stat.isSpeedQuiz"
                    class="px-2 py-0.5 text-[10px] sm:text-xs font-bold rounded-lg"
                    :class="[
                      stat.accuracyRate >= 80 ? 'text-emerald-700 bg-emerald-50' :
                      stat.accuracyRate >= 60 ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50'
                    ]"
                  >
                    {{ stat.accuracyRate }}% 準確率
                  </span>
                  <span
                    v-if="stat.isSpeedQuiz"
                    class="px-2 py-0.5 text-[10px] sm:text-xs font-bold bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-100 rounded-lg shadow-sm"
                  >
                    ⚡ 搶答挑戰
                  </span>
                  <span class="text-[11px] text-slate-400 font-medium">
                    🕒 發送: {{ stat.displaySentAt ? new Date(stat.displaySentAt).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : '尚未發送' }}
                  </span>
                </div>
                
                <p class="text-sm sm:text-base font-bold text-slate-800 mb-3 break-words">
                  {{ stat.question.content || '（無題目描述，僅提供選項）' }}
                </p>

                <!-- Accuracy Progress Bar -->
                <div v-if="!stat.isSpeedQuiz && !stat.isShortAnswer && !stat.isSurvey" class="mb-3">
                  <div class="w-full bg-slate-100 rounded-full h-2">
                    <div class="h-2 rounded-full transition-smooth duration-500" 
                      :class="
                        stat.accuracyRate >= 80 ? 'bg-emerald-500' : 
                        stat.accuracyRate >= 60 ? 'bg-amber-500' : 'bg-red-500'
                      "
                      :style="{ width: stat.accuracyRate + '%' }"
                    ></div>
                  </div>
                </div>

                <div class="flex flex-wrap items-center gap-4 text-xs font-semibold text-slate-500">
                  <div class="flex items-center gap-1">
                    <Users class="w-4 h-4" />
                    <span>{{ stat.isSpeedQuiz ? '上榜小隊' : '已參與作答' }}: <span class="font-mono font-bold text-slate-700">{{ stat.displayStudents.length }}</span> 人</span>
                  </div>

                  <!-- Multiple choice correct / incorrect stats -->
                  <template v-if="!stat.isShortAnswer && !stat.isSurvey && !stat.isSpeedQuiz">
                    <div class="flex items-center gap-1 text-emerald-600">
                      <CheckCircle2 class="w-4 h-4" />
                      <span>答對: <span class="font-mono font-bold">{{ stat.correctCount }}</span></span>
                    </div>
                    <div class="flex items-center gap-1 text-red-500">
                      <XCircle class="w-4 h-4" />
                      <span>答錯: <span class="font-mono font-bold">{{ stat.incorrectCount }}</span></span>
                    </div>
                  </template>

                  <!-- Short Answer stats -->
                  <template v-if="stat.isShortAnswer">
                    <div v-if="stat.avgScore != null" class="flex items-center gap-1" :class="getScoreColor(stat.avgScore)">
                      <span class="font-bold">平均得分: {{ stat.avgScore }} 分</span>
                    </div>
                    <div v-if="stat.hasPending" class="flex items-center gap-1 text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-100/50 text-[10px]">
                      <span>{{ stat.students.filter(s => s.status === 'pending').length }} 份簡答待批改</span>
                    </div>
                  </template>
                </div>
              </div>
              
              <div class="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg shrink-0 mt-1 transition-smooth">
                <ChevronDown v-if="!expandedQuestions.has(stat.questionId)" class="w-5 h-5" />
                <ChevronUp v-else class="w-5 h-5" />
              </div>
            </div>
          </div>

          <!-- Expandable Details (Accordion Layout) -->
          <Transition name="expand">
            <div
              v-if="expandedQuestions.has(stat.questionId)"
              class="border-t border-slate-200/60 bg-slate-50/50"
            >
              <div class="p-4 sm:p-5">
                <!-- 💡 視覺化圖表分析區 (新增) -->
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5 pb-5 border-b border-slate-200/60">
                  <!-- 1. 選擇題選項分布 -->
                  <div v-if="!stat.isShortAnswer && !stat.isSurvey" class="bg-white p-4 rounded-xl border border-slate-200/60 shadow-sm flex flex-col justify-between">
                    <div class="flex items-center gap-1.5 mb-3.5">
                      <PieChart class="w-4 h-4 text-blue-500" />
                      <h5 class="text-xs font-bold text-slate-700 uppercase tracking-wider">選項得票率與誘答力分析</h5>
                    </div>
                    
                    <div class="space-y-3">
                      <div v-for="opt in stat.optionStats" :key="opt.letter" class="flex flex-col">
                        <div class="flex items-center justify-between text-xs mb-1 font-semibold">
                          <span class="flex items-center gap-1.5">
                            <span 
                              class="w-5 h-5 text-[10px] font-bold flex items-center justify-center rounded-md border"
                              :class="[
                                opt.isCorrect 
                                  ? 'bg-emerald-50 text-emerald-600 border-emerald-200' 
                                  : opt.count > 0 
                                    ? 'bg-rose-50 text-rose-600 border-rose-200' 
                                    : 'bg-slate-50 text-slate-500 border-slate-200/60'
                              ]"
                            >
                              {{ opt.letter }}
                            </span>
                            <span class="truncate max-w-[150px] sm:max-w-[250px] text-slate-700" :class="{ 'font-bold text-emerald-600': opt.isCorrect }">
                              {{ opt.text }}
                            </span>
                            <span v-if="opt.isCorrect" class="text-[10px] text-emerald-500 font-bold bg-emerald-50 px-1 py-0.2 rounded border border-emerald-100">答案</span>
                          </span>
                          <span class="font-mono text-slate-600">{{ opt.count }} 人 ({{ opt.percentage }}%)</span>
                        </div>
                        <div class="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200/10">
                          <div 
                            class="h-full rounded-full transition-all duration-500"
                            :class="[
                              opt.isCorrect 
                                ? 'bg-emerald-500' 
                                : opt.count > 0 
                                  ? 'bg-rose-400' 
                                  : 'bg-slate-300'
                            ]"
                            :style="{ width: opt.percentage + '%' }"
                          ></div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- 2. 答題秒數區間分佈 -->
                  <div class="bg-white p-4 rounded-xl border border-slate-200/60 shadow-sm flex flex-col justify-between">
                    <div class="flex items-center gap-1.5 mb-3.5">
                      <Clock class="w-4 h-4 text-indigo-500" />
                      <h5 class="text-xs font-bold text-slate-700 uppercase tracking-wider">作答反應秒數區間分析</h5>
                    </div>
                    
                    <div class="space-y-3">
                      <div v-for="bucket in stat.reactionTimeStats" :key="bucket.label" class="flex flex-col">
                        <div class="flex items-center justify-between text-xs mb-1 font-semibold text-slate-700">
                          <span>{{ bucket.label }}</span>
                          <span class="font-mono">{{ bucket.count }} 人 ({{ bucket.percentage }}%)</span>
                        </div>
                        <div class="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200/10">
                          <div 
                            class="h-full rounded-full transition-all duration-500"
                            :class="bucket.color"
                            :style="{ width: bucket.percentage + '%' }"
                          ></div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div v-if="stat.isShortAnswer || stat.isSurvey" class="col-span-1 lg:col-span-2 bg-blue-50/40 p-4 rounded-xl border border-blue-100/60 text-xs text-blue-700 font-medium leading-relaxed flex gap-2">
                    <HelpCircle class="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                    <div>
                      <p class="font-bold text-blue-800 mb-0.5">系統分析小提醒</p>
                      <p class="text-slate-600">
                        {{ stat.isShortAnswer 
                          ? '簡答題由 AI 與老師進行人工評分。您可以藉由右側作答反應秒數，檢視學生回答此知識點時是否花費較多思考時間。' 
                          : '問卷題不計入答對率統計，著重於收集學生課後反饋。下方提供每位學生的問卷填寫內容。' }}
                      </p>
                    </div>
                  </div>
                </div>

                <!-- 學生卡片清單 -->
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                  <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                    📋 學生作答詳情 (顯示 {{ stat.displayStudents.length }} 筆)
                  </h4>
                  <div class="flex items-center gap-2 self-end sm:self-auto">
                    <!-- Toggle Show/Hide Button -->
                    <button
                      @click="showStudentDetails = !showStudentDetails"
                      class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors text-xs font-semibold text-slate-600 cursor-pointer shadow-sm"
                    >
                      <component :is="showStudentDetails ? EyeOff : Eye" class="w-4 h-4" />
                      <span>{{ showStudentDetails ? '隱藏學生詳情' : '顯示學生詳情' }}</span>
                    </button>

                    <select
                      v-if="!stat.isShortAnswer && !stat.isSurvey"
                      v-model="studentSortBy"
                      class="px-3 py-1.5 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none w-full sm:w-auto bg-white text-slate-700 font-semibold shadow-sm touch-target cursor-pointer"
                    >
                      <option value="correctness">預設排序 (答對在前)</option>
                      <option value="fastest">反應時間 (最快在前)</option>
                    </select>
                  </div>
                </div>
                
                <div v-show="showStudentDetails" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  <div
                    v-for="(student, index) in getSortedStudents(stat.displayStudents)"
                    :key="index"
                    class="p-4 bg-white rounded-xl shadow-academic border border-slate-200/60 flex flex-col hover:border-slate-300 hover:shadow-academic-hover transition-smooth"
                  >
                    <div class="flex items-start justify-between mb-3 gap-2">
                      <div class="flex items-center gap-2">
                        <span class="text-lg select-none">{{ student.rankIcon || '👤' }}</span>
                        <span class="text-sm font-bold text-slate-800 tracking-tight">{{ student.displayName }}</span>
                      </div>
                      
                      <span
                        class="text-[10px] px-2 py-0.5 rounded-full font-bold border whitespace-nowrap"
                        :class="[
                          student.isCorrect ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                          student.score >= 60 ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-rose-50 text-rose-700 border-rose-100'
                        ]"
                      >
                        {{ student.statusText }}
                      </span>
                    </div>

                    <!-- 作答顯示 (學術版) -->
                    <div v-if="student.selectedOption && !stat.isShortAnswer" class="mb-2 text-xs">
                      <div class="px-2 py-1.5 bg-slate-50 border border-slate-200/60 rounded-lg flex items-center gap-1.5">
                        <span class="text-slate-400 font-semibold">作答選擇:</span>
                        <span 
                          class="w-5 h-5 text-[10px] font-bold flex items-center justify-center rounded-md border"
                          :class="[
                            student.isCorrect 
                              ? 'bg-emerald-50 text-emerald-600 border-emerald-200' 
                              : 'bg-rose-50 text-rose-600 border-rose-200'
                          ]"
                        >
                          {{ student.selectedOption }}
                        </span>
                      </div>
                    </div>

                    <div v-if="(stat.isShortAnswer || stat.isSurvey) && (student.answerText || student.aiFeedback)" class="mb-3 space-y-2.5">
                      <div v-if="student.answerText" class="bg-blue-50/50 border border-blue-100/60 rounded-xl p-3 shadow-sm">
                        <p class="text-[9px] font-bold text-blue-600 tracking-wider uppercase mb-1">{{ stat.isSurvey ? '🗳️ 問卷答案' : '📝 學生回答' }}</p>
                        <p class="text-xs text-slate-700 font-medium leading-relaxed whitespace-pre-wrap">{{ student.answerText }}</p>
                      </div>
                      <div v-if="stat.isShortAnswer && student.aiFeedback" class="bg-violet-50/50 border border-violet-100/60 rounded-xl p-3 shadow-sm">
                        <p class="text-[9px] font-bold text-violet-600 tracking-wider uppercase mb-1">🤖 AI 點評</p>
                        <p class="text-xs text-slate-600 font-medium leading-relaxed whitespace-pre-wrap">{{ student.aiFeedback }}</p>
                      </div>
                    </div>
                    
                    <div class="flex items-center justify-between mt-auto pt-3 border-t border-slate-100 text-xs">
                      <span class="text-[10px] text-slate-400 font-mono font-bold bg-slate-50 px-1.5 py-0.5 rounded">{{ student.studentId }}</span>
                      <div class="flex items-center gap-2">
                        <span v-if="student.reactionTime != null" class="text-xs font-bold" :class="student.reactionTime < 10 ? 'text-amber-600' : 'text-slate-500'">
                          ⚡ {{ student.reactionTime }} 秒
                        </span>
                        <span v-else class="text-xs text-slate-300">⚡ --</span>
                        <template v-if="stat.isShortAnswer">
                          <span v-if="student.status === 'graded'" class="text-xs font-bold text-blue-600">
                            🎯 {{ student.score }} 分
                          </span>
                          <span v-else class="text-xs text-slate-400 font-semibold animate-pulse">⏳ 批改中...</span>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>

    <!-- ============================================== -->
    <!-- Option B: Classic UI Layout (Original Green)   -->
    <!-- ============================================== -->
    <div v-else class="w-full">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 sm:mb-6">
        <div class="flex items-center gap-2">
          <BarChart3 class="w-5 h-5 sm:w-6 sm:h-6 text-green-600" />
          <div>
            <h2 class="text-xl sm:text-2xl font-bold text-gray-800">試題分析</h2>
            <p class="text-xs text-gray-500">檢視學生的答題情況、選項分佈及作答反應秒數</p>
          </div>
        </div>
        <div class="flex gap-2 w-full sm:w-auto">
          <button
            @click="showGlobalDashboard = !showGlobalDashboard"
            class="flex-1 sm:flex-none justify-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition flex items-center gap-2 text-sm sm:text-base font-semibold touch-target"
          >
            <component :is="showGlobalDashboard ? EyeOff : Eye" class="w-4 h-4 text-gray-500" />
            {{ showGlobalDashboard ? '隱藏指標' : '顯示指標' }}
          </button>
          <button
            @click="fetchAnalytics"
            class="flex-1 sm:flex-none justify-center px-4 py-2 border border-green-600 bg-green-50 text-green-700 rounded-lg hover:bg-green-100 transition-colors flex items-center gap-2 text-sm sm:text-base"
            :disabled="loading"
          >
            <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
            重新整理
          </button>
        </div>
      </div>

      <!-- 全局指標 (Classic UI) -->
      <Transition name="expand">
        <div v-if="showGlobalDashboard && !loading && responses.length > 0" class="mb-6 bg-white rounded-lg border border-gray-200 p-4 sm:p-5 shadow-sm">
          <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-1">
            📊 班級答題數據總覽
          </h3>
          
          <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
            <!-- KPIs -->
            <div class="grid grid-cols-2 gap-3">
              <div class="bg-gray-50 p-3 rounded border border-gray-100">
                <p class="text-xs text-gray-500">選擇題平均答對率</p>
                <p class="text-xl font-bold text-green-600 mt-1">{{ overallStats.avgAccuracy }}%</p>
              </div>
              <div class="bg-gray-50 p-3 rounded border border-gray-100">
                <p class="text-xs text-gray-500">平均反應時間</p>
                <p class="text-xl font-bold text-gray-700 mt-1">{{ overallStats.avgResponseTime }} 秒</p>
              </div>
              <div class="bg-gray-50 p-3 rounded border border-gray-100 col-span-2">
                <p class="text-xs text-gray-500">已作答總樣本 / 題數</p>
                <p class="text-base font-bold text-gray-700 mt-1">
                  {{ overallStats.totalResponses }} 人次 / {{ overallStats.activeQuestions }} 題
                </p>
              </div>
            </div>

            <!-- Trend -->
            <div class="md:col-span-2 border border-gray-100 rounded p-3 bg-gray-50/30 flex flex-col justify-between">
              <p class="text-xs font-bold text-gray-400 mb-2">答對率波段趨勢 (依發送順序)</p>
              <div v-if="accuracyTrend.length >= 2" class="w-full overflow-x-auto scrollbar-thin pb-2 h-[190px]">
                <svg :viewBox="`0 0 ${chartWidth} 240`" :style="{ width: chartWidth + 'px', minWidth: '100%' }" class="h-full overflow-visible">
                  <!-- Classic Grid Lines -->
                  <line x1="60" y1="10" :x2="chartWidth - 60" y2="10" stroke="#e2e8f0" stroke-dasharray="3" />
                  <line x1="60" y1="110" :x2="chartWidth - 60" y2="110" stroke="#e2e8f0" stroke-dasharray="3" />
                  <line x1="60" y1="210" :x2="chartWidth - 60" y2="210" stroke="#cbd5e1" stroke-width="1" />
                  
                  <!-- Y Labels -->
                  <text x="15" y="14" font-size="12" font-weight="bold" class="fill-gray-400 font-mono">100%</text>
                  <text x="15" y="114" font-size="12" font-weight="bold" class="fill-gray-400 font-mono">50%</text>
                  <text x="15" y="214" font-size="12" font-weight="bold" class="fill-gray-400 font-mono">0%</text>

                  <!-- X Labels (Question IDs) -->
                  <text
                    v-for="(pt, idx) in trendPoints"
                    :key="'lbl-classic-' + idx"
                    :x="pt.x"
                    y="230"
                    font-size="10"
                    font-weight="bold"
                    text-anchor="middle"
                    class="fill-gray-400 font-mono cursor-pointer hover:fill-slate-800 transition-colors"
                    @click="scrollToQuestion(pt.questionId)"
                  >
                    #{{ pt.questionId }}
                  </text>

                  <!-- Vertical Projection Lines (from point to baseline) -->
                  <line
                    v-for="(pt, idx) in trendPoints"
                    :key="'proj-classic-' + idx"
                    :x1="pt.x"
                    :y1="pt.y"
                    :x2="pt.x"
                    y2="210"
                    stroke="#e2e8f0"
                    stroke-dasharray="2 3"
                    stroke-width="1.2"
                    class="opacity-50"
                  />

                  <!-- Classic Trend -->
                  <path
                    :d="trendPath"
                    fill="none"
                    stroke="#16a34a"
                    stroke-width="3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <g v-for="(pt, idx) in trendPoints" :key="idx" class="cursor-pointer group/dot" @click="scrollToQuestion(pt.questionId)">
                    <circle
                      :cx="pt.x"
                      :cy="pt.y"
                      r="5"
                      fill="white"
                      stroke="#16a34a"
                      stroke-width="3"
                      class="transition-all duration-150 group-hover/dot:stroke-green-600"
                    />
                    <circle
                      :cx="pt.x"
                      :cy="pt.y"
                      r="10"
                      class="fill-transparent hover:fill-green-500/10"
                    />
                    <title>第 {{ pt.index }} 題: {{ pt.accuracy }}%</title>
                  </g>
                </svg>
              </div>
              <p v-else class="text-xs text-gray-400 py-4 text-center">趨勢數據不足</p>
            </div>
          </div>
        </div>
      </Transition>

      <!-- 搜索與篩選 -->
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
          :id="'question-card-' + stat.questionId"
          class="bg-white rounded-lg shadow-sm border-2 overflow-hidden transition-all duration-300"
          :class="[
            highlightedQuestionId === stat.questionId
              ? 'ring-4 ring-green-500/50 scale-[1.015] border-green-500 shadow-md z-10 relative'
              : stat.isShortAnswer
                ? 'border-purple-300'
                : stat.isSurvey
                  ? 'border-emerald-300'
                  : stat.isSpeedQuiz
                    ? 'border-fuchsia-300'
                    : 'border-blue-300'
          ]"
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

                <!-- 準確率進度條 -->
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

                  <template v-if="!stat.isShortAnswer && !stat.isSurvey && !stat.isSpeedQuiz">
                    <div class="flex items-center gap-1 text-green-600">
                      <CheckCircle2 class="w-4 h-4" />
                      <span>答對<span class="hidden sm:inline">:</span> {{ stat.correctCount }}</span>
                    </div>
                    <div class="flex items-center gap-1 text-red-600">
                      <XCircle class="w-4 h-4" />
                      <span>答錯<span class="hidden sm:inline">:</span> {{ stat.incorrectCount }}</span>
                    </div>
                  </template>

                  <template v-if="stat.isShortAnswer">
                    <div v-if="stat.avgScore != null" class="flex items-center gap-1" :class="getScoreColor(stat.avgScore)">
                      <span class="font-semibold">平均得分: {{ stat.avgScore }} 分</span>
                    </div>
                    <div v-if="stat.hasPending" class="flex items-center gap-1 text-gray-500">
                      <span>{{ stat.students.filter(s => s.status === 'pending').length }} 份待批改</span>
                    </div>
                  </template>
                </div>
              </div>
              <div class="ml-2 sm:ml-4 shrink-0 mt-1">
                <ChevronDown v-if="!expandedQuestions.has(stat.questionId)" class="w-5 h-5 text-gray-400" />
                <ChevronUp v-else class="w-5 h-5 text-gray-400" />
              </div>
            </div>
          </div>

          <!-- 展開的學生詳情與圖表 -->
          <Transition name="expand">
            <div
              v-if="expandedQuestions.has(stat.questionId)"
              class="border-t border-gray-200 bg-gray-50"
            >
              <div class="p-4 sm:p-5">
                <!-- 💡 經典版選項分布與反應時間分析 -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 border-b border-gray-200/60 pb-4">
                  <!-- 選項分布 -->
                  <div v-if="!stat.isShortAnswer && !stat.isSurvey" class="bg-white p-3.5 rounded border border-gray-200">
                    <p class="text-xs font-bold text-gray-500 mb-2 flex items-center gap-1">📊 選項投票比例分析</p>
                    <div class="space-y-2">
                      <div v-for="opt in stat.optionStats" :key="opt.letter" class="flex flex-col text-xs">
                        <div class="flex justify-between items-center mb-1">
                          <span class="flex items-center gap-1">
                            <span class="font-bold" :class="opt.isCorrect ? 'text-green-600 font-extrabold' : 'text-gray-700'">
                              [{{ opt.letter }}] {{ opt.text }}
                            </span>
                            <span v-if="opt.isCorrect" class="text-[9px] bg-green-100 text-green-700 px-1 rounded">正解</span>
                          </span>
                          <span class="font-mono">{{ opt.count }} 票 ({{ opt.percentage }}%)</span>
                        </div>
                        <div class="w-full bg-gray-100 h-2 rounded overflow-hidden">
                          <div class="h-full rounded" :class="opt.isCorrect ? 'bg-green-500' : opt.count > 0 ? 'bg-red-400' : 'bg-gray-300'" :style="{ width: opt.percentage + '%' }"></div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- 反應時間 -->
                  <div class="bg-white p-3.5 rounded border border-gray-200">
                    <p class="text-xs font-bold text-gray-500 mb-2 flex items-center gap-1">⏱️ 作答秒數區間比例</p>
                    <div class="space-y-2">
                      <div v-for="bucket in stat.reactionTimeStats" :key="bucket.label" class="flex flex-col text-xs">
                        <div class="flex justify-between items-center mb-1">
                          <span>{{ bucket.label }}</span>
                          <span class="font-mono">{{ bucket.count }} 人 ({{ bucket.percentage }}%)</span>
                        </div>
                        <div class="w-full bg-gray-100 h-2 rounded overflow-hidden">
                          <div class="h-full rounded" :class="bucket.color" :style="{ width: bucket.percentage + '%' }"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                  <h4 class="text-sm font-semibold text-gray-700">
                    學生答題詳情 (顯示 {{ stat.displayStudents.length }} 人)
                  </h4>
                  <div class="flex items-center gap-2 self-end sm:self-auto">
                    <!-- Toggle Show/Hide Button -->
                    <button
                      @click="showStudentDetails = !showStudentDetails"
                      class="flex items-center gap-1 px-2.5 py-1.5 rounded border border-gray-300 hover:bg-gray-100 transition-colors text-xs text-gray-600 cursor-pointer"
                    >
                      <component :is="showStudentDetails ? EyeOff : Eye" class="w-3.5 h-3.5" />
                      <span>{{ showStudentDetails ? '隱藏學生詳情' : '顯示學生詳情' }}</span>
                    </button>

                    <select
                      v-if="!stat.isShortAnswer && !stat.isSurvey"
                      v-model="studentSortBy"
                      class="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none w-full sm:w-auto bg-white text-gray-700 cursor-pointer"
                    >
                      <option value="correctness">預設排序 (答對在前)</option>
                      <option value="fastest">反應時間 (最快在前)</option>
                    </select>
                  </div>
                </div>
                
                <div v-show="showStudentDetails" class="grid grid-cols-1 md:grid-cols-3 gap-4">
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

                    <!-- 作答顯示 (經典版) -->
                    <div v-if="student.selectedOption && !stat.isShortAnswer" class="mb-2 text-xs">
                      <span class="text-gray-500">作答選擇: </span>
                      <span class="font-bold px-1.5 py-0.5 rounded border bg-white" :class="student.isCorrect ? 'text-green-600 border-green-200' : 'text-red-500 border-red-200'">
                        {{ student.selectedOption }}
                      </span>
                    </div>

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
                      <div class="flex items-center gap-2">
                        <span v-if="student.reactionTime != null" class="text-sm font-medium" :class="student.reactionTime < 10 ? 'text-amber-600' : 'text-gray-600'">
                          ⚡ {{ student.reactionTime }} 秒
                        </span>
                        <span v-else class="text-sm text-gray-400">⚡ --</span>
                        <template v-if="stat.isShortAnswer">
                          <span v-if="student.status === 'graded'" class="text-sm font-semibold" :class="getScoreColor(student.score)">
                            {{ student.score }} 分
                          </span>
                          <span v-else class="text-sm text-gray-400">尚未批改</span>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Transition>
        </div>
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

.scrollbar-thin::-webkit-scrollbar {
  width: 4px;
}
.scrollbar-thin::-webkit-scrollbar-track {
  background: transparent;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 2px;
}
.scrollbar-thin::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}
</style>
