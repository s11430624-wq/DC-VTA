import { GoogleAuth } from 'google-auth-library';

export type GenerateModelPart =
    | { text: string }
    | {
        inlineData: {
            mimeType: string;
            data: string;
        };
    };

type GenerateTextOptions = {
    model: string;
    prompt?: string;
    parts?: GenerateModelPart[];
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
};

type GeminiResponse = {
    candidates?: Array<{
        content?: {
            parts?: Array<{
                text?: string;
            }>;
        };
    }>;
};

const getProvider = () => (process.env.GEMINI_PROVIDER || 'gemini').toLowerCase();
const getProjectId = () => process.env.GCP_PROJECT_ID;
const getLocation = () => process.env.GCP_LOCATION || 'asia-east1';
const getGeminiApiKey = () => process.env.GEMINI_API_KEY;

const googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const parseResponseText = (data: GeminiResponse) => {
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? '';
};

const parseStreamedText = (raw: string) => {
    const chunks: string[] = [];
    let depth = 0;
    let start = -1;

    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (ch === '{') {
            if (depth === 0) {
                start = i;
            }
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                chunks.push(raw.slice(start, i + 1));
                start = -1;
            }
        }
    }

    const texts: string[] = [];
    for (const chunk of chunks) {
        try {
            const parsed = JSON.parse(chunk) as GeminiResponse;
            const text = parseResponseText(parsed);
            if (text) {
                texts.push(text);
            }
        } catch {
            // Ignore invalid chunk and continue parsing.
        }
    }

    return texts.join('').trim();
};

const buildPartsPayload = (prompt?: string, parts?: GenerateModelPart[]) => {
    if (parts && parts.length > 0) {
        return parts;
    }

    if (prompt?.trim()) {
        return [{ text: prompt }];
    }

    throw new Error('generateModelText 需要 prompt 或 parts');
};

async function callGeminiApi({
    model,
    prompt,
    parts,
    temperature = 0.7,
    maxOutputTokens,
    responseMimeType,
}: GenerateTextOptions): Promise<string> {
    const geminiApiKey = getGeminiApiKey();
    if (!geminiApiKey) {
        throw new Error('缺少 GEMINI_API_KEY');
    }

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: buildPartsPayload(prompt, parts) }],
                generationConfig: {
                    temperature,
                    maxOutputTokens,
                    responseMimeType,
                },
            }),
        },
    );

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API 呼叫失敗：${response.status} ${errorText}`);
    }

    return parseResponseText((await response.json()) as GeminiResponse);
}

async function callVertexApi({
    model,
    prompt,
    parts,
    temperature = 0.7,
    maxOutputTokens,
    responseMimeType,
}: GenerateTextOptions): Promise<string> {
    const projectId = getProjectId();
    const location = getLocation();
    if (!projectId) {
        throw new Error('缺少 GCP_PROJECT_ID');
    }

    const authClient = await googleAuth.getClient();
    const accessToken = await authClient.getAccessToken();
    if (!accessToken.token) {
        throw new Error('無法取得 Vertex AI 存取權杖');
    }

    const isLiveModel = /live/i.test(model);
    const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    const endpoint = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${isLiveModel ? 'streamGenerateContent' : 'generateContent'}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken.token}`,
        },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: buildPartsPayload(prompt, parts) }],
            generationConfig: {
                temperature,
                maxOutputTokens,
                responseMimeType,
            },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vertex AI 呼叫失敗：${response.status} ${errorText}`);
    }

    if (isLiveModel) {
        const streamText = parseStreamedText(await response.text());
        if (streamText) {
            return streamText;
        }
        throw new Error('Vertex Live 模型沒有回傳可解析文字內容。');
    }

    return parseResponseText((await response.json()) as GeminiResponse);
}

export async function generateModelText(options: GenerateTextOptions): Promise<string> {
    if (getProvider() === 'vertex') {
        return callVertexApi(options);
    }
    return callGeminiApi(options);
}
