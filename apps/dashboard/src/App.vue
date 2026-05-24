<script setup>
import { ref, computed, onMounted, provide, watch } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from './supabase'
import TeacherDashboard from './components/TeacherDashboard.vue'
import LoginModal from './components/LoginModal.vue'
import UpdatePasswordModal from './components/UpdatePasswordModal.vue'
import { LogOut, LogIn, Trophy, BookOpen, Layers } from 'lucide-vue-next'

const route = useRoute()
const isStudentRoute = computed(() => route.path.startsWith('/student'))
const session = ref(null)
const showLoginModal = ref(false)
const showUpdatePasswordModal = ref(false)
const teacherDashboardRef = ref(null)

const dashboardLinkState = computed(() => ({
  tab: typeof route.query.tab === 'string' ? route.query.tab : null,
  gradingStatus: typeof route.query.status === 'string' ? route.query.status : null,
  gradingQuestionId: typeof route.query.question_id === 'string' ? route.query.question_id : null,
  gradingResponseId: typeof route.query.response_id === 'string' ? route.query.response_id : null,
}))

// UIUX: UI Variant Switching State (Classic vs Redesigned)
const uiVariant = ref('classic')

function initUiVariant() {
  const urlParams = new URLSearchParams(window.location.search)
  let val = urlParams.get('ui')
  if (val !== 'classic' && val !== 'redesigned') {
    val = localStorage.getItem('dashboard_ui_variant')
  }
  if (val === 'classic' || val === 'redesigned') {
    uiVariant.value = val
  } else {
    uiVariant.value = 'classic' // fallback
  }
  localStorage.setItem('dashboard_ui_variant', uiVariant.value)
}

function setUiVariant(val) {
  if (val === 'classic' || val === 'redesigned') {
    uiVariant.value = val
    localStorage.setItem('dashboard_ui_variant', val)
    
    // Update URL query parameter without full page reload
    const url = new URL(window.location.href)
    url.searchParams.set('ui', val)
    window.history.replaceState(null, '', url.pathname + url.search)
  }
}

// Provide uiVariant to all children (TeacherDashboard, Analytics, Grading, etc.)
provide('uiVariant', uiVariant)

async function checkSession() {
  const { data } = await supabase.auth.getSession()
  session.value = data.session
}

supabase.auth.onAuthStateChange((event, newSession) => {
  session.value = newSession
  if (event === 'PASSWORD_RECOVERY') {
    showUpdatePasswordModal.value = true
  }
  if (newSession) {
    showLoginModal.value = false
  }
})

async function handleLogout() {
  await supabase.auth.signOut()
  session.value = null
}

function handleLoginSuccess(newSession) {
  session.value = newSession
  showLoginModal.value = false
  if (teacherDashboardRef.value) {
    teacherDashboardRef.value.fetchQuestions()
  }
}

