import { randomUUID } from 'crypto';
import { createMultipleChoiceQuestion, QuestionRecord } from './questionService';
import { supabase } from './supabase';
import { generateModelText } from './llmService';

const getQuestionModel = () => process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';

export type GeneratedQuestionPayload = {
    category: string;
    content: string;
    options: string[];
    correct_answer: 'A' | 'B' | 'C' | 'D';
    explanation: string;
};

export type GeneratedShortAnswerPayload = {
    category: string;
    content: string;
    rubric: string;
};

export type QuestionDraftRecord = {
    draftId: string;
    userId: string;
    instructions: string;
    payload: GeneratedQuestionPayload;
    createdAt: string;
};

type DraftRow = {
    draft_id: string;
    user_id: string;
    instructions: string;
    payload: GeneratedQuestionPayload;
    created_at?: string;
};

const DRAFT_TABLE = 'agent_question_drafts';
const draftStore = new Map<string, QuestionDraftRecord>();
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const QUESTION_GENERATION_PROMPT = [
    '你是課堂測驗出題器。',
    '請根據老師的要求，產生一題高品質的四選一單選題。',
    '必須使用繁體中文。',
    '題目要明確，不能有兩個以上正確答案。',
    '選項固定 4 個，長度要合理，不能只寫 A 選項、B 選項這種 placeholder。',
    'correct_answer 只能是 A、B、C、D。',
    '只輸出 JSON，不要輸出 Markdown，不要輸出說明文字。',
    'JSON 結構必須是 {"category":"...","content":"...","options":["...","...","...","..."],"correct_answer":"A","explanation":"..."}。',
].join('\n');

const SHORT_ANSWER_GENERATION_PROMPT = [
    '你是課堂測驗出題器。',
    '請根據老師需求產生一題高品質的簡答題。',
    '必須使用繁體中文。',
    '請輸出題目內容(content)與評分規準(rubric)。',
    'rubric 必須可用於教師評分，請具體列出重點。',
    '只輸出 JSON，不要輸出 Markdown，不要輸出說明文字。',
    'JSON 結構必須是 {"category":"...","content":"...","rubric":"..."}。',
].join('\n');

const isMissingTableError = (error: { code?: string; message?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST205' || message.includes(DRAFT_TABLE) || message.includes('relation');
};

function stripCodeFences(rawText: string): string {
    const trimmed = rawText.trim();
    if (trimmed.startsWith('```')) {
        return trimmed
            .replace(/^```[a-zA-Z]*\s*/, '')
            .replace(/\s*```$/, '')
            .trim();
    }

    return trimmed;
}

function normalizeOptionText(rawOption: string): string {
    return rawOption
        .replace(/^\s*[A-DＡ-Ｄ][\.\、\)\:：]\s*/i, '')
        .trim();
}

function parseGeneratedQuestion(rawText: string): GeneratedQuestionPayload {
    const parsed = JSON.parse(stripCodeFences(rawText)) as Partial<GeneratedQuestionPayload>;
    const options = Array.isArray(parsed.options)
        ? parsed.options.map((option) => normalizeOptionText(String(option))).filter((option) => option.length > 0)
        : [];
    const correctAnswer = parsed.correct_answer;

    if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
        throw new Error('AI 產生的題目缺少 content。');
    }

    if (typeof parsed.category !== 'string' || parsed.category.trim().length === 0) {
        throw new Error('AI 產生的題目缺少 category。');
    }

    if (options.length !== 4) {
        throw new Error('AI 產生的題目選項數量不正確。');
    }

    if (correctAnswer !== 'A' && correctAnswer !== 'B' && correctAnswer !== 'C' && correctAnswer !== 'D') {
        throw new Error('AI 產生的題目正確答案格式錯誤。');
    }

    return {
        category: parsed.category.trim(),
        content: parsed.content.trim(),
        options,
        correct_answer: correctAnswer,
        explanation: typeof parsed.explanation === 'string' ? parsed.explanation.trim() : '',
    };
}

