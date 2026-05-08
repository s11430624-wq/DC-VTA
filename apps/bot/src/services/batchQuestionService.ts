import { randomUUID } from 'crypto';
import { generateModelText } from './llmService';
import { createMultipleChoiceQuestion, QuestionRecord } from './questionService';
import { supabase } from './supabase';

const questionModel = process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';

export type BatchQuestionPayload = {
    category: string;
    content: string;
    options: string[];
    correct_answer: 'A' | 'B' | 'C' | 'D';
    explanation: string;
};

export type BatchDraftQuestionStatus = 'active' | 'created' | 'deleted';

export type BatchDraftQuestionItem = {
    itemId: string;
    status: BatchDraftQuestionStatus;
    payload: BatchQuestionPayload;
    createdQuestionId?: number | null;
};

export type QuestionBatchDraftRecord = {
    batchId: string;
    userId: string;
    instructions: string;
    questions: BatchDraftQuestionItem[];
    createdAt: string;
};

type BatchDraftRow = {
    batch_id: string;
    user_id: string;
    instructions: string;
    questions: Array<BatchQuestionPayload | BatchDraftQuestionItem>;
    created_at?: string;
};

const BATCH_DRAFT_TABLE = 'agent_batch_drafts';
const batchDraftStore = new Map<string, QuestionBatchDraftRecord>();
const BATCH_TTL_MS = 24 * 60 * 60 * 1000;

const BATCH_GENERATION_PROMPT = [
    '你是課堂測驗批次出題器。',
    '請根據老師的要求，一次產生多題高品質的四選一單選題。',
    '必須使用繁體中文。',
    '每題都要明確，不能有兩個以上正確答案。',
    '每題選項固定 4 個，不能使用 placeholder。',
    'correct_answer 只能是 A、B、C、D。',
    '所有題目需維持同主題，但內容與選項不要重複。',
    '只輸出 JSON，不要輸出 Markdown，不要輸出說明文字。',
    'JSON 結構必須是 {"questions":[{"category":"...","content":"...","options":["...","...","...","..."],"correct_answer":"A","explanation":"..."}]}。',
].join('\n');

