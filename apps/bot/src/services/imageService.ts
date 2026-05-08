import { GoogleAuth } from 'google-auth-library';

type GenerateImageResult = {
    bytes: Buffer;
    mimeType: string;
};

const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const getProjectId = () => process.env.GCP_PROJECT_ID;
const getImageModel = () => process.env.IMAGE_MODEL || 'nano-banana-2';
const getImageLocation = () => process.env.IMAGE_LOCATION || 'us-central1';

const resolveCandidateModels = (model: string) => {
    const normalized = model.trim().toLowerCase();
    if (normalized !== 'nano-banana-2') {
        return [model];
    }

    // Nano Banana 2 is a product name; try known Gemini image IDs in order.
    return [
        'gemini-3.1-flash-image',
        'gemini-3.1-flash-image-preview',
        'gemini-3.1-flash-image-preview-04-2026',
        'imagen-4.0-generate-001',
    ];
};

const resolveCandidateLocations = (location: string) => {
    const candidates = [location];
    if (location !== 'global') candidates.push('global');
    if (location !== 'us-central1') candidates.push('us-central1');
    return [...new Set(candidates)];
};

const pickBase64Image = (prediction: unknown): string | null => {
    if (!prediction || typeof prediction !== 'object') return null;
    const record = prediction as Record<string, unknown>;

    const direct = record.bytesBase64Encoded;
    if (typeof direct === 'string' && direct.length > 0) return direct;

    const nested = record.image;
    if (nested && typeof nested === 'object') {
        const nestedRecord = nested as Record<string, unknown>;
        const nestedBytes = nestedRecord.bytesBase64Encoded;
        if (typeof nestedBytes === 'string' && nestedBytes.length > 0) return nestedBytes;
    }

    return null;
};

export async function generateImageFromPrompt(prompt: string): Promise<GenerateImageResult> {
    const projectId = getProjectId();
    if (!projectId) {
        throw new Error('缺少 GCP_PROJECT_ID');
    }

    const configuredModel = getImageModel();
    const configuredLocation = getImageLocation();
    const candidateModels = resolveCandidateModels(configuredModel);
    const candidateLocations = resolveCandidateLocations(configuredLocation);

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    if (!accessToken.token) {
        throw new Error('無法取得 Vertex AI 存取權杖');
    }

    let lastError = '無可用錯誤訊息';
    for (const location of candidateLocations) {
        const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
        for (const model of candidateModels) {
            const endpoint = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    instances: [{ prompt }],
                    parameters: {
                        sampleCount: 1,
                    },
                }),
            });

            const text = await response.text();
            if (!response.ok) {
                lastError = `model=${model}, location=${location}, status=${response.status}, body=${text}`;
                continue;
            }

            const data = JSON.parse(text) as { predictions?: unknown[] };
            const firstPrediction = data.predictions?.[0];
            const base64 = pickBase64Image(firstPrediction);
            if (!base64) {
                lastError = `model=${model}, location=${location}, status=200 but missing bytesBase64Encoded`;
                continue;
            }

            return {
                bytes: Buffer.from(base64, 'base64'),
                mimeType: 'image/png',
            };
        }
    }

    throw new Error(`圖片生成失敗：${lastError}`);
}