function parseGeneratedShortAnswerQuestion(rawText: string): GeneratedShortAnswerPayload {
    const parsed = JSON.parse(stripCodeFences(rawText)) as Partial<GeneratedShortAnswerPayload>;

    if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
        throw new Error('AI 產生的簡答題缺少 content。');
    }

    if (typeof parsed.category !== 'string' || parsed.category.trim().length === 0) {
        throw new Error('AI 產生的簡答題缺少 category。');
    }

    if (typeof parsed.rubric !== 'string' || parsed.rubric.trim().length === 0) {
        throw new Error('AI 產生的簡答題缺少 rubric。');
    }

    return {
        category: parsed.category.trim(),
        content: parsed.content.trim(),
        rubric: parsed.rubric.trim(),
    };
}

async function generateQuestionJson(teacherPrompt: string): Promise<GeneratedQuestionPayload> {
    const rawText = await generateModelText({
        model: getQuestionModel(),
        prompt: `${QUESTION_GENERATION_PROMPT}\n\n老師需求：${teacherPrompt}`,
        temperature: 0.7,
        responseMimeType: 'application/json',
    });

    if (!rawText) {
        throw new Error('Gemini 沒有回傳題目內容。');
    }

    return parseGeneratedQuestion(rawText);
}

async function generateShortAnswerQuestionJson(teacherPrompt: string): Promise<GeneratedShortAnswerPayload> {
    const rawText = await generateModelText({
        model: getQuestionModel(),
        prompt: `${SHORT_ANSWER_GENERATION_PROMPT}\n\n老師需求：${teacherPrompt}`,
        temperature: 0.7,
        responseMimeType: 'application/json',
    });

    if (!rawText) {
        throw new Error('Gemini 沒有回傳簡答題內容。');
    }

    return parseGeneratedShortAnswerQuestion(rawText);
}

async function saveDraft(record: QuestionDraftRecord): Promise<void> {
    draftStore.set(record.draftId, record);

    const result = await supabase
        .from(DRAFT_TABLE)
        .upsert({
            draft_id: record.draftId,
            user_id: record.userId,
            instructions: record.instructions,
            payload: record.payload,
        });

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`寫入題目草稿失敗：${result.error.message}`);
    }
}

function buildDraftPrompt(baseDraft: QuestionDraftRecord, revisionPrompt: string): string {
    return [
        '請根據下面這份既有題目草稿進行修改，保留四選一格式，並依照老師的新要求重寫完整題目。',
        `既有分類：${baseDraft.payload.category}`,
        `既有題目：${baseDraft.payload.content}`,
        `既有選項：A. ${baseDraft.payload.options[0] ?? ''} | B. ${baseDraft.payload.options[1] ?? ''} | C. ${baseDraft.payload.options[2] ?? ''} | D. ${baseDraft.payload.options[3] ?? ''}`,
        `既有答案：${baseDraft.payload.correct_answer}`,
        `既有解析：${baseDraft.payload.explanation || '無'}`,
        `老師新的修改要求：${revisionPrompt}`,
    ].join('\n');
}

function isExpiredDraft(draft: QuestionDraftRecord): boolean {
    const createdAtMs = Date.parse(draft.createdAt);
    if (Number.isNaN(createdAtMs)) {
        return false;
    }

    return Date.now() - createdAtMs > DRAFT_TTL_MS;
}

async function deleteDraft(draftId: string): Promise<void> {
    draftStore.delete(draftId);

    const result = await supabase
        .from(DRAFT_TABLE)
        .delete()
        .eq('draft_id', draftId);

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`刪除題目草稿失敗：${result.error.message}`);
    }
}

export async function clearDraftsByUser(userId: string): Promise<void> {
    for (const [draftId, draft] of draftStore.entries()) {
        if (draft.userId === userId) {
            draftStore.delete(draftId);
        }
    }

    const result = await supabase
        .from(DRAFT_TABLE)
        .delete()
        .eq('user_id', userId);

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`清除題目草稿失敗：${result.error.message}`);
    }
}

