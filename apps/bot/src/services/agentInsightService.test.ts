import test from 'node:test';
import assert from 'node:assert/strict';

import { createStructuredInsightBuilder } from './agentInsightService';
import type { QuizResponse } from './quizService';
import type { UserRecord } from './userService';

const sampleResponses: QuizResponse[] = [
    { user_id: 'u1', question_id: 101, group_id: 'class-a', selected_option: 'A', is_correct: false, status: 'graded' },
    { user_id: 'u1', question_id: 102, group_id: 'class-a', selected_option: 'B', is_correct: true, status: 'graded' },
    { user_id: 'u2', question_id: 101, group_id: 'class-a', selected_option: 'C', is_correct: false, status: 'graded' },
    { user_id: 'u2', question_id: 103, group_id: 'class-a', selected_option: 'A', is_correct: false, status: 'pending' },
    { user_id: 'u3', question_id: 101, group_id: 'class-a', selected_option: 'D', is_correct: true, status: 'graded' },
];

const sampleUsers: UserRecord[] = [
    { user_id: 'u1', display_name: '王小明', student_id: 'S001', class_name: 'Class A', role: 'student' },
    { user_id: 'u2', display_name: '李小華', student_id: 'S002', class_name: 'Class A', role: 'student' },
    { user_id: 'u3', display_name: '陳小安', student_id: 'S003', class_name: 'Class A', role: 'student' },
];

const sampleQuestions = [
    { id: 101, category: 'Class A', question_type: 'multiple_choice', content: '牛頓第二定律是什麼？', metadata: null, rubric: null },
    { id: 102, category: 'Class A', question_type: 'multiple_choice', content: '加速度與力的關係？', metadata: null, rubric: null },
    { id: 103, category: 'Class A', question_type: 'short_answer', content: '請說明慣性。', metadata: null, rubric: '提到質量與運動狀態' },
];

const buildInsight = createStructuredInsightBuilder({
    getQuizResponsesByGroupId: async () => sampleResponses,
    getQuestionsByIds: async (ids: number[]) => sampleQuestions.filter((question) => ids.includes(question.id)),
    getUserByDiscordId: async (userId: string) => sampleUsers.find((user) => user.user_id === userId) ?? null,
    getUsersByIds: async (ids: string[]) => sampleUsers.filter((user) => ids.includes(user.user_id)),
});

test('class overview returns structured teacher summary', async () => {
    const answer = await buildInsight({
        intent: 'class_overview',
        channelId: 'class-a',
        userId: 'teacher-1',
        question: '幫我看這週全班狀況',
        isTeacher: true,
    });

    assert.ok(answer);
    assert.match(answer!, /結論/);
    assert.match(answer!, /答對率/);
    assert.match(answer!, /待批改 1 份/);
});

test('mistake hotspots highlights the most-missed question', async () => {
    const answer = await buildInsight({
        intent: 'mistake_hotspots',
        channelId: 'class-a',
        userId: 'teacher-1',
        question: '最近哪幾題最多人錯',
        isTeacher: true,
    });

    assert.ok(answer);
    assert.match(answer!, /題目 101/);
    assert.match(answer!, /牛頓第二定律/);
});

test('student self diagnosis returns personalized guidance', async () => {
    const answer = await buildInsight({
        intent: 'student_self_diagnosis',
        channelId: 'class-a',
        userId: 'u1',
        question: '幫我看一下我最近表現',
        isTeacher: false,
    });

    assert.ok(answer);
    assert.match(answer!, /王小明/);
    assert.match(answer!, /你目前的整體表現/);
    assert.match(answer!, /下一步建議/);
});

test('student observation asks for clearer identification when no student matches', async () => {
    const answer = await buildInsight({
        intent: 'student_observation',
        channelId: 'class-a',
        userId: 'teacher-1',
        question: '觀察一下最近是不是狀況不好',
        isTeacher: true,
    });

    assert.ok(answer);
    assert.match(answer!, /還沒辦法確定/);
});
