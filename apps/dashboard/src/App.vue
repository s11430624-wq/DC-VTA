<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from './supabase'
import TeacherDashboard from './components/TeacherDashboard.vue'
import LoginModal from './components/LoginModal.vue'
import UpdatePasswordModal from './components/UpdatePasswordModal.vue'
import { LogOut, LogIn, Trophy, BookOpen } from 'lucide-vue-next'

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

  <div v-else class="min-h-screen bg-gray-50">
    <header class="bg-green-600 text-white shadow-md">
      <div class="max-w-4xl mx-auto px-3 sm:px-4 py-3 sm:py-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1 sm:gap-2">
            <Trophy class="w-5 h-5 sm:w-6 sm:h-6" />
            <h1 class="text-lg sm:text-xl font-bold truncate max-w-[150px] sm:max-w-none">班級戰情室</h1>
          </div>
          <div class="flex items-center gap-2 sm:gap-3">
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
