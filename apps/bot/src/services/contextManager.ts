import {
    appendContextSummary,
    CONTEXT_SUMMARY_PREFIX,
    getLatestContextSummary,
    getRecentChatMessages,
    type ChatMessage,
} from './chatMemoryService';
import { generateModelText } from './llmService';

export type ContextSource = {
    name: '聊天記憶' | '近期聊天室' | '附件摘要' | 'research 材料';
    content: string;
    segments?: number;
};

export type ContextUsageReport = {
    totalEstimatedTokens: number;
    budgetTokens: number;
    triggerTokens: number;
    isNearLimit: boolean;
    shouldCompress: boolean;
    compressed: boolean;
    sources: Array<{
        name: ContextSource['name'];
        estimatedTokens: number;
        percent: number;
    }>;
    latestSummaryAt?: string;
};

export type PreparedContext = {
    memory: ChatMessage[];
    summaryText: string;
    report: ContextUsageReport;
    compressionNotice?: string;
};

const CONTEXT_TOKEN_BUDGET = Math.max(1000, Number(process.env.CONTEXT_TOKEN_BUDGET || 128000));
const CONTEXT_COMPRESSION_TRIGGER_RATIO = Math.max(0.1, Math.min(1, Number(process.env.CONTEXT_COMPRESSION_TRIGGER_RATIO || 0.9)));
const CONTEXT_RECENT_MESSAGES_KEEP = Math.max(1, Number(process.env.CONTEXT_RECENT_MESSAGES_KEEP || 12));
const CONTEXT_SUMMARY_MAX_TOKENS = Math.max(200, Number(process.env.CONTEXT_SUMMARY_MAX_TOKENS || 5000));
const COMPRESSION_NOTICE = '已自動壓縮較早的上下文，保留重點供後續對話使用。';
const DEFAULT_CONTEXT_MODEL = () => process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';

export const estimateTokens = (text: string, segments = 1, sourceOverhead = 0) => {
    if (!text.trim()) {
        return 0;
    }
    return Math.ceil(text.length / 2) + Math.max(0, segments) * 20 + sourceOverhead;
};

const stripContextSummaryPrefix = (content: string) => content.replace(CONTEXT_SUMMARY_PREFIX, '').trim();
const isContextSummaryMessage = (message: ChatMessage) => message.content.startsWith(CONTEXT_SUMMARY_PREFIX);

const toMemoryText = (memory: ChatMessage[]) => memory
    .map((message) => `${message.role === 'assistant' ? '助教' : '使用者'}: ${message.content}`)
    .join('\n');

const buildUsageReport = (sources: ContextSource[], latestSummaryAt?: string, compressed = false): ContextUsageReport => {
    const sourceUsages = sources.map((source) => ({
        name: source.name,
        estimatedTokens: estimateTokens(source.content, source.segments ?? 1, source.content.trim() ? 40 : 0),
        percent: 0,
    }));
    const totalEstimatedTokens = sourceUsages.reduce((total, source) => total + source.estimatedTokens, 0);
    const triggerTokens = Math.floor(CONTEXT_TOKEN_BUDGET * CONTEXT_COMPRESSION_TRIGGER_RATIO);

    return {
        totalEstimatedTokens,
        budgetTokens: CONTEXT_TOKEN_BUDGET,
        triggerTokens,
        isNearLimit: totalEstimatedTokens >= triggerTokens,
        shouldCompress: totalEstimatedTokens >= triggerTokens,
        compressed,
        sources: sourceUsages.map((source) => ({
            ...source,
            percent: totalEstimatedTokens > 0 ? Math.round((source.estimatedTokens / totalEstimatedTokens) * 100) : 0,
        })),
        ...(latestSummaryAt ? { latestSummaryAt } : {}),
    };
};

const generateContextSummary = async (input: {
    previousSummary: string;
    olderMemoryText: string;
    liveChannelContext: string;
    attachmentContext: string;
    researchContext: string;
}) => generateModelText({
    model: DEFAULT_CONTEXT_MODEL(),
    temperature: 0.2,
    maxOutputTokens: CONTEXT_SUMMARY_MAX_TOKENS,
    prompt: [
        '你是課堂 Discord 助教的上下文壓縮器。請把舊上下文壓縮成可延續後續對話的繁體中文摘要。',
        '摘要必須保留：目前主題、已確認事實、使用者偏好、已做過的決策、待辦或未解問題、重要來源與附件名稱、風險與限制。',
        '不要編造沒有出現在上下文中的事實。',
        '',
        `既有壓縮摘要：\n${input.previousSummary || '（無）'}`,
        '',
        `舊聊天記憶：\n${input.olderMemoryText || '（無）'}`,
        '',
        `近期聊天室：\n${input.liveChannelContext || '（無）'}`,
        '',
        `附件摘要：\n${input.attachmentContext || '（無）'}`,
        '',
        `research 材料：\n${input.researchContext || '（無）'}`,
    ].join('\n'),
});

