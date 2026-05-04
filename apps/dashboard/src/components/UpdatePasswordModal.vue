<script setup>
import { ref } from 'vue'
import { supabase } from '../supabase'
import { Key, X, CheckCircle2 } from 'lucide-vue-next'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'success'])

const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const success = ref(false)

async function handleUpdatePassword() {
  // 驗證
  if (!newPassword.value) {
    error.value = '請輸入新密碼'
    return
  }

  if (newPassword.value.length < 6) {
    error.value = '密碼長度至少需要 6 個字元'
    return
  }

  if (newPassword.value !== confirmPassword.value) {
    error.value = '兩次輸入的密碼不一致'
    return
  }

  loading.value = true
  error.value = ''

  try {
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword.value
    })

    if (updateError) {
      error.value = '更新密碼失敗: ' + updateError.message
      loading.value = false
    } else {
      success.value = true
      // 2 秒後關閉模態框
      setTimeout(() => {
        handleClose()
        emit('success')
      }, 2000)
    }
  } catch (err) {
    error.value = '更新密碼失敗: ' + err.message
    loading.value = false
  }
}

function handleClose() {
  newPassword.value = ''
  confirmPassword.value = ''
  error.value = ''
  success.value = false
  loading.value = false
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
            <Key class="w-5 h-5 text-green-600" />
            <h2 class="text-xl font-bold text-gray-800">更新密碼</h2>
          </div>
          <button
            @click="handleClose"
            class="text-gray-400 hover:text-gray-600 transition-colors"
            :disabled="loading"
          >
            <X class="w-5 h-5" />
          </button>
        </div>

        <div class="p-6 space-y-4">
          <!-- 成功訊息 -->
          <div
            v-if="success"
            class="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded flex items-center gap-2"
          >
            <CheckCircle2 class="w-5 h-5 flex-shrink-0" />
            <div>
              <p class="font-semibold">密碼更新成功！</p>
              <p class="text-sm mt-1">正在關閉視窗...</p>
            </div>
          </div>

          <!-- 錯誤訊息 -->
          <div v-if="error && !success" class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {{ error }}
          </div>

          <!-- 表單 -->
          <div v-if="!success" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                新密碼 <span class="text-red-500">*</span>
              </label>
              <input
                v-model="newPassword"
                type="password"
                placeholder="請輸入新密碼（至少 6 個字元）"
                class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
                :disabled="loading"
                @keyup.enter="handleUpdatePassword"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                確認密碼 <span class="text-red-500">*</span>
              </label>
              <input
                v-model="confirmPassword"
                type="password"
                placeholder="請再次輸入新密碼"
                class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
                :disabled="loading"
                @keyup.enter="handleUpdatePassword"
              />
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
                @click="handleUpdatePassword"
                class="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="loading"
              >
                {{ loading ? '更新中...' : '更新密碼' }}
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
