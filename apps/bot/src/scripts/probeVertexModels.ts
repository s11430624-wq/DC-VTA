import 'dotenv/config';
import { GoogleAuth } from 'google-auth-library';

type ProbeResult = {
    region: string;
    model: string;
    method: 'generateContent' | 'streamGenerateContent';
    ok: boolean;
    status: number;
    message: string;
};

const projectId = process.env.GCP_PROJECT_ID;
const regions = (process.env.PROBE_REGIONS || 'us-central1,asia-east1,europe-central2,global')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const models = (process.env.PROBE_MODELS || [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-live-2.5-flash',
    'gemini-3.1-flash-live-preview-04-2026',
].join(','))
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

if (!projectId) {
    throw new Error('缺少 GCP_PROJECT_ID');
}

const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const shortError = (text: string) => {
    try {
        const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
        return parsed.error?.message || parsed.error?.status || text;
    } catch {
        return text.slice(0, 240);
    }
};

async function probeOne(region: string, model: string): Promise<ProbeResult> {
    const method: ProbeResult['method'] = /live/i.test(model) ? 'streamGenerateContent' : 'generateContent';
    const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
    const endpoint = `https://${host}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${method}`;
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    if (!token.token) {
        throw new Error('無法取得 Google Access Token');
    }

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 8, temperature: 0 },
        }),
    });

    const body = await res.text();
    return {
        region,
        model,
        method,
        ok: res.ok,
        status: res.status,
        message: res.ok ? 'OK' : shortError(body),
    };
}

async function main() {
    const results: ProbeResult[] = [];
    for (const region of regions) {
        for (const model of models) {
            try {
                results.push(await probeOne(region, model));
            } catch (error) {
                results.push({
                    region,
                    model,
                    method: /live/i.test(model) ? 'streamGenerateContent' : 'generateContent',
                    ok: false,
                    status: 0,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    console.log('\n=== Vertex Model Probe Results ===');
    for (const row of results) {
        const flag = row.ok ? 'PASS' : 'FAIL';
        console.log(`${flag} | ${row.region} | ${row.model} | ${row.method} | ${row.status} | ${row.message}`);
    }

    const passCount = results.filter((item) => item.ok).length;
    console.log(`\nSummary: ${passCount}/${results.length} 可用`);
}

main().catch((error) => {
    console.error('Probe failed:', error);
    process.exitCode = 1;
});
