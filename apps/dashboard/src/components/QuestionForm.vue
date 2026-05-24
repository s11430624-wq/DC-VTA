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
  rubric: '',
  imageUrlInput: '',
  imageUrls: [],
  allowRepeatAnswer: false
})

const loading = ref(false)
const uploadingImage = ref(false)
const error = ref('')
const groups = ref([])
const QUESTION_IMAGE_BUCKET = (import.meta.env.VITE_QUESTION_IMAGE_BUCKET || 'question-images').trim()

// 是否為編輯模式
const isEditMode = computed(() => !!props.question)

// 是否為選擇題
const isMultipleChoice = computed(() => formData.value.type === 'multiple_choice')
const isShortAnswer = computed(() => formData.value.type === 'short_answer')
const isSurvey = computed(() => formData.value.type === 'survey')

function parseQuestionMetadata(metadata) {
  if (!metadata) return {}
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return metadata
}

function parseImageUrlsFromInput(input) {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line))
}

function getAllImageUrls() {
  const fromInput = parseImageUrlsFromInput(formData.value.imageUrlInput || '')
  const merged = [...formData.value.imageUrls, ...fromInput].map((item) => item.trim())
  return [...new Set(merged)].filter((item) => /^https?:\/\//i.test(item))
}

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
    formData.value.imageUrlInput = ''
    formData.value.imageUrls = []
    formData.value.allowRepeatAnswer = false

    formData.value.type = ['multiple_choice', 'short_answer', 'survey'].includes(newQuestion.question_type)
      ? newQuestion.question_type
      : ((newQuestion.rubric && newQuestion.rubric.trim() !== '') ? 'short_answer' : 'multiple_choice')

    if (newQuestion.metadata) {
      const meta = parseQuestionMetadata(newQuestion.metadata)
      if (meta.options && meta.options.length >= 4) {
        formData.value.optionA = meta.options[0] || ''
        formData.value.optionB = meta.options[1] || ''
        formData.value.optionC = meta.options[2] || ''
        formData.value.optionD = meta.options[3] || ''
      }
      formData.value.correct = meta.correct_answer || 'A'
      const metaImageUrls = Array.isArray(meta.image_urls) ? meta.image_urls.filter((url) => typeof url === 'string') : []
      const fallbackImageUrl = typeof meta.image_url === 'string' ? [meta.image_url] : []
      formData.value.imageUrls = [...new Set([...metaImageUrls, ...fallbackImageUrl].map((url) => url.trim()).filter(Boolean))]
      formData.value.imageUrlInput = formData.value.imageUrls.join('\n')
      formData.value.allowRepeatAnswer = Boolean(meta.allow_repeat_answer)
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
      rubric: '',
      imageUrlInput: '',
      imageUrls: [],
      allowRepeatAnswer: false
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
  } else if (isShortAnswer.value) {
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
  const allImageUrls = getAllImageUrls()

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
    if (allImageUrls.length > 0) {
      metadataObj.image_urls = allImageUrls
      metadataObj.image_url = allImageUrls[0]
    }
    rubricValue = null
  } else if (isShortAnswer.value) {
    metadataObj = allImageUrls.length > 0
      ? { image_urls: allImageUrls, image_url: allImageUrls[0] }
      : {}
    rubricValue = formData.value.rubric
  } else {
    metadataObj = {
      allow_repeat_answer: formData.value.allowRepeatAnswer
    }
    if (allImageUrls.length > 0) {
      metadataObj.image_urls = allImageUrls
      metadataObj.image_url = allImageUrls[0]
    }
    rubricValue = null
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
        rubric: '',
        imageUrlInput: '',
        imageUrls: [],
        allowRepeatAnswer: false
      }
    }
  } catch (err) {
    error.value = props.question ? '更新失敗: ' + err.message : '新增失敗: ' + err.message
  } finally {
    loading.value = false
  }
}

function sanitizeFileName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
}

