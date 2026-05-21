import { GoogleAuth } from 'google-auth-library'

const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview'
const DEFAULT_LOCATION = process.env.GCP_LOCATION || 'asia-east1'
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/cloud-platform']
const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.AI_GRADING_MAX_OUTPUT_TOKENS || 1024)

function createGoogleAuth() {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  if (credentialsJson) {
    try {
      const credentials = JSON.parse(credentialsJson)
      return new GoogleAuth({
        scopes: GOOGLE_SCOPES,
        credentials,
      })
    } catch (error) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS_JSON 格式錯誤：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return new GoogleAuth({
    scopes: GOOGLE_SCOPES,
  })
}

function stripCodeFences(rawText) {
  const trimmed = String(rawText || '').trim()
  if (!trimmed.startsWith('```')) return trimmed

  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim()
}

function parseGeminiText(data) {
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim() || ''

  if (text) {
    return text
  }

  const finishReason = data?.candidates?.[0]?.finishReason
  const blockReason = data?.promptFeedback?.blockReason
  if (finishReason || blockReason) {
    throw new Error(`Vertex AI 無內容回覆（finishReason=${finishReason || 'unknown'}, blockReason=${blockReason || 'none'}）`)
  }

  return ''
}

const shouldRetryForNoVisibleText = (error) =>
  error instanceof Error && /finishReason=MAX_TOKENS/i.test(error.message)

async function requestVertexGrade({ endpoint, accessToken, prompt, maxOutputTokens, withThinkingConfig }) {
  const generationConfig = {
    temperature: 0.2,
    maxOutputTokens,
  }

  if (withThinkingConfig) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig,
    }),
  })
}

function parseAiGrade(rawText) {
  const parsed = JSON.parse(stripCodeFences(rawText))
  const numericScore = Number(parsed?.score)

  if (!Number.isFinite(numericScore)) {
    throw new Error('AI 批改結果缺少有效分數。')
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(numericScore))),
    feedback: typeof parsed?.feedback === 'string' ? parsed.feedback.trim() : '',
  }
}

function buildPrompt({ questionId, responseId, questionContent, rubric, answerText }) {
  return [
    '你是嚴謹的短答題批改助教。',
    '請根據題目內容、評分規準與學生答案進行評分。',
    '一律使用繁體中文。',
    '分數必須是 0 到 100 的整數。',
    'feedback 請精簡但具體，說明答對重點與缺漏，控制在 2 到 4 句。',
    '只輸出 JSON，不要輸出 Markdown。',
    'JSON 格式必須是 {"score": 85, "feedback": "..."}。',
    '',
    `question_id: ${questionId ?? 'unknown'}`,
    `response_id: ${responseId ?? 'unknown'}`,
    '題目內容：',
    questionContent || '（未提供題目內容）',
    '',
    '評分規準：',
    rubric || '（未提供評分規準，請依題目內容保守評分）',
    '',
    '學生答案：',
    answerText || '（空白作答）',
  ].join('\n')
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body
  }

  return new Promise((resolve, reject) => {
    let rawBody = ''
    req.on('data', (chunk) => {
      rawBody += chunk
    })
    req.on('end', () => {
      if (!rawBody) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(rawBody))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!process.env.GCP_PROJECT_ID) {
    res.status(500).json({ error: '缺少 GCP_PROJECT_ID，無法執行 AI 批改。' })
    return
  }

  try {
    const body = await readJsonBody(req)
    const prompt = buildPrompt(body || {})

    const authClient = await createGoogleAuth().getClient()
    const accessToken = await authClient.getAccessToken()
    if (!accessToken.token) {
      res.status(500).json({ error: '無法取得 Vertex AI 存取權杖。' })
      return
    }

    const host = DEFAULT_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${DEFAULT_LOCATION}-aiplatform.googleapis.com`
    const endpoint = `https://${host}/v1/projects/${process.env.GCP_PROJECT_ID}/locations/${DEFAULT_LOCATION}/publishers/google/models/${DEFAULT_GEMINI_MODEL}:generateContent`
    let geminiResponse = await requestVertexGrade({
      endpoint,
      accessToken: accessToken.token,
      prompt,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      withThinkingConfig: true,
    })

    if (!geminiResponse.ok) {
      const maybeThinkingConfigError = await geminiResponse.text()
      if (/thinkingconfig|thinking_budget|unknown name/i.test(maybeThinkingConfigError)) {
        geminiResponse = await requestVertexGrade({
          endpoint,
          accessToken: accessToken.token,
          prompt,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          withThinkingConfig: false,
        })
      } else {
        res.status(502).json({ error: `Vertex AI 批改失敗：${geminiResponse.status} ${maybeThinkingConfigError}` })
        return
      }
    }

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text()
      res.status(502).json({ error: `Vertex AI 批改失敗：${geminiResponse.status} ${errorText}` })
      return
    }

    const geminiPayload = await geminiResponse.json()
    let rawText
    try {
      rawText = parseGeminiText(geminiPayload)
    } catch (error) {
      if (!shouldRetryForNoVisibleText(error)) {
        throw error
      }

      const retryResponse = await requestVertexGrade({
        endpoint,
        accessToken: accessToken.token,
        prompt,
        maxOutputTokens: Math.max(DEFAULT_MAX_OUTPUT_TOKENS, 2048),
        withThinkingConfig: true,
      })

      if (!retryResponse.ok) {
        const retryErrorText = await retryResponse.text()
        res.status(502).json({ error: `Vertex AI 重試批改失敗：${retryResponse.status} ${retryErrorText}` })
        return
      }

      const retryPayload = await retryResponse.json()
      rawText = parseGeminiText(retryPayload)
    }
    if (!rawText) {
      res.status(502).json({ error: 'Vertex AI 沒有回傳批改內容。' })
      return
    }

    const result = parseAiGrade(rawText)
    res.status(200).json(result)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'AI 批改失敗。' })
  }
}