const isMissingTableError = (error: { code?: string; message?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST205' || message.includes(BATCH_DRAFT_TABLE) || message.includes('relation');
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

function isExpiredBatch(draft: QuestionBatchDraftRecord): boolean {
    const createdAtMs = Date.parse(draft.createdAt);
    if (Number.isNaN(createdAtMs)) {
        return false;
    }

    return Date.now() - createdAtMs > BATCH_TTL_MS;
}

function validateQuestionPayload(question: Partial<BatchQuestionPayload>): BatchQuestionPayload {
    const options = Array.isArray(question.options)
        ? question.options.map((option) => String(option).trim()).filter((option) => option.length > 0)
        : [];

    if (typeof question.content !== 'string' || question.content.trim().length === 0) {
        throw new Error('AI 產生的批次題目缺少 content。');
    }

    if (typeof question.category !== 'string' || question.category.trim().length === 0) {
        throw new Error('AI 產生的批次題目缺少 category。');
    }

    if (options.length !== 4) {
        throw new Error('AI 產生的批次題目選項數量不正確。');
    }

    if (
        question.correct_answer !== 'A'
        && question.correct_answer !== 'B'
        && question.correct_answer !== 'C'
        && question.correct_answer !== 'D'
    ) {
        throw new Error('AI 產生的批次題目正確答案格式錯誤。');
    }

    return {
        category: question.category.trim(),
        content: question.content.trim(),
        options,
        correct_answer: question.correct_answer,
        explanation: typeof question.explanation === 'string' ? question.explanation.trim() : '',
    };
}

function parseBatchQuestions(rawText: string, expectedCount: number): BatchQuestionPayload[] {
    const parsed = JSON.parse(stripCodeFences(rawText)) as {
        questions?: Partial<BatchQuestionPayload>[];
    };

    if (!Array.isArray(parsed.questions) || parsed.questions.length !== expectedCount) {
        throw new Error(`AI 批次出題數量不正確，預期 ${expectedCount} 題。`);
    }

    return parsed.questions.map((question) => validateQuestionPayload(question));
}

function createBatchDraftQuestionItem(payload: BatchQuestionPayload): BatchDraftQuestionItem {
    return {
        itemId: randomUUID(),
        status: 'active',
        payload,
        createdQuestionId: null,
    };
}

function isBatchDraftQuestionItem(question: BatchQuestionPayload | BatchDraftQuestionItem): question is BatchDraftQuestionItem {
    return typeof question === 'object'
        && question !== null
        && 'itemId' in question
        && 'payload' in question
        && 'status' in question;
}

function normalizeBatchDraftQuestions(
    questions: Array<BatchQuestionPayload | BatchDraftQuestionItem>,
): BatchDraftQuestionItem[] {
    return questions.map((question) => {
        if (!isBatchDraftQuestionItem(question)) {
            return createBatchDraftQuestionItem(validateQuestionPayload(question));
        }

        return {
            itemId: typeof question.itemId === 'string' && question.itemId.trim().length > 0 ? question.itemId : randomUUID(),
            status: question.status === 'created' || question.status === 'deleted' ? question.status : 'active',
            payload: validateQuestionPayload(question.payload),
            createdQuestionId: typeof question.createdQuestionId === 'number' ? question.createdQuestionId : null,
        };
    });
}

function getPendingDraftItems(questions: BatchDraftQuestionItem[]): BatchDraftQuestionItem[] {
    return questions.filter((question) => question.status === 'active');
}

function getVisibleDraftItems(questions: BatchDraftQuestionItem[]): BatchDraftQuestionItem[] {
    return questions.filter((question) => question.status !== 'deleted');
}

function markQuestionCreated(
    questions: BatchDraftQuestionItem[],
    itemId: string,
    createdQuestionId: number,
): BatchDraftQuestionItem[] {
    return questions.map((question) => (
        question.itemId === itemId
            ? {
                ...question,
                status: 'created',
                createdQuestionId,
            }
            : question
    ));
}

function markQuestionDeleted(questions: BatchDraftQuestionItem[], itemId: string): BatchDraftQuestionItem[] {
    return questions.map((question) => (
        question.itemId === itemId
            ? {
                ...question,
                status: 'deleted',
            }
            : question
    ));
}

function replaceDraftQuestion(
    questions: BatchDraftQuestionItem[],
    itemId: string,
    payload: BatchQuestionPayload,
): BatchDraftQuestionItem[] {
    return questions.map((question) => (
        question.itemId === itemId
            ? {
                ...question,
                status: 'active',
                createdQuestionId: null,
                payload,
            }
            : question
    ));
}

async function generateBatchQuestions(prompt: string, count: number): Promise<BatchQuestionPayload[]> {
    const rawText = await generateModelText({
        model: questionModel,
        prompt: `${BATCH_GENERATION_PROMPT}\n\n老師需求：${prompt}\n\n題數：${count}`,
        temperature: 0.7,
        responseMimeType: 'application/json',
    });

    if (!rawText) {
        throw new Error('LLM 沒有回傳批次題目內容。');
    }

    return parseBatchQuestions(rawText, count);
}

async function regenerateSingleBatchQuestion(
    instructions: string,
    currentQuestion: BatchQuestionPayload,
    revisionPrompt: string,
): Promise<BatchQuestionPayload> {
    const rawText = await generateModelText({
        model: questionModel,
        prompt: [
            BATCH_GENERATION_PROMPT,
            '',
            `原始老師需求：${instructions}`,
            '請只重寫 1 題四選一單選題。',
            '你必須保留同主題，但依照老師補充要求調整內容。',
            '新的題目不能只是原題的輕微改寫，請明顯反映修改要求。',
            `目前題目：${JSON.stringify(currentQuestion)}`,
            `老師補充修改要求：${revisionPrompt}`,
            '只輸出 JSON，不要輸出 Markdown。',
            'JSON 結構必須是 {"questions":[{"category":"...","content":"...","options":["...","...","...","..."],"correct_answer":"A","explanation":"..."}]}。',
        ].join('\n'),
        temperature: 0.7,
        responseMimeType: 'application/json',
    });

    if (!rawText) {
        throw new Error('LLM 沒有回傳重生題目內容。');
    }

    return parseBatchQuestions(rawText, 1)[0]!;
}

export const __batchQuestionServiceForTests = {
    parseBatchQuestions,
    normalizeBatchDraftQuestions,
    getPendingDraftItems,
    getVisibleDraftItems,
    markQuestionCreated,
    markQuestionDeleted,
    replaceDraftQuestion,
};

async function saveBatchDraft(record: QuestionBatchDraftRecord): Promise<void> {
    batchDraftStore.set(record.batchId, record);

    const result = await supabase
        .from(BATCH_DRAFT_TABLE)
        .upsert({
            batch_id: record.batchId,
            user_id: record.userId,
            instructions: record.instructions,
            questions: record.questions,
        });

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`寫入批次草稿失敗：${result.error.message}`);
    }
}

