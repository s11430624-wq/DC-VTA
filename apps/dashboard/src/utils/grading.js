export const SHORT_ANSWER_PASSING_SCORE = 60

export function normalizeShortAnswerScore(value) {
  if (value === null || value === undefined || value === '') return null
  const numericScore = Number(value)
  if (!Number.isFinite(numericScore)) return null
  return Math.max(0, Math.min(100, Math.round(numericScore)))
}

export function deriveShortAnswerCorrectness(score) {
  const normalized = normalizeShortAnswerScore(score)
  if (normalized === null) return null
  return normalized >= SHORT_ANSWER_PASSING_SCORE
}

export function isShortAnswerQuestion(response) {
  return response?.question_bank?.question_type === 'short_answer'
}

export function isSurveyQuestion(response) {
  return response?.question_bank?.question_type === 'survey'
}

export function isPendingShortAnswerResponse(response) {
  return isShortAnswerQuestion(response) && response?.status === 'pending'
}

export function isResponseEligibleForAccuracy(response) {
  if (isSurveyQuestion(response)) {
    return false
  }

  if (isShortAnswerQuestion(response)) {
    return response?.status === 'graded' && normalizeShortAnswerScore(response?.score) !== null
  }

  return typeof response?.is_correct === 'boolean'
}

export function isResponseCountedAsCorrect(response) {
  if (isSurveyQuestion(response)) {
    return false
  }

  if (isShortAnswerQuestion(response)) {
    return deriveShortAnswerCorrectness(response?.score) === true
  }

  return response?.is_correct === true
}
