import test from 'node:test';
import assert from 'node:assert/strict';

import { __studioServiceForTests } from './studioService';

test('studio fallback returns default text for empty research output', () => {
    const text = __studioServiceForTests.ensureNonEmptyReply('', 'fallback');
    assert.equal(text, 'fallback');
});

test('studio fallback preserves non-empty research output', () => {
    const text = __studioServiceForTests.ensureNonEmptyReply('  有內容  ', 'fallback');
    assert.equal(text, '有內容');
});

test('research fallback builds readable summary from search results', () => {
    const text = __studioServiceForTests.buildResearchFallbackSummary(
        'Gemini 3.1 發布內容整理',
        [
            {
                title: 'Gemini 3.1 release notes',
                link: 'https://example.com/release',
                snippet: 'Covers model updates and availability.',
                authority: 'secondary',
                authorityLabel: '一般補充來源',
            },
            {
                title: 'Gemini 3.1 overview',
                link: 'https://example.com/overview',
                snippet: 'Summarizes key changes and usage guidance.',
                authority: 'secondary',
                authorityLabel: '一般補充來源',
            },
        ],
    );

    assert.match(text, /研究摘要/);
    assert.match(text, /Gemini 3.1 發布內容整理/);
    assert.match(text, /1\./);
    assert.match(text, /來源/);
    assert.match(text, /結論與限制/);
});

test('research report filenames are slugified from prompt', () => {
    const filename = __studioServiceForTests.slugifyReportName('Gemini 3.1 Latest Report');
    assert.equal(filename, 'gemini-3-1-latest-report.md');
});

test('research source ranking prioritizes official and reference hosts', () => {
    const sorted = __studioServiceForTests.sortSources([
        { title: 'Blog recap', link: 'https://randomblog.example.com/post', snippet: 'secondary' },
        { title: 'OpenAI docs', link: 'https://platform.openai.com/docs/overview', snippet: 'official' },
        { title: 'Wikipedia', link: 'https://en.wikipedia.org/wiki/Gemini_(language_model)', snippet: 'reference' },
    ]);

    assert.equal(sorted[0]?.authority, 'official');
    assert.equal(sorted[1]?.authority, 'reference');
    assert.equal(sorted[2]?.authority, 'secondary');
});

test('research model is fixed to gemini-3.1-pro-preview', () => {
    assert.equal(__studioServiceForTests.getResearchModel(), 'gemini-3.1-pro-preview');
});

test('summarize prompt answers attachment question instead of meeting template', () => {
    const prompt = __studioServiceForTests.buildSummarizeChannelPrompt({
        channelLines: '使用者: 請看論文',
        attachmentContext: '檔名：paper.pdf\n可查詢原文片段：\nTable 3 regression results...',
        prompt: '請解釋 Table 3',
    });

    assert.match(prompt, /文件分析助理/);
    assert.match(prompt, /請解釋 Table 3/);
    assert.match(prompt, /表格目的/);
    assert.doesNotMatch(prompt, /1\) 今日重點/);
    assert.doesNotMatch(prompt, /待辦事項/);
    assert.doesNotMatch(prompt, /未解問題/);
});

test('summarize prompt avoids fixed meeting template for chat-only summaries', () => {
    const prompt = __studioServiceForTests.buildSummarizeChannelPrompt({
        channelLines: '使用者: 今天討論作業',
        attachmentContext: '',
    });

    assert.match(prompt, /自然分段/);
    assert.doesNotMatch(prompt, /1\) 今日重點/);
    assert.doesNotMatch(prompt, /2\) 待辦事項/);
    assert.doesNotMatch(prompt, /3\) 未解問題/);
});

test('summarize prompt avoids fixed meeting template for attachment summaries', () => {
    const prompt = __studioServiceForTests.buildSummarizeChannelPrompt({
        channelLines: '',
        attachmentContext: '檔名：paper.pdf\n摘要：研究摘要',
    });

    assert.match(prompt, /附件本身的重點/);
    assert.doesNotMatch(prompt, /今日重點/);
    assert.doesNotMatch(prompt, /待辦事項/);
    assert.doesNotMatch(prompt, /未解問題/);
});

test('studio memory entries preserve agent prompt and answer for follow-up ask', () => {
    const entries = __studioServiceForTests.buildStudioMemoryEntries({
        action: 'summarize_channel',
        prompt: '請解釋表2',
        attachmentHeader: '已讀附件：paper.pdf',
        response: '表2顯示課程為 16 週。',
    });

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.role, 'user');
    assert.match(entries[0]?.content ?? '', /請解釋表2/);
    assert.match(entries[0]?.content ?? '', /paper\.pdf/);
    assert.equal(entries[1]?.role, 'assistant');
    assert.match(entries[1]?.content ?? '', /16 週/);
});