onMounted(() => {
  initUiVariant()
  checkSession()
  const hashParams = new URLSearchParams(window.location.hash.substring(1))
  const accessToken = hashParams.get('access_token')
  const type = hashParams.get('type')

  if (accessToken && type === 'recovery') {
    showUpdatePasswordModal.value = true
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
})
</script>

<template>
  <router-view v-if="isStudentRoute" />

  <div v-else :data-ui-variant="uiVariant" class="min-h-screen transition-smooth">
    <!-- ============================================== -->
    <!-- Option A: Redesigned UI -->
    <!-- ============================================== -->
    <template v-if="uiVariant === 'redesigned'">
      <header class="bg-white/80 backdrop-blur-md border-b border-slate-200/80 sticky top-0 z-40 transition-smooth">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 sm:gap-3">
              <div class="p-2 bg-blue-50 text-blue-600 rounded-xl">
                <Trophy class="w-5 h-5 sm:w-6 sm:h-6" />
              </div>
              <div class="flex flex-col">
                <h1 class="text-base sm:text-lg font-bold text-slate-800 tracking-wide font-sans">班級戰情室</h1>
                <span class="text-[10px] sm:text-xs text-slate-400 font-medium">新版</span>
              </div>
            </div>
            
            <div class="flex items-center gap-2.5 sm:gap-4">
              <!-- UI Variant Switcher Segmented Control -->
              <div class="flex items-center bg-slate-100/80 p-0.5 rounded-lg border border-slate-200/40">
                <button 
                  @click="setUiVariant('classic')" 
                  class="px-2.5 py-1 text-[11px] sm:text-xs font-bold rounded-md transition-smooth btn-academic-active"
                  :class="uiVariant === 'classic' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
                >
                  經典版
                </button>
                <button 
                  @click="setUiVariant('redesigned')" 
                  class="px-2.5 py-1 text-[11px] sm:text-xs font-bold rounded-md transition-smooth btn-academic-active"
                  :class="uiVariant === 'redesigned' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
                >
                  新版
                </button>
              </div>

              <!-- Logout / Login -->
              <button
                v-if="session"
                @click="handleLogout"
                class="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 rounded-lg transition-smooth text-xs sm:text-sm font-semibold btn-academic-active"
              >
                <LogOut class="w-4 h-4" />
                <span class="hidden sm:inline">登出工作台</span>
                <span class="sm:hidden">登出</span>
              </button>
              <button
                v-else
                @click="showLoginModal = true"
                class="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-smooth text-xs sm:text-sm font-semibold shadow-sm btn-academic-active"
              >
                <LogIn class="w-4 h-4" />
                <span>教師登入</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main class="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <div v-if="session">
          <TeacherDashboard
            ref="teacherDashboardRef"
            :initial-tab="dashboardLinkState.tab"
            :grading-status="dashboardLinkState.gradingStatus"
            :grading-question-id="dashboardLinkState.gradingQuestionId"
            :grading-response-id="dashboardLinkState.gradingResponseId"
          />
        </div>
        <div v-else class="text-center py-16">
          <div class="bg-white rounded-2xl shadow-academic border border-slate-200/60 p-8 sm:p-12 max-w-md mx-auto transition-smooth">
            <div class="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <BookOpen class="w-8 h-8" />
            </div>
            <h3 class="text-xl font-bold text-slate-800 mb-2">需要教師權限</h3>
            <p class="text-slate-500 text-sm mb-4 leading-relaxed">請先登入工作台以解鎖即時班級戰況與 AI 簡答批改功能。</p>
            <p v-if="dashboardLinkState.tab === 'grading'" class="text-xs text-blue-600 mb-6 bg-blue-50/50 py-2 rounded-lg font-medium">
              💡 登入後將自動引導至簡答批改面板
            </p>
            <button
              @click="showLoginModal = true"
              class="w-full py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold shadow-md shadow-blue-500/10 hover:shadow-blue-500/20 transition-smooth inline-flex items-center justify-center gap-2 btn-academic-active"
            >
              <LogIn class="w-5 h-5" />
              教師登入
            </button>
          </div>
        </div>
      </main>
    </template>

    <!-- ============================================== -->
    <!-- Option B: Classic UI (Green Theme)             -->
    <!-- ============================================== -->
    <template v-else>
      <header class="bg-green-600 text-white shadow-md">
        <div class="max-w-4xl mx-auto px-3 sm:px-4 py-3 sm:py-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-1 sm:gap-2">
              <Trophy class="w-5 h-5 sm:w-6 sm:h-6" />
              <h1 class="text-lg sm:text-xl font-bold truncate max-w-[150px] sm:max-w-none">班級戰情室</h1>
            </div>
            <div class="flex items-center gap-2 sm:gap-3">
              <!-- UI Switcher Pill -->
              <button
                @click="setUiVariant('redesigned')"
                class="flex items-center gap-1 px-2.5 py-1.5 bg-white bg-opacity-20 hover:bg-opacity-35 border border-white border-opacity-30 rounded-lg text-xs font-semibold transition-colors"
              >
                <Layers class="w-3.5 h-3.5" />
                <span>切換新版</span>
              </button>

              <button
                v-if="session"
                @click="handleLogout"
                class="flex items-center gap-1 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 bg-red-500 hover:bg-red-600 rounded-lg transition-colors text-xs sm:text-sm font-medium"
              >
                <LogOut class="w-4 h-4" />
                <span class="hidden sm:inline">登出</span>
              </button>
              <button
                v-else
                @click="showLoginModal = true"
                class="flex items-center gap-1 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-lg transition-colors text-xs sm:text-sm font-medium"
              >
                <LogIn class="w-4 h-4" />
                <span class="hidden sm:inline">教師登入</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main class="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
        <div v-if="session">
          <TeacherDashboard
            ref="teacherDashboardRef"
            :initial-tab="dashboardLinkState.tab"
            :grading-status="dashboardLinkState.gradingStatus"
            :grading-question-id="dashboardLinkState.gradingQuestionId"
            :grading-response-id="dashboardLinkState.gradingResponseId"
          />
        </div>
        <div v-else class="text-center py-12">
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
            <BookOpen class="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 class="text-xl font-semibold text-gray-800 mb-2">需要教師權限</h3>
            <p class="text-gray-600 mb-3">請先登入班級戰情室</p>
            <p v-if="dashboardLinkState.tab === 'grading'" class="text-sm text-indigo-600 mb-6">
              登入後會自動切到簡答批改。
            </p>
            <button
              @click="showLoginModal = true"
              class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors inline-flex items-center gap-2"
            >
              <LogIn class="w-4 h-4" />
              教師登入
            </button>
          </div>
        </div>
      </main>
    </template>

    <LoginModal :show="showLoginModal" @close="showLoginModal = false" @success="handleLoginSuccess" />
    <UpdatePasswordModal :show="showUpdatePasswordModal" @close="showUpdatePasswordModal = false" @success="showUpdatePasswordModal = false" />
  </div>
</template>

<style>
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>
