import { getRecentChatMessages } from './chatMemoryService';
import { generateModelText } from './llmService';
import { formatWebSearchSummary, searchWeb } from './webSearchService';

type StudioAction = 'summarize_channel' | 'research';

type RunStudioTaskInput = {
    action: StudioAction;
    channelSessionId: string;
    prompt?: string;
};

const getAgentModel = () => process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';

const ensureNonEmptyReply = (text: string, fallback: string) => {
    const normalized = text.trim();
    return normalized.length > 0 ? normalized : fallback;
};

const buildResearchFallbackSummary = (
    researchQuery: string,
    results: Array<{ title: string; link: string; snippet: string }>,
) => {
    const topResults = results.slice(0, 3);
    const resultLines = topResults.map((item, index) => {
        const snippet = item.snippet.trim() || '這筆結果沒有提供摘要。';
        return `${index + 1}. ${item.title}\n   ${snippet}`;
    });
    const sourceLines = topResults.map((item, index) => `${index + 1}. ${item.link}`);

    return [
        `重點整理\n目前先根據搜尋結果整理「${researchQuery}」的前 ${topResults.length} 筆重點：`,
        resultLines.join('\n'),
        '下一步建議\n- 先打開前 1 到 2 筆來源確認細節。\n- 如果你要，我可以再幫你改成比較像報告的整理版本。',
        `來源\n${sourceLines.join('\n')}`,
    ].join('\n\n');
};

export const __studioServiceForTests = {
    ensureNonEmptyReply,
    buildResearchFallbackSummary,
};

export async function runStudioTask(input: RunStudioTaskInput): Promise<string> {
    if (input.action === 'summarize_channel') {
        const memory = await getRecentChatMessages(input.channelSessionId, 24);
        const lines = memory.map((m) => `${m.role === 'assistant' ? '助教' : '使用者'}: ${m.content}`).join('\n');
        if (!lines.trim()) {
            return '目前頻道沒有可整理的共享記憶。';
        }

        const summary = await generateModelText({
            model: getAgentModel(),
            temperature: 0.2,
            maxOutputTokens: 900,
            prompt: [
                '你是會議整理助理，請用繁體中文整理重點。',
                '輸出格式：',
                '1) 今日重點',
                '2) 待辦事項',
                '3) 未解問題',
                '每區塊 2-6 行，避免冗長。',
                '',
                `對話內容：\n${lines}`,
            ].join('\n'),
        });

        return ensureNonEmptyReply(summary, '目前整理失敗，沒有產生可顯示的摘要，請稍後再試。');
    }

    const researchQuery = (input.prompt ?? '').trim();
    if (!researchQuery) {
        return '請提供 research 的查詢主題，例如：`/agent action:research prompt:Gemini 3.1 最新消息`';
    }

    const webResults = await searchWeb(researchQuery, 6);
    if (webResults.length === 0) {
        return '目前沒有查到可用網路結果，請換個關鍵字再試。';
    }

    const summary = await generateModelText({
        model: getAgentModel(),
        temperature: 0.2,
        maxOutputTokens: 1000,
        prompt: [
            '你是研究助理，請根據搜尋結果用繁體中文整理。',
            '輸出格式：',
            '1) 三點重點摘要',
            '2) 建議下一步',
            '3) 來源（列出網址）',
            '',
            `查詢主題：${researchQuery}`,
            '',
            `搜尋結果：\n${formatWebSearchSummary(webResults)}`,
        ].join('\n'),
    });

    return ensureNonEmptyReply(summary, buildResearchFallbackSummary(researchQuery, webResults));
}