export async function getDraftById(draftId: string): Promise<QuestionDraftRecord | null> {
    const memoryDraft = draftStore.get(draftId);
    if (memoryDraft) {
        if (isExpiredDraft(memoryDraft)) {
            await deleteDraft(draftId);
            return null;
        }
        return memoryDraft;
    }

    const result = await supabase
        .from(DRAFT_TABLE)
        .select('draft_id, user_id, instructions, payload, created_at')
        .eq('draft_id', draftId)
        .maybeSingle();

    if (result.error) {
        if (isMissingTableError(result.error)) {
            return null;
        }

        throw new Error(`讀取題目草稿失敗：${result.error.message}`);
    }

    if (!result.data) {
        return null;
    }

    const row = result.data as DraftRow;
    const record = {
        draftId: row.draft_id,
        userId: row.user_id,
        instructions: row.instructions,
        payload: row.payload,
        createdAt: row.created_at ?? new Date().toISOString(),
    };

    if (isExpiredDraft(record)) {
        await deleteDraft(draftId);
        return null;
    }

    draftStore.set(draftId, record);
    return record;
}

export async function getLatestDraftByUser(userId: string): Promise<QuestionDraftRecord | null> {
    const memoryDrafts = [...draftStore.values()].filter((draft) => draft.userId === userId);
    if (memoryDrafts.length > 0) {
        return memoryDrafts[memoryDrafts.length - 1] ?? null;
    }

    const result = await supabase
        .from(DRAFT_TABLE)
        .select('draft_id, user_id, instructions, payload, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);

    if (result.error) {
        if (isMissingTableError(result.error)) {
            return null;
        }

        throw new Error(`查詢最新題目草稿失敗：${result.error.message}`);
    }

    const row = (result.data?.[0] ?? null) as DraftRow | null;
    if (!row) {
        return null;
    }

    const record = {
        draftId: row.draft_id,
        userId: row.user_id,
        instructions: row.instructions,
        payload: row.payload,
        createdAt: row.created_at ?? new Date().toISOString(),
    };

    if (isExpiredDraft(record)) {
        await deleteDraft(record.draftId);
        return null;
    }

    draftStore.set(record.draftId, record);
    return record;
}

export async function generateQuestionDraft(userId: string, teacherPrompt: string): Promise<QuestionDraftRecord> {
    const payload = await generateQuestionJson(teacherPrompt);
    const record = {
        draftId: randomUUID(),
        userId,
        instructions: teacherPrompt,
        payload,
        createdAt: new Date().toISOString(),
    };

    await saveDraft(record);
    return record;
}

export async function generateShortAnswerQuestionPayload(teacherPrompt: string): Promise<GeneratedShortAnswerPayload> {
    return generateShortAnswerQuestionJson(teacherPrompt);
}

export async function reviseQuestionDraft(
    draftId: string,
    userId: string,
    revisionPrompt: string,
): Promise<QuestionDraftRecord> {
    const baseDraft = await getDraftById(draftId);

    if (!baseDraft || baseDraft.userId !== userId) {
        throw new Error('找不到可修改的題目草稿。這份草稿可能已失效、已建立或已被清除。');
    }

    const payload = await generateQuestionJson(buildDraftPrompt(baseDraft, revisionPrompt));
    const revisedDraft = {
        draftId: randomUUID(),
        userId,
        instructions: `${baseDraft.instructions}\n修訂：${revisionPrompt}`,
        payload,
        createdAt: new Date().toISOString(),
    };

    await deleteDraft(draftId);
    await saveDraft(revisedDraft);
    return revisedDraft;
}

export async function approveQuestionDraft(
    draftId: string,
    userId: string,
    categoryOverride?: string,
): Promise<QuestionRecord> {
    const draft = await getDraftById(draftId);

    if (!draft || draft.userId !== userId) {
        throw new Error('這份題目草稿已建立、已失效或已被清除。請重新生成。');
    }

    const question = await createMultipleChoiceQuestion({
        content: draft.payload.content,
        category: categoryOverride ?? draft.payload.category,
        options: draft.payload.options,
        correctAnswer: draft.payload.correct_answer,
        explanation: draft.payload.explanation,
    });

    await deleteDraft(draftId);
    return question;
}
