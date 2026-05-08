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
            },
            {
                title: 'Gemini 3.1 overview',
                link: 'https://example.com/overview',
                snippet: 'Summarizes key changes and usage guidance.',
            },
        ],
    );

    assert.match(text, /重點整理/);
    assert.match(text, /Gemini 3.1 發布內容整理/);
    assert.match(text, /1\./);
    assert.match(text, /來源/);
});
