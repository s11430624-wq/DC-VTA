<script setup>
import { ref } from 'vue'
import { supabase } from '../supabase'
import { Lock, X, Mail } from 'lucide-vue-next'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'success'])

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')
const showForgotPassword = ref(false)
const resetEmail = ref('')
const resetLoading = ref(false)
const resetError = ref('')
const resetSuccess = ref(false)

async function handleLogin() {
  if (!email.value || !password.value) {
    error.value = '請輸入帳號和密碼'
    return
  }

  loading.value = true
  error.value = ''

  const { data, error: authError } = await supabase.auth.signInWithPassword({
    email: email.value,
    password: password.value,
  })

  if (authError) {
    error.value = '登入失敗: ' + authError.message
    loading.value = false
  } else {
    emit('success', data.session)
    // 重置表單
    email.value = ''
    password.value = ''
    error.value = ''
    loading.value = false
  }
}

async function handleForgotPassword() {
  if (!resetEmail.value) {
    resetError.value = '請輸入電子郵件地址'
    return
  }

  resetLoading.value = true
  resetError.value = ''
  resetSuccess.value = false

  try {
    const { error: authError } = await supabase.auth.resetPasswordForEmail(
      resetEmail.value,
      {
        redirectTo: `${window.location.origin}`
      }
    )

    if (authError) {
      resetError.value = '發送重置郵件失敗: ' + authError.message
      resetLoading.value = false
    } else {
      resetSuccess.value = true
      resetLoading.value = false
    }
  } catch (err) {
    resetError.value = '發送重置郵件失敗: ' + err.message
    resetLoading.value = false
  }
}

function switchToForgotPassword() {
  showForgotPassword.value = true
  error.value = ''
  password.value = ''
}

function switchToLogin() {
  showForgotPassword.value = false
  resetEmail.value = ''
  resetError.value = ''
  resetSuccess.value = false
}

function handleClose() {
  email.value = ''
  password.value = ''
  error.value = ''
  showForgotPassword.value = false
  resetEmail.value = ''
  resetError.value = ''
  resetSuccess.value = false
  resetLoading.value = false
  emit('close')
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="show"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4"
      @click.self="handleClose"
    >
      <div class="bg-white rounded-lg shadow-xl w-full max-w-md transform transition-all">
        <div class="flex items-center justify-between p-6 border-b border-gray-200">
          <div class="flex items-center gap-2">
            <Lock class="w-5 h-5 text-green-600" />
            <h2 class="text-xl font-bold text-gray-800">教師專用登入</h2>
          </div>
          <button
            @click="handleClose"
            class="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X class="w-5 h-5" />
          </button>
        </div>

        <div class="p-6 space-y-4">
          <!-- 登入表單 -->
          <div v-if="!showForgotPassword">
            <div v-if="error" class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
              {{ error }}
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                電子郵件
              </label>
              <input
                v-model="email"
                type="email"
                placeholder="teacher@example.com"
                class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
                :disabled="loading"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                密碼
              </label>
              <input
                v-model="password"
                type="password"
                placeholder="••••••••"
                class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
                :disabled="loading"
                @keyup.enter="handleLogin"
              />
            </div>

            <div class="flex justify-end">
              <button
                @click="switchToForgotPassword"
                class="text-sm text-green-600 hover:text-green-700 hover:underline"
                :disabled="loading"
              >
                忘記密碼？
              </button>
            </div>

            <div class="flex gap-3 pt-2">
              <button
                @click="handleClose"
                class="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                :disabled="loading"
              >
                取消
              </button>
              <button
                @click="handleLogin"
                class="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="loading"
              >
                {{ loading ? '驗證中...' : '登入' }}
              </button>
            </div>
          </div>

          <!-- 忘記密碼表單 -->
          <div v-else>
            <div v-if="resetSuccess" class="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded mb-4">
              <div class="flex items-center gap-2">
                <Mail class="w-5 h-5" />
                <div>
                  <p class="font-semibold">重置郵件已發送！</p>
                  <p class="text-sm mt-1">請檢查您的電子郵件信箱，點擊重置鏈接來更新密碼。</p>
                </div>
              </div>
            </div>

            <div v-if="resetError" class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
              {{ resetError }}
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                電子郵件
              </label>
              <input
                v-model="resetEmail"
                type="email"
                placeholder="teacher@example.com"
                class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
                :disabled="resetLoading || resetSuccess"
                @keyup.enter="handleForgotPassword"
              />
              <p class="text-xs text-gray-500 mt-1">
                我們將發送密碼重置鏈接到此電子郵件地址
              </p>
            </div>

            <div class="flex gap-3 pt-2">
              <button
                @click="switchToLogin"
                class="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                :disabled="resetLoading"
              >
                返回登入
              </button>
              <button
                @click="handleForgotPassword"
                class="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="resetLoading || resetSuccess"
              >
                {{ resetLoading ? '發送中...' : (resetSuccess ? '已發送' : '發送重置郵件') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
