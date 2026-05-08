import test from 'node:test';
import assert from 'node:assert/strict';

import { __batchQuestionServiceForTests } from './batchQuestionService';

const sampleQuestion = (index: number) => ({
    category: 'Class A',
    content: `第 ${index} 題`,
    options: [`A${index}`, `B${index}`, `C${index}`, `D${index}`],
    correct_answer: 'A' as const,
    explanation: `說明 ${index}`,
});

test('batch question parser accepts fenced JSON payloads', () => {
    const questions = __batchQuestionServiceForTests.parseBatchQuestions(
        [
            '```json',
            '{"questions":[',
            '{"category":"Class A","content":"第一題","options":["A1","B1","C1","D1"],"correct_answer":"A","explanation":"說明 1"},',
            '{"category":"Class A","content":"第二題","options":["A2","B2","C2","D2"],"correct_answer":"B","explanation":"說明 2"}',
            ']}',
            '```',
        ].join('\n'),
        2,
    );

    assert.equal(questions.length, 2);
    assert.equal(questions[0]?.correct_answer, 'A');
    assert.equal(questions[1]?.correct_answer, 'B');
});

test('batch question parser rejects wrong question count', () => {
    assert.throws(
        () => __batchQuestionServiceForTests.parseBatchQuestions(
            '{"questions":[{"category":"Class A","content":"第一題","options":["A","B","C","D"],"correct_answer":"A","explanation":"說明"}]}',
            2,
        ),
        /預期 2 題/,
    );
});

test('normalizeBatchDraftQuestions upgrades legacy payloads into active draft items', () => {
    const normalized = __batchQuestionServiceForTests.normalizeBatchDraftQuestions([
        sampleQuestion(1),
        sampleQuestion(2),
    ]);

    assert.equal(normalized.length, 2);
    assert.equal(normalized[0]?.status, 'active');
    assert.equal(normalized[1]?.status, 'active');
    assert.ok(normalized[0]?.itemId);
    assert.equal(normalized[0]?.payload.content, '第 1 題');
});

test('markQuestionCreated only changes the target item', () => {
    const items = __batchQuestionServiceForTests.normalizeBatchDraftQuestions([
        sampleQuestion(1),
        sampleQuestion(2),
    ]);

    const updated = __batchQuestionServiceForTests.markQuestionCreated(items, items[0]!.itemId, 101);

    assert.equal(updated[0]?.status, 'created');
    assert.equal(updated[0]?.createdQuestionId, 101);
    assert.equal(updated[1]?.status, 'active');
    assert.equal(updated[1]?.createdQuestionId ?? null, null);
});

test('markQuestionDeleted removes the target item from active preview candidates', () => {
    const items = __batchQuestionServiceForTests.normalizeBatchDraftQuestions([
        sampleQuestion(1),
        sampleQuestion(2),
        sampleQuestion(3),
    ]);

    const updated = __batchQuestionServiceForTests.markQuestionDeleted(items, items[1]!.itemId);
    const visible = __batchQuestionServiceForTests.getVisibleDraftItems(updated);

    assert.equal(updated[1]?.status, 'deleted');
    assert.deepEqual(visible.map((item) => item.payload.content), ['第 1 題', '第 3 題']);
});

test('replaceDraftQuestion overwrites only the requested item payload', () => {
    const items = __batchQuestionServiceForTests.normalizeBatchDraftQuestions([
        sampleQuestion(1),
        sampleQuestion(2),
    ]);

    const replacement = sampleQuestion(9);
    const updated = __batchQuestionServiceForTests.replaceDraftQuestion(items, items[1]!.itemId, replacement);

    assert.equal(updated[0]?.payload.content, '第 1 題');
    assert.equal(updated[1]?.payload.content, '第 9 題');
    assert.equal(updated[1]?.status, 'active');
});

test('getPendingDraftItems excludes created and deleted questions from bulk approval', () => {
    const items = __batchQuestionServiceForTests.normalizeBatchDraftQuestions([
        sampleQuestion(1),
        sampleQuestion(2),
        sampleQuestion(3),
    ]);

    const created = __batchQuestionServiceForTests.markQuestionCreated(items, items[0]!.itemId, 201);
    const deleted = __batchQuestionServiceForTests.markQuestionDeleted(created, items[1]!.itemId);
    const pending = __batchQuestionServiceForTests.getPendingDraftItems(deleted);

    assert.deepEqual(pending.map((item) => item.payload.content), ['第 3 題']);
});
