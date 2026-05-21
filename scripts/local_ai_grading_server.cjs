const http = require('http');
const { GoogleAuth } = require('google-auth-library');

const host = process.env.LOCAL_AI_GRADING_HOST || '127.0.0.1';
const port = Number(process.env.LOCAL_AI_GRADING_PORT || 8787);
const geminiModel = process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';
const gcpProjectId = process.env.GCP_PROJECT_ID;
const gcpLocation = process.env.GCP_LOCATION || 'asia-east1';
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const defaultMaxOutputTokens = Number(process.env.AI_GRADING_MAX_OUTPUT_TOKENS || 1024);

const createGoogleAuth = () => {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (credentialsJson) {
        try {
            const credentials = JSON.parse(credentialsJson);
            return new GoogleAuth({
                scopes: GOOGLE_SCOPES,
                credentials,
            });
        } catch (error) {
            throw new Error(`GOOGLE_APPLICATION_CREDENTIALS_JSON 格式錯誤：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return new GoogleAuth({
        scopes: GOOGLE_SCOPES,
    });
};

function stripCodeFences(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed.startsWith('```')) {
        return trimmed;
    }

    return trimmed
        .replace(/^```[a-zA-Z]*\s*/, '')
        .replace(/\s*```$/, '')
        .trim();
}

function parseGeminiText(data) {
    const text = data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || '')
        .join('')
        .trim() || '';

    if (text) {
        return text;
    }

    const finishReason = data?.candidates?.[0]?.finishReason;
    const blockReason = data?.promptFeedback?.blockReason;
    if (finishReason || blockReason) {
        throw new Error(`Vertex AI 無內容回覆（finishReason=${finishReason || 'unknown'}, blockReason=${blockReason || 'none'}）`);
    }

    return '';
}

const shouldRetryForNoVisibleText = (error) =>
    error instanceof Error && /finishReason=MAX_TOKENS/i.test(error.message);

async function requestVertexGrade({ endpoint, accessToken, prompt, maxOutputTokens, withThinkingConfig }) {
    const generationConfig = {
        temperature: 0.2,
        maxOutputTokens,
    };

    if (withThinkingConfig) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
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
    });
}

function parseAiGrade(rawText) {
    const parsed = JSON.parse(stripCodeFences(rawText));
    const numericScore = Number(parsed?.score);

    if (!Number.isFinite(numericScore)) {
        throw new Error('AI 批改結果缺少有效分數。');
    }

    return {
        score: Math.max(0, Math.min(100, Math.round(numericScore))),
        feedback: typeof parsed?.feedback === 'string' ? parsed.feedback.trim() : '',
    };
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
    ].join('\n');
}

async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let rawBody = '';
        req.on('data', (chunk) => {
            rawBody += chunk;
        });
        req.on('end', () => {
            if (!rawBody) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(rawBody));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function writeJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(payload));
}

async function handleAiGrade(req, res) {
    if (!gcpProjectId) {
        writeJson(res, 500, { error: '缺少 GCP_PROJECT_ID，無法執行 AI 批改。' });
        return;
    }

    try {
        const body = await readJsonBody(req);
        const prompt = buildPrompt(body || {});

        const authClient = await createGoogleAuth().getClient();
        const accessToken = await authClient.getAccessToken();
        if (!accessToken.token) {
            writeJson(res, 500, { error: '無法取得 Vertex AI 存取權杖。' });
            return;
        }

        const host = gcpLocation === 'global' ? 'aiplatform.googleapis.com' : `${gcpLocation}-aiplatform.googleapis.com`;
        const endpoint = `https://${host}/v1/projects/${gcpProjectId}/locations/${gcpLocation}/publishers/google/models/${geminiModel}:generateContent`;
        let geminiResponse = await requestVertexGrade({
            endpoint,
            accessToken: accessToken.token,
            prompt,
            maxOutputTokens: defaultMaxOutputTokens,
            withThinkingConfig: true,
        });

        if (!geminiResponse.ok) {
            const maybeThinkingConfigError = await geminiResponse.text();
            if (/thinkingconfig|thinking_budget|unknown name/i.test(maybeThinkingConfigError)) {
                geminiResponse = await requestVertexGrade({
                    endpoint,
                    accessToken: accessToken.token,
                    prompt,
                    maxOutputTokens: defaultMaxOutputTokens,
                    withThinkingConfig: false,
                });
            } else {
                writeJson(res, 502, { error: `Vertex AI 批改失敗：${geminiResponse.status} ${maybeThinkingConfigError}` });
                return;
            }
        }

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            writeJson(res, 502, { error: `Vertex AI 批改失敗：${geminiResponse.status} ${errorText}` });
            return;
        }

        const geminiPayload = await geminiResponse.json();
        let rawText;
        try {
            rawText = parseGeminiText(geminiPayload);
        } catch (error) {
            if (!shouldRetryForNoVisibleText(error)) {
                throw error;
            }

            const retryResponse = await requestVertexGrade({
                endpoint,
                accessToken: accessToken.token,
                prompt,
                maxOutputTokens: Math.max(defaultMaxOutputTokens, 2048),
                withThinkingConfig: true,
            });

            if (!retryResponse.ok) {
                const retryErrorText = await retryResponse.text();
                writeJson(res, 502, { error: `Vertex AI 重試批改失敗：${retryResponse.status} ${retryErrorText}` });
                return;
            }

            const retryPayload = await retryResponse.json();
            rawText = parseGeminiText(retryPayload);
        }
        if (!rawText) {
            writeJson(res, 502, { error: 'Vertex AI 沒有回傳批改內容。' });
            return;
        }

        writeJson(res, 200, parseAiGrade(rawText));
    } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : 'AI 批改失敗。' });
    }
}

function createServer() {
    return http.createServer(async (req, res) => {
        if (!req.url) {
            writeJson(res, 404, { error: 'Not found' });
            return;
        }

        if (req.method === 'OPTIONS') {
            writeJson(res, 204, {});
            return;
        }

        if (req.method === 'GET' && req.url === '/health') {
            writeJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && req.url === '/api/ai-grade') {
            await handleAiGrade(req, res);
            return;
        }

        writeJson(res, 404, { error: 'Not found' });
    });
}

function main() {
    const server = createServer();
    server.listen(port, host, () => {
        console.log(`✅ Local AI grading server ready at http://${host}:${port}/api/ai-grade`);
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    createServer,
};
