import test from 'node:test';
import assert from 'node:assert/strict';

import { __quizServiceForTests, type QuizResponse } from './quizService';
import type { QuestionRecord } from './questionService';

test('/me history formatter keeps newest 10 records and renders mixed result types', async () => {
    const responses: QuizResponse[] = [
        {
            user_id: 'u1',
            question_id: 201,
            selected_option: 'A',
            is_correct: true,
            status: 'graded',
            created_at: '2026-06-16T12:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 202,
            selected_option: 'C',
            is_correct: false,
            status: 'graded',
            created_at: '2026-06-16T11:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 203,
            selected_option: null,
            is_correct: false,
            status: 'pending',
            answer_text: '我認為牛頓第一定律是...',
            created_at: '2026-06-16T10:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 204,
            selected_option: null,
            is_correct: true,
            status: 'graded',
            score: 92,
            answer_text: '位能轉成動能',
            created_at: '2026-06-16T09:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 205,
            selected_option: 'B',
            is_correct: true,
            status: 'graded',
            created_at: '2026-06-16T08:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 206,
            selected_option: 'D',
            is_correct: false,
            status: 'graded',
            created_at: '2026-06-16T07:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 207,
            selected_option: 'A',
            is_correct: true,
            status: 'graded',
            created_at: '2026-06-16T06:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 208,
            selected_option: 'B',
            is_correct: true,
            status: 'graded',
            created_at: '2026-06-16T05:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 209,
            selected_option: 'C',
            is_correct: false,
            status: 'graded',
            created_at: '2026-06-16T04:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 210,
            selected_option: 'D',
            is_correct: true,
            status: 'graded',
            created_at: '2026-06-16T03:00:00Z',
        },
        {
            user_id: 'u1',
            question_id: 211,
            selected_option: 'A',
            is_correct: true,
            status: 'graded',
            created_at: '2026-06-16T02:00:00Z',
        },
    ];

    const questions: QuestionRecord[] = [
        { id: 201, category: 'Class A', question_type: 'multiple_choice', content: '第一題', metadata: null, rubric: null },
        { id: 202, category: 'Class A', question_type: 'multiple_choice', content: '第二題', metadata: null, rubric: null },
        { id: 203, category: 'Class A', question_type: 'short_answer', content: '第三題', metadata: null, rubric: '提到慣性' },
        { id: 204, category: 'Class A', question_type: 'short_answer', content: '第四題', metadata: null, rubric: '提到能量轉換' },
        { id: 205, category: 'Class A', question_type: 'multiple_choice', content: '第五題', metadata: null, rubric: null },
        { id: 206, category: 'Class A', question_type: 'multiple_choice', content: '第六題', metadata: null, rubric: null },
        { id: 207, category: 'Class A', question_type: 'multiple_choice', content: '第七題', metadata: null, rubric: null },
        { id: 208, category: 'Class A', question_type: 'multiple_choice', content: '第八題', metadata: null, rubric: null },
        { id: 209, category: 'Class A', question_type: 'multiple_choice', content: '第九題', metadata: null, rubric: null },
        { id: 210, category: 'Class A', question_type: 'multiple_choice', content: '第十題', metadata: null, rubric: null },
        { id: 211, category: 'Class A', question_type: 'multiple_choice', content: '第十一題', metadata: null, rubric: null },
    ];

    const lines = __quizServiceForTests.formatRecentHistoryLines(responses, questions, 10);

    assert.equal(lines.length, 10);
    assert.match(lines[0]!, /#201/);
    assert.match(lines[0]!, /選 A/);
    assert.match(lines[0]!, /答對/);
    assert.match(lines[1]!, /#202/);
    assert.match(lines[1]!, /選 C/);
    assert.match(lines[1]!, /答錯/);
    assert.match(lines[2]!, /#203/);
    assert.match(lines[2]!, /簡答/);
    assert.match(lines[2]!, /待批改/);
    assert.match(lines[3]!, /#204/);
    assert.match(lines[3]!, /92 分/);
    assert.ok(lines.every((line) => !line.includes('#211')));
});

test('/me history formatter falls back when question content is missing', async () => {
    const responses: QuizResponse[] = [
        {
            user_id: 'u1',
            question_id: 999,
            selected_option: 'B',
            is_correct: true,
            status: 'graded',
            created_at: '2026-06-16T12:00:00Z',
        },
    ];

    const lines = __quizServiceForTests.formatRecentHistoryLines(responses, [], 10);

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /#999/);
    assert.match(lines[0]!, /題目已刪除或不可用/);
});