async function handleImageFileChange(event) {
  const input = event?.target
  const files = [...(input?.files || [])]
  if (files.length === 0) return

  try {
    const maxBytes = 10 * 1024 * 1024
    for (const file of files) {
      const isImage = file.type.startsWith('image/')
      if (!isImage) {
        throw new Error('只支援圖片檔（PNG、JPG、GIF、WEBP）。')
      }
      if (file.size > maxBytes) {
        throw new Error('圖片大小不可超過 10MB。')
      }
    }

    error.value = ''
    uploadingImage.value = true
    const uploadedUrls = []

    for (const file of files) {
      const extension = (file.name.split('.').pop() || 'png').toLowerCase()
      const baseName = sanitizeFileName(file.name.replace(/\.[^.]+$/, ''))
      const filePath = `question-images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${baseName}.${extension}`

      const { error: uploadError } = await supabase
        .storage
        .from(QUESTION_IMAGE_BUCKET)
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: false
        })

      if (uploadError) {
        throw uploadError
      }

      const { data } = supabase
        .storage
        .from(QUESTION_IMAGE_BUCKET)
        .getPublicUrl(filePath)

      if (!data?.publicUrl) {
        throw new Error('無法取得公開圖片網址')
      }
      uploadedUrls.push(data.publicUrl)
    }

    formData.value.imageUrls = [...new Set([...formData.value.imageUrls, ...uploadedUrls])]
    formData.value.imageUrlInput = formData.value.imageUrls.join('\n')
  } catch (err) {
    error.value = `圖片上傳失敗：${err.message || '請確認 Storage bucket 與權限設定'}`
  } finally {
    uploadingImage.value = false
    input.value = ''
  }
}

function removeImageUrl(index) {
  const next = [...formData.value.imageUrls]
  next.splice(index, 1)
  formData.value.imageUrls = next
  formData.value.imageUrlInput = next.join('\n')
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
          <button
            type="button"
            @click="!isEditMode && (formData.type = 'survey')"
            :disabled="isEditMode"
            class="relative px-4 py-2 text-sm font-medium rounded-md transition-all duration-200 focus:outline-none"
            :class="isSurvey
              ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-200'
              : 'text-gray-500 hover:text-gray-700'"
          >
            📋 問卷題
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

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          題目圖片 URL（每行一張，選填）
        </label>
        <textarea
          v-model="formData.imageUrlInput"
          rows="3"
          placeholder="https://...&#10;https://..."
          class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition resize-none"
          :disabled="loading || uploadingImage"
        />
        <div class="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
          <label class="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg bg-white hover:bg-gray-50 cursor-pointer text-sm text-gray-700 transition-colors"
                 :class="{ 'opacity-60 cursor-not-allowed': loading || uploadingImage }">
            <input
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
              class="hidden"
              multiple
              :disabled="loading || uploadingImage"
              @change="handleImageFileChange"
            />
            <span>{{ uploadingImage ? '上傳中...' : '添加圖片' }}</span>
          </label>
          <span class="text-xs text-gray-400">支援 PNG/JPG/GIF/WEBP，最大 10MB</span>
        </div>
        <p class="mt-1 text-xs text-gray-400">可直接貼多行網址，或用上方按鈕一次上傳多張。</p>
        <div v-if="formData.imageUrls.length > 0" class="mt-3 flex flex-wrap gap-2">
          <div
            v-for="(url, idx) in formData.imageUrls"
            :key="url"
            class="inline-flex items-center gap-2 text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded"
          >
            <span class="max-w-[220px] truncate">{{ url }}</span>
            <button type="button" class="text-red-500" @click="removeImageUrl(idx)">移除</button>
          </div>
        </div>
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
      <div v-if="isShortAnswer"
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

      <!-- ========== 問卷題區塊 ========== -->
      <div v-if="isSurvey"
           class="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
        <label class="inline-flex items-center gap-2 text-sm font-medium text-indigo-800">
          <input
            v-model="formData.allowRepeatAnswer"
            type="checkbox"
            class="w-4 h-4"
            :disabled="loading"
          />
          允許同一位學生重複提交問卷
        </label>
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
      <div v-if="!isSurvey">
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
