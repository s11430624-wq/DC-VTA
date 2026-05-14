import test from 'node:test';
import assert from 'node:assert/strict';

import { CONTEXT_SUMMARY_PREFIX } from './chatMemoryService';
import { __contextManagerForTests } from './contextManager';

test('context token estimate uses conservative character and overhead calculation', () => {
    assert.equal(__contextManagerForTests.estimateTokens('abcd', 2, 40), 82);
    assert.equal(__contextManagerForTests.estimateTokens('', 2, 40), 0);
});

test('context usage report calculates source percentages and compression threshold', () => {
    const report = __contextManagerForTests.buildUsageReport([
        { name: '聊天記憶', content: 'a'.repeat(230000), segments: 3 },
        { name: '附件摘要', content: 'b'.repeat(6000), segments: 1 },
    ]);

    assert.equal(report.budgetTokens, 128000);
    assert.equal(report.triggerTokens, 115200);
    assert.equal(report.shouldCompress, true);
    assert.equal(report.sources.length, 2);
    assert.equal(report.sources.reduce((total, source) => total + source.percent, 0), 100);
});

test('context summary prefix helpers identify and strip stored summaries', () => {
    const content = `${CONTEXT_SUMMARY_PREFIX}\n目前主題：研究報告`;
    assert.equal(__contextManagerForTests.stripContextSummaryPrefix(content), '目前主題：研究報告');
    assert.equal(__contextManagerForTests.isContextSummaryMessage({
        session_id: 'channel:test',
        user_id: 'u1',
        role: 'assistant',
        content,
    }), true);
});
