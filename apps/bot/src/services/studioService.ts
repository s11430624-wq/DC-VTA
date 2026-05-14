import { getRecentChatMessages } from './chatMemoryService';
import { generateModelText } from './llmService';
import { formatWebSearchSummary, searchWeb } from './webSearchService';

type StudioAction = 'summarize_channel' | 'research';

type RunStudioTaskInput = {
    action: StudioAction;
    channelSessionId: string;
    prompt?: string;
    attachmentContext?: string;
};

export type StudioTaskFile = {
    attachment: Buffer;
    name: string;
};

export type StudioTaskResult = {
    content: string;
    files?: StudioTaskFile[];
};

type ResearchSource = {
    title: string;
    link: string;
    snippet: string;
    authority: 'official' | 'reference' | 'secondary';
    authorityLabel: string;
};

type ResearchEvidencePack = {
    query: string;
    attachmentContext: string;
    officialSources: ResearchSource[];
    supportingSources: ResearchSource[];
};

const DEFAULT_SUMMARIZE_MODEL = () => process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';
const RESEARCH_MODEL = 'gemini-3.1-pro-preview';
const RESEARCH_MAX_RESULTS = Math.max(3, Math.min(10, Number(process.env.RESEARCH_MAX_RESULTS || 8)));

const OFFICIAL_HOST_PATTERNS = [
    /(^|\.)google\.com$/i,
    /(^|\.)openai\.com$/i,
    /(^|\.)anthropic\.com$/i,
    /(^|\.)microsoft\.com$/i,
    /(^|\.)github\.com$/i,
    /(^|\.)arxiv\.org$/i,
    /(^|\.)nature\.com$/i,
    /(^|\.)science\.org$/i,
    /(^|\.)who\.int$/i,
    /(^|\.)un\.org$/i,
    /(^|\.)gov$/i,
    /(^|\.)edu$/i,
    /(^|\.)ac\.[a-z.]+$/i,
];

const REFERENCE_HOST_PATTERNS = [
    /(^|\.)wikipedia\.org$/i,
    /(^|\.)mozilla\.org$/i,
    /(^|\.)developer\./i,
    /(^|\.)docs\./i,
];

const ensureNonEmptyReply = (text: string, fallback: string) => {
    const normalized = text.trim();
    return normalized.length > 0 ? normalized : fallback;
};

const slugifyReportName = (input: string) => {
    const slug = input
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return `${slug || 'research-report'}.md`;
};

const detectAuthority = (link: string): ResearchSource['authority'] => {
    try {
        const host = new URL(link).hostname.toLowerCase();
        if (OFFICIAL_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
            return 'official';
        }
        if (REFERENCE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
            return 'reference';
        }
        return 'secondary';
    } catch {
        return 'secondary';
    }
};

const authorityLabel = (authority: ResearchSource['authority']) => {
    if (authority === 'official') return '官方/原始來源';
    if (authority === 'reference') return '參考/文件來源';
    return '一般補充來源';
};

const sortSources = (sources: Array<{ title: string; link: string; snippet: string }>): ResearchSource[] => {
    const enriched = sources.map((source) => {
        const authority = detectAuthority(source.link);
        return {
            ...source,
            authority,
            authorityLabel: authorityLabel(authority),
        };
    });

    const order = { official: 0, reference: 1, secondary: 2 } as const;
    return enriched.sort((left, right) => order[left.authority] - order[right.authority]);
};

const buildResearchFallbackSummary = (
    researchQuery: string,
    results: ResearchSource[],
) => {
    const topResults = results.slice(0, 3);
    const resultLines = topResults.map((item, index) => {
        const snippet = item.snippet.trim() || '這筆結果沒有提供摘要。';
        return `${index + 1}. ${item.title}（${item.authorityLabel}）\n   ${snippet}`;
    });
    const sourceLines = topResults.map((item, index) => `${index + 1}. ${item.link}`);

    return [
        `研究摘要\n目前先根據「${researchQuery}」整理前 ${topResults.length} 筆來源重點：`,
        resultLines.join('\n'),
        '結論與限制\n- 目前結果僅為快速整理，完整報告生成失敗時可先用這份摘要確認方向。\n- 建議優先打開官方或原始來源確認細節。',
        `來源\n${sourceLines.join('\n')}`,
    ].join('\n\n');
};

const buildSourcesSection = (sources: ResearchSource[]) => {
    if (sources.length === 0) {
        return '（目前沒有可列出的來源）';
    }

    return sources.map((source, index) => (
        `${index + 1}. ${source.title}\n- 類型：${source.authorityLabel}\n- 網址：${source.link}\n- 摘要：${source.snippet || '（無摘要）'}`
    )).join('\n');
};

