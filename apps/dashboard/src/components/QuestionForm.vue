<script setup>
import { ref, watch, computed, onMounted } from 'vue'
import { supabase } from '../supabase'
import { Save, X } from 'lucide-vue-next'

const props = defineProps({
  question: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['saved', 'cancel'])

const formData = ref({
  type: 'multiple_choice',
  content: '',
  optionA: '',
  optionB: '',
  optionC: '',
  optionD: '',
  correct: 'A',
  category: '',
  explanation: '',
  rubric: ''
})

const loading = ref(false)
const error = ref('')
const groups = ref([])

// 是否為編輯模式
const isEditMode = computed(() => !!props.question)

// 是否為選擇題
const isMultipleChoice = computed(() => formData.value.type === 'multiple_choice')

onMounted(async () => {
  try {
    const { data, error: err } = await supabase
      .from('groups')
      .select('group_name')
    if (err) throw err
    if (data) {
      groups.value = [...new Set(data.map(g => g.group_name).filter(Boolean))]
    }
  } catch (err) {
    console.error('載入群組失敗:', err.message)
  }
})

// 當傳入 question 時，預填表單（編輯模式）
watch(() => props.question, (newQuestion) => {
  if (newQuestion) {
    formData.value.content = newQuestion.content || ''
    formData.value.category = newQuestion.category || ''
    formData.value.explanation = newQuestion.explanation || ''
    formData.value.rubric = newQuestion.rubric || ''

    // 判斷題型：如果有 rubric 且不為空，設為簡答題
    if (newQuestion.rubric && newQuestion.rubric.trim() !== '') {
      formData.value.type = 'short_answer'
    } else {
      formData.value.type = 'multiple_choice'
    }

    if (newQuestion.metadata) {
      const meta = newQuestion.metadata
      if (meta.options && meta.options.length >= 4) {
        formData.value.optionA = meta.options[0] || ''
        formData.value.optionB = meta.options[1] || ''
        formData.value.optionC = meta.options[2] || ''
        formData.value.optionD = meta.options[3] || ''
      }
      formData.value.correct = meta.correct_answer || 'A'
    }
  } else {
    // 重置表單（新增模式）
    formData.value = {
      type: 'multiple_choice',
      content: '',
      optionA: '',
      optionB: '',
      optionC: '',
      optionD: '',
      correct: 'A',
      category: '',
      explanation: '',
      rubric: ''
    }
  }
  error.value = ''
}, { immediate: true })

async function handleSubmit() {
  // 驗證邏輯：選擇題才需要檢查四個選項
  if (isMultipleChoice.value) {
    if (!formData.value.optionA || !formData.value.optionB ||
        !formData.value.optionC || !formData.value.optionD) {
      error.value = '請填寫所有選項'
      return
    }
  } else {
    // 簡答題可選擇性驗證 rubric
    if (!formData.value.rubric.trim()) {
      error.value = '請填寫 AI 評分標準'
      return
    }
  }

  loading.value = true
  error.value = ''

  // 根據題型構建 payload
  let metadataObj
  let rubricValue

  if (isMultipleChoice.value) {
    metadataObj = {
      topic: formData.value.category,
      options: [
        formData.value.optionA,
        formData.value.optionB,
        formData.value.optionC,
        formData.value.optionD
      ],
      correct_answer: formData.value.correct
    }
    rubricValue = null
  } else {
    metadataObj = {}
    rubricValue = formData.value.rubric
  }

  try {
    if (props.question) {
      // 更新模式
      const { error: updateError } = await supabase
        .from('question_bank')
        .update({
          content: formData.value.content,
          category: formData.value.category,
          explanation: formData.value.explanation,
          metadata: metadataObj,
          rubric: rubricValue,
          question_type: formData.value.type
        })
        .eq('id', props.question.id)

      if (updateError) throw updateError
    } else {
      // 新增模式
      const { error: insertError } = await supabase
        .from('question_bank')
        .insert({
          content: formData.value.content,
          category: formData.value.category,
          explanation: formData.value.explanation,
          metadata: metadataObj,
          rubric: rubricValue,
          question_type: formData.value.type
        })

      if (insertError) throw insertError
    }

    emit('saved')
    // 重置表單（僅在新增模式下）
    if (!props.question) {
      formData.value = {
        type: 'multiple_choice',
        content: '',
        optionA: '',
        optionB: '',
        optionC: '',
        optionD: '',
        correct: 'A',
        category: '',
        explanation: '',
        rubric: ''
      }
    }
  } catch (err) {
    error.value = props.question ? '更新失敗: ' + err.message : '新增失敗: ' + err.message
  } finally {
    loading.value = false
  }
}

function handleCancel() {
  emit('cancel')
}
</script>

<template>
  <div class="bg-white rounded-lg border border-gray-200 p-4 sm:p-6">
    <div class="flex items-center justify-between mb-3 sm:mb-4">
      <h3 class="text-base sm:text-lg font-semibold text-gray-800">
        {{ question ? '編輯題目' : '新增題目' }}
      </h3>
      <button
        @click="handleCancel"
        class="text-gray-400 hover:text-gray-600 transition-colors p-1"
      >
        <X class="w-5 h-5" />
      </button>
    </div>

    <div v-if="error" class="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
      {{ error }}
    </div>

    <form @submit.prevent="handleSubmit" class="space-y-4">

      <!-- ========== 題型選擇 (Segmented Control) ========== -->
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-2">
          題型選擇 <span class="text-red-500">*</span>
        </label>
        <div class="inline-flex rounded-lg border border-gray-300 p-0.5 bg-gray-100"
             :class="{ 'opacity-60 cursor-not-allowed': isEditMode }">
          <button
            type="button"
            @click="!isEditMode && (formData.type = 'multiple_choice')"
            :disabled="isEditMode"
            class="relative px-4 py-2 text-sm font-medium rounded-md transition-all duration-200 focus:outline-none"
            :class="isMultipleChoice
              ? 'bg-white text-green-700 shadow-sm ring-1 ring-gray-200'
              : 'text-gray-500 hover:text-gray-700'"
          >
            📝 選擇題
          </button>
          <button
            type="button"
            @click="!isEditMode && (formData.type = 'short_answer')"
            :disabled="isEditMode"
            class="relative px-4 py-2 text-sm font-medium rounded-md transition-all duration-200 focus:outline-none"
            :class="!isMultipleChoice
              ? 'bg-white text-purple-700 shadow-sm ring-1 ring-purple-200'
              : 'text-gray-500 hover:text-gray-700'"
          >
            ✍️ 簡答題
          </button>
        </div>
        <p v-if="isEditMode" class="mt-1 text-xs text-gray-400">編輯模式下無法更改題型</p>
      </div>

      <!-- ========== 題目內容 ========== -->
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          題目內容 (選填)
        </label>
        <textarea
          v-model="formData.content"
          rows="3"
          placeholder="請輸入題目內容（可留空）..."
          class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition resize-none"
          :disabled="loading"
        />
      </div>

      <!-- ========== 選擇題區塊 ========== -->
      <template v-if="isMultipleChoice">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              選項 A <span class="text-red-500">*</span>
            </label>
            <input
              v-model="formData.optionA"
              type="text"
              placeholder="選項 A"
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
              :disabled="loading"
              required
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              選項 B <span class="text-red-500">*</span>
            </label>
            <input
              v-model="formData.optionB"
              type="text"
              placeholder="選項 B"
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
              :disabled="loading"
              required
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              選項 C <span class="text-red-500">*</span>
            </label>
            <input
              v-model="formData.optionC"
              type="text"
              placeholder="選項 C"
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
              :disabled="loading"
              required
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              選項 D <span class="text-red-500">*</span>
            </label>
            <input
              v-model="formData.optionD"
              type="text"
              placeholder="選項 D"
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
              :disabled="loading"
              required
            />
          </div>
        </div>
      </template>

      <!-- ========== 簡答題區塊 ========== -->
      <div v-if="!isMultipleChoice"
           class="bg-purple-50 border border-purple-200 rounded-lg p-4">
        <label class="block text-sm font-medium text-purple-800 mb-1">
          🤖 AI 評分標準 (Rubric) <span class="text-red-500">*</span>
        </label>
        <p class="text-xs text-purple-500 mb-2">
          請描述 AI 批改時的評分依據
        </p>
        <textarea
          v-model="formData.rubric"
          rows="5"
          placeholder=""
          class="w-full px-4 py-2 border border-purple-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none transition resize-none bg-white"
          :disabled="loading"
        />
      </div>

      <!-- ========== 正確答案 + 分類 ========== -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div v-if="isMultipleChoice">
          <label class="block text-sm font-medium text-gray-700 mb-1">
            正確答案 <span class="text-red-500">*</span>
          </label>
          <select
            v-model="formData.correct"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
            :disabled="loading"
            required
          >
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="D">D</option>
          </select>
        </div>
        <div :class="{ 'sm:col-span-2': !isMultipleChoice }">
          <label class="block text-sm font-medium text-gray-700 mb-1">
            分類
          </label>
          <select
            v-model="formData.category"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition"
            :disabled="loading"
          >
            <option value="">請選擇分類 (班級)...</option>
            <option v-for="name in groups" :key="name" :value="name">
              {{ name }}
            </option>
          </select>
        </div>
      </div>

      <!-- ========== 解釋說明 ========== -->
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          解釋說明
        </label>
        <textarea
          v-model="formData.explanation"
          rows="2"
          placeholder="題目的解釋說明（選填）"
          class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition resize-none"
          :disabled="loading"
        />
      </div>

      <!-- ========== 操作按鈕 ========== -->
      <div class="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 pt-2">
        <button
          type="button"
          @click="handleCancel"
          class="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          :disabled="loading"
        >
          取消
        </button>
        <button
          type="submit"
          class="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          :disabled="loading"
        >
          <Save class="w-4 h-4" />
          {{ loading ? '處理中...' : (question ? '更新題目' : '新增題目') }}
        </button>
      </div>
    </form>
  </div>
</template>
