const DEFAULT_AI_GRADING_URL = '/api/ai-grade'

function normalizePayload(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('AI 批改服務回傳格式錯誤。')
  }

  const numericScore = Number(data.score)
  if (!Number.isFinite(numericScore)) {
    throw new Error('AI 批改服務沒有回傳有效分數。')
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(numericScore))),
    feedback: typeof data.feedback === 'string' ? data.feedback.trim() : '',
  }
}

export async function requestAiGrade(payload) {
  const endpoint = import.meta.env.VITE_AI_GRADING_API_URL || DEFAULT_AI_GRADING_URL
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  let responseBody = null
  try {
    responseBody = await response.json()
  } catch {
    responseBody = null
  }

  if (!response.ok) {
    const message = responseBody?.error || 'AI 批改服務暫時不可用。'
    throw new Error(message)
  }

  return normalizePayload(responseBody)
}