export async function prepareContext(input: {
    sessionId: string;
    userId: string;
    memoryLimit?: number;
    liveChannelContext?: string;
    attachmentContext?: string;
    researchContext?: string;
}): Promise<PreparedContext> {
    const memory = (await getRecentChatMessages(input.sessionId, input.memoryLimit ?? 8)).filter((message) => !isContextSummaryMessage(message));
    const latestSummary = await getLatestContextSummary(input.sessionId);
    const summaryText = latestSummary ? stripContextSummaryPrefix(latestSummary.content) : '';
    const sources: ContextSource[] = [
        { name: '聊天記憶', content: [summaryText, toMemoryText(memory)].filter(Boolean).join('\n\n'), segments: memory.length + (summaryText ? 1 : 0) },
        { name: '近期聊天室', content: input.liveChannelContext ?? '', segments: input.liveChannelContext ? 1 : 0 },
        { name: '附件摘要', content: input.attachmentContext ?? '', segments: input.attachmentContext ? 1 : 0 },
        { name: 'research 材料', content: input.researchContext ?? '', segments: input.researchContext ? 1 : 0 },
    ];
    const initialReport = buildUsageReport(sources, latestSummary?.created_at);

    if (!initialReport.shouldCompress) {
        return {
            memory,
            summaryText,
            report: initialReport,
        };
    }

    const olderMemory = memory.slice(0, Math.max(0, memory.length - CONTEXT_RECENT_MESSAGES_KEEP));
    const recentMemory = memory.slice(Math.max(0, memory.length - CONTEXT_RECENT_MESSAGES_KEEP));
    const compressedSummary = await generateContextSummary({
        previousSummary: summaryText,
        olderMemoryText: toMemoryText(olderMemory),
        liveChannelContext: input.liveChannelContext ?? '',
        attachmentContext: input.attachmentContext ?? '',
        researchContext: input.researchContext ?? '',
    });

    await appendContextSummary(input.sessionId, input.userId, compressedSummary);

    const nextSources: ContextSource[] = [
        { name: '聊天記憶', content: [compressedSummary, toMemoryText(recentMemory)].join('\n\n'), segments: recentMemory.length + 1 },
        { name: '近期聊天室', content: input.liveChannelContext ?? '', segments: input.liveChannelContext ? 1 : 0 },
        { name: '附件摘要', content: input.attachmentContext ?? '', segments: input.attachmentContext ? 1 : 0 },
        { name: 'research 材料', content: input.researchContext ?? '', segments: input.researchContext ? 1 : 0 },
    ];

    return {
        memory: recentMemory,
        summaryText: compressedSummary.trim(),
        report: buildUsageReport(nextSources, new Date().toISOString(), true),
        compressionNotice: COMPRESSION_NOTICE,
    };
}

export async function buildContextStatus(sessionId: string): Promise<string> {
    const memory = (await getRecentChatMessages(sessionId, 24)).filter((message) => !isContextSummaryMessage(message));
    const latestSummary = await getLatestContextSummary(sessionId);
    const summaryText = latestSummary ? stripContextSummaryPrefix(latestSummary.content) : '';
    const report = buildUsageReport(
        [
            { name: '聊天記憶', content: [summaryText, toMemoryText(memory)].filter(Boolean).join('\n\n'), segments: memory.length + (summaryText ? 1 : 0) },
            { name: '近期聊天室', content: '', segments: 0 },
            { name: '附件摘要', content: '', segments: 0 },
            { name: 'research 材料', content: '', segments: 0 },
        ],
        latestSummary?.created_at,
    );

    const sourceLines = report.sources
        .map((source) => `- ${source.name}: 約 ${source.estimatedTokens} tokens（${source.percent}%）`)
        .join('\n');

    return [
        '上下文用量',
        `目前估計：${report.totalEstimatedTokens} / ${report.budgetTokens} tokens`,
        `自動壓縮門檻：約 ${report.triggerTokens} tokens`,
        `狀態：${report.isNearLimit ? '接近上限' : '正常'}`,
        report.latestSummaryAt ? `最近壓縮：${report.latestSummaryAt}` : '最近壓縮：尚未壓縮',
        '',
        '來源占比',
        sourceLines,
    ].join('\n');
}

export const __contextManagerForTests = {
    estimateTokens,
    buildUsageReport,
    stripContextSummaryPrefix,
    isContextSummaryMessage,
};