async function deleteBatchDraft(batchId: string): Promise<void> {
    batchDraftStore.delete(batchId);

    const result = await supabase
        .from(BATCH_DRAFT_TABLE)
        .delete()
        .eq('batch_id', batchId);

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`刪除批次草稿失敗：${result.error.message}`);
    }
}

export async function getBatchDraftById(batchId: string): Promise<QuestionBatchDraftRecord | null> {
    const memoryDraft = batchDraftStore.get(batchId);
    if (memoryDraft) {
        if (isExpiredBatch(memoryDraft)) {
            await deleteBatchDraft(batchId);
            return null;
        }

        return memoryDraft;
    }

    const result = await supabase
        .from(BATCH_DRAFT_TABLE)
        .select('batch_id, user_id, instructions, questions, created_at')
        .eq('batch_id', batchId)
        .maybeSingle();

    if (result.error) {
        if (isMissingTableError(result.error)) {
            return null;
        }

        throw new Error(`讀取批次草稿失敗：${result.error.message}`);
    }

    if (!result.data) {
        return null;
    }

    const row = result.data as BatchDraftRow;
    const record = {
        batchId: row.batch_id,
        userId: row.user_id,
        instructions: row.instructions,
        questions: normalizeBatchDraftQuestions(row.questions),
        createdAt: row.created_at ?? new Date().toISOString(),
    };

    if (isExpiredBatch(record)) {
        await deleteBatchDraft(batchId);
        return null;
    }

    batchDraftStore.set(batchId, record);
    return record;
}

export async function clearBatchDraftsByUser(userId: string): Promise<void> {
    for (const [batchId, batchDraft] of batchDraftStore.entries()) {
        if (batchDraft.userId === userId) {
            batchDraftStore.delete(batchId);
        }
    }

    const result = await supabase
        .from(BATCH_DRAFT_TABLE)
        .delete()
        .eq('user_id', userId);

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`清除批次草稿失敗：${result.error.message}`);
    }
}

export async function generateQuestionBatchDraft(
    userId: string,
    prompt: string,
    count: number,
): Promise<QuestionBatchDraftRecord> {
    const questions = await generateBatchQuestions(prompt, count);
    const record = {
        batchId: randomUUID(),
        userId,
        instructions: prompt,
        questions: normalizeBatchDraftQuestions(questions),
        createdAt: new Date().toISOString(),
    };

    await saveBatchDraft(record);
    return record;
}

export async function approveQuestionBatchDraft(
    batchId: string,
    userId: string,
    categoryOverride?: string,
): Promise<QuestionRecord[]> {
    const batchDraft = await getBatchDraftById(batchId);

    if (!batchDraft || batchDraft.userId !== userId) {
        throw new Error('這份批次草稿已建立、已失效或已被清除。請重新生成。');
    }

    const pendingQuestions = getPendingDraftItems(batchDraft.questions);
    if (pendingQuestions.length === 0) {
        throw new Error('這份批次草稿沒有可建立的題目了。');
    }

    const createdQuestions: QuestionRecord[] = [];
    let nextQuestions = [...batchDraft.questions];
    for (const question of pendingQuestions) {
        const createdQuestion = await createMultipleChoiceQuestion({
            content: question.payload.content,
            category: categoryOverride ?? question.payload.category,
            options: question.payload.options,
            correctAnswer: question.payload.correct_answer,
            explanation: question.payload.explanation,
        });
        createdQuestions.push(createdQuestion);
        nextQuestions = markQuestionCreated(nextQuestions, question.itemId, createdQuestion.id);
    }

    await saveBatchDraft({
        ...batchDraft,
        questions: nextQuestions,
    });
    return createdQuestions;
}

