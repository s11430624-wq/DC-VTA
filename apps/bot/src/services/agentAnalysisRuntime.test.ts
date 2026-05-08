import test from 'node:test';
import assert from 'node:assert/strict';

import { formatAgentStructuredReply, resolveAgentIntent, shouldDenyStudentScope } from './agentAnalysisRuntime';

test('resolveAgentIntent routes teacher class overview requests', () => {
    const result = resolveAgentIntent('幫我看這週全班狀況', true);
    assert.equal(result.intent, 'class_overview');
});

test('resolveAgentIntent routes student coaching requests', () => {
    const result = resolveAgentIntent('我這週該先複習什麼', false);
    assert.equal(result.intent, 'student_review_coach');
});

test('resolveAgentIntent routes teacher mistake hotspot requests', () => {
    const result = resolveAgentIntent('最近哪幾題最多人錯', true);
    assert.equal(result.intent, 'mistake_hotspots');
});

test('resolveAgentIntent routes teacher student observation requests', () => {
    const result = resolveAgentIntent('觀察一下王小明最近是不是狀況不好', true);
    assert.equal(result.intent, 'student_observation');
});

test('resolveAgentIntent routes teacher rank interpretation requests', () => {
    const result = resolveAgentIntent('這份排行榜怎麼解讀', true);
    assert.equal(result.intent, 'rank_interpretation');
});

test('resolveAgentIntent routes teacher question quality requests', () => {
    const result = resolveAgentIntent('幫我看哪些題目可能太難或太簡單', true);
    assert.equal(result.intent, 'question_quality_check');
});

test('resolveAgentIntent routes student weakness summary requests', () => {
    const result = resolveAgentIntent('我最近哪裡最弱', false);
    assert.equal(result.intent, 'student_weakness_summary');
});

test('resolveAgentIntent routes student self diagnosis requests', () => {
    const result = resolveAgentIntent('幫我看一下我最近表現', false);
    assert.equal(result.intent, 'student_self_diagnosis');
});

test('resolveAgentIntent preserves teacher question generation path', () => {
    const result = resolveAgentIntent('幫我出一題牛頓第二定律選擇題', true);
    assert.equal(result.intent, 'question_generation');
});

test('resolveAgentIntent preserves capability questions', () => {
    const result = resolveAgentIntent('你可以做什麼', true);
    assert.equal(result.intent, 'capability');
});

test('resolveAgentIntent falls back to general chat when no analysis intent matches', () => {
    const result = resolveAgentIntent('今天上課辛苦了', false);
    assert.equal(result.intent, 'general_chat');
});

test('shouldDenyStudentScope blocks requests for other students', () => {
    const result = shouldDenyStudentScope('王小明最近成績怎麼樣');
    assert.equal(result.denied, true);
    assert.match(result.reason, /只能查詢你自己/);
});

test('shouldDenyStudentScope blocks class level ranking questions for students', () => {
    const result = shouldDenyStudentScope('全班排行榜前五名是誰');
    assert.equal(result.denied, true);
});

test('shouldDenyStudentScope allows self analysis questions for students', () => {
    const result = shouldDenyStudentScope('我最近成績怎麼樣');
    assert.equal(result.denied, false);
});

test('formatAgentStructuredReply produces fixed Discord template', () => {
    const text = formatAgentStructuredReply({
        summary: '這週整體作答表現偏弱。',
        findings: ['共有 12 份作答', '答對率 58%'],
        suggestions: ['先複習最近錯最多的題目', '確認是否有未批改短答'],
        caveat: '目前樣本數偏少，判斷僅供參考。',
    });

    assert.match(text, /結論/);
    assert.match(text, /關鍵發現/);
    assert.match(text, /下一步建議/);
    assert.match(text, /資料提醒/);
});

test('formatAgentStructuredReply falls back when findings and suggestions are empty', () => {
    const text = formatAgentStructuredReply({
        summary: '目前資料不足。',
        findings: [],
        suggestions: [],
    });

    assert.match(text, /目前沒有足夠資料可列出重點/);
    assert.match(text, /先補充更多作答資料後再分析/);
});
