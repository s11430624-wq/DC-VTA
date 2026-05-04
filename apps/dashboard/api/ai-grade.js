const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemma-3-27b-it'

function stripCodeFences(rawText) {
  const trimmed = String(rawText || '').trim()
  if (!trimmed.startsWith('```')) return trimmed

  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim()
}

function parseGeminiText(data) {
  return data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim() || ''
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

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: '缺少 GEMINI_API_KEY，無法執行 AI 批改。' })
    return
  }

  try {
    const body = await readJsonBody(req)
    const prompt = buildPrompt(body || {})

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 500,
            responseMimeType: 'application/json',
          },
        }),
      },
    )

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text()
      res.status(502).json({ error: `Gemini 批改失敗：${geminiResponse.status} ${errorText}` })
      return
    }

    const geminiPayload = await geminiResponse.json()
    const rawText = parseGeminiText(geminiPayload)
    if (!rawText) {
      res.status(502).json({ error: 'Gemini 沒有回傳批改內容。' })
      return
    }

    const result = parseAiGrade(rawText)
    res.status(200).json(result)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'AI 批改失敗。' })
  }
}