export async function discardQuestionBatchDraft(batchId: string, userId: string): Promise<void> {
    const batchDraft = await getBatchDraftById(batchId);

    if (!batchDraft || batchDraft.userId !== userId) {
        throw new Error('這份批次草稿已失效或已被清除。');
    }

    await deleteBatchDraft(batchId);
}

export async function createSingleQuestionFromBatchDraft(
    batchId: string,
    userId: string,
    itemId: string,
    categoryOverride?: string,
): Promise<{ question: QuestionRecord; draft: QuestionBatchDraftRecord; item: BatchDraftQuestionItem }> {
    const batchDraft = await getBatchDraftById(batchId);

    if (!batchDraft || batchDraft.userId !== userId) {
        throw new Error('這份批次草稿已失效、已建立或已被清除。請重新生成。');
    }

    const targetItem = batchDraft.questions.find((question) => question.itemId === itemId);
    if (!targetItem || targetItem.status === 'deleted') {
        throw new Error('找不到這一題，或這題已被刪除。');
    }

    if (targetItem.status === 'created') {
        throw new Error('這一題已經建立過了。');
    }

    const question = await createMultipleChoiceQuestion({
        content: targetItem.payload.content,
        category: categoryOverride ?? targetItem.payload.category,
        options: targetItem.payload.options,
        correctAnswer: targetItem.payload.correct_answer,
        explanation: targetItem.payload.explanation,
    });

    const nextDraft = {
        ...batchDraft,
        questions: markQuestionCreated(batchDraft.questions, itemId, question.id),
    };
    await saveBatchDraft(nextDraft);

    return {
        question,
        draft: nextDraft,
        item: nextDraft.questions.find((draftQuestion) => draftQuestion.itemId === itemId)!,
    };
}

export async function deleteSingleQuestionFromBatchDraft(
    batchId: string,
    userId: string,
    itemId: string,
): Promise<QuestionBatchDraftRecord> {
    const batchDraft = await getBatchDraftById(batchId);

    if (!batchDraft || batchDraft.userId !== userId) {
        throw new Error('這份批次草稿已失效、已建立或已被清除。請重新生成。');
    }

    const targetItem = batchDraft.questions.find((question) => question.itemId === itemId);
    if (!targetItem) {
        throw new Error('找不到這一題。');
    }

    const nextDraft = {
        ...batchDraft,
        questions: markQuestionDeleted(batchDraft.questions, itemId),
    };
    await saveBatchDraft(nextDraft);
    return nextDraft;
}

export async function reviseSingleQuestionFromBatchDraft(
    batchId: string,
    userId: string,
    itemId: string,
    revisionPrompt: string,
): Promise<QuestionBatchDraftRecord> {
    const batchDraft = await getBatchDraftById(batchId);

    if (!batchDraft || batchDraft.userId !== userId) {
        throw new Error('這份批次草稿已失效、已建立或已被清除。請重新生成。');
    }

    const targetItem = batchDraft.questions.find((question) => question.itemId === itemId);
    if (!targetItem || targetItem.status === 'deleted') {
        throw new Error('找不到這一題，或這題已被刪除。');
    }

    const trimmedPrompt = revisionPrompt.trim();
    if (!trimmedPrompt) {
        throw new Error('請輸入修改要求後再重生。');
    }

    const replacement = await regenerateSingleBatchQuestion(
        batchDraft.instructions,
        targetItem.payload,
        trimmedPrompt,
    );

    const nextDraft = {
        ...batchDraft,
        questions: replaceDraftQuestion(batchDraft.questions, itemId, replacement),
    };
    await saveBatchDraft(nextDraft);
    return nextDraft;
}
