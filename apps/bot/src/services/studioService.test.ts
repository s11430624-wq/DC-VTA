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