const buildEvidencePack = (query: string, attachmentContext: string, sources: ResearchSource[]): ResearchEvidencePack => ({
    query,
    attachmentContext,
    officialSources: sources.filter((source) => source.authority === 'official' || source.authority === 'reference'),
    supportingSources: sources.filter((source) => source.authority === 'secondary'),
});

const getResearchPrompt = (pack: ResearchEvidencePack) => [
    '你是研究分析助理，請根據給定的研究主題、附件內容與來源證據，產出一份中篇、章節式、分析型 Markdown 報告。',
    '報告必須使用繁體中文。',
    '報告固定章節：',
    '# 摘要',
    '# 研究背景',
    '# 主要發現',
    '# 比較分析',
    '# 風險與限制',
    '# 結論與建議',
    '# 來源',
    '',
    '寫作要求：',
    '- 不是幾點摘要，而是可直接交付的文字報告。',
    '- 優先使用官方/原始來源，若證據不足要明講。',
    '- 在比較分析中說明差異、趨勢、相互矛盾處或重要對照。',
    '- 在風險與限制中說明資料盲點、來源不足、時間落差或尚未確認的部分。',
    '- 來源章節請列出實際網址。',
    '',
    `研究主題：${pack.query}`,
    '',
    `附件內容：\n${pack.attachmentContext || '（無）'}`,
    '',
    `官方/高可信來源：\n${buildSourcesSection(pack.officialSources)}`,
    '',
    `一般補充來源：\n${buildSourcesSection(pack.supportingSources)}`,
].join('\n');

const buildDiscordResearchSummary = async (query: string, markdownReport: string) => generateModelText({
    model: RESEARCH_MODEL,
    temperature: 0.2,
    maxOutputTokens: 450,
    prompt: [
        '你是研究助理，請根據完整報告輸出一段 Discord 用的簡短摘要。',
        '格式要求：',
        '1. 第一行：研究主題',
        '2. 接著列 3 到 5 點核心發現',
        '3. 最後一句：提醒完整報告見附件',
        '4. 不要重貼完整來源列表',
        '',
        `研究主題：${query}`,
        '',
        markdownReport,
    ].join('\n'),
});

const generateResearchReport = async (pack: ResearchEvidencePack) => {
    const markdown = await generateModelText({
        model: RESEARCH_MODEL,
        temperature: 0.2,
        maxOutputTokens: 2400,
        prompt: getResearchPrompt(pack),
    });

    return ensureNonEmptyReply(markdown, buildResearchFallbackSummary(pack.query, [...pack.officialSources, ...pack.supportingSources]));
};

export const __studioServiceForTests = {
    ensureNonEmptyReply,
    buildResearchFallbackSummary,
    slugifyReportName,
    sortSources,
    getResearchModel: () => RESEARCH_MODEL,
};

export async function runStudioTask(input: RunStudioTaskInput): Promise<StudioTaskResult> {
    if (input.action === 'summarize_channel') {
        const memory = await getRecentChatMessages(input.channelSessionId, 24);
        const lines = memory.map((m) => `${m.role === 'assistant' ? '助教' : '使用者'}: ${m.content}`).join('\n');
        if (!lines.trim()) {
            return { content: '目前頻道沒有可整理的共享記憶。' };
        }

        const summary = await generateModelText({
            model: DEFAULT_SUMMARIZE_MODEL(),
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
                '',
                `附件內容：\n${input.attachmentContext?.trim() || '（無）'}`,
            ].join('\n'),
        });

        return { content: ensureNonEmptyReply(summary, '目前整理失敗，沒有產生可顯示的摘要，請稍後再試。') };
    }

    const researchQuery = (input.prompt ?? '').trim();
    const attachmentContext = input.attachmentContext?.trim() || '';
    if (!researchQuery) {
        return { content: '請提供 research 的查詢主題，例如：`/agent action:research prompt:Gemini 3.1 最新消息`' };
    }

    const rawResults = await searchWeb(researchQuery, RESEARCH_MAX_RESULTS);
    if (rawResults.length === 0 && !attachmentContext) {
        return { content: '目前沒有查到可用網路結果，請換個關鍵字再試。' };
    }

    const rankedSources = sortSources(rawResults);
    const pack = buildEvidencePack(researchQuery, attachmentContext, rankedSources);
    const reportMarkdown = await generateResearchReport(pack);
    const summaryText = await buildDiscordResearchSummary(researchQuery, reportMarkdown);
    const markdownFile: StudioTaskFile = {
        name: slugifyReportName(researchQuery),
        attachment: Buffer.from(`${reportMarkdown.trim()}\n`, 'utf8'),
    };

    return {
        content: ensureNonEmptyReply(summaryText, `已完成「${researchQuery}」的研究摘要，完整報告請見附件。`),
        files: [markdownFile],
    };
}
