import { randomUUID } from 'crypto';
import { createMultipleChoiceQuestion, QuestionRecord } from './questionService';
import { supabase } from './supabase';

const geminiApiKey = process.env.GEMINI_API_KEY;
const questionModel = process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';

if (!geminiApiKey) {
    throw new Error('缺少必要環境變數：GEMINI_API_KEY');
}

type GeminiResponse = {
    candidates?: Array<{
        content?: {
            parts?: Array<{
                text?: string;
            }>;
        };
    }>;
};

export type BatchQuestionPayload = {
    category: string;
    content: string;
    options: string[];
    correct_answer: 'A' | 'B' | 'C' | 'D';
    explanation: string;
};

export type QuestionBatchDraftRecord = {
    batchId: string;
    userId: string;
    instructions: string;
    questions: BatchQuestionPayload[];
    createdAt: string;
};

type BatchDraftRow = {
    batch_id: string;
    user_id: string;
    instructions: string;
    questions: BatchQuestionPayload[];
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

async function generateBatchQuestions(prompt: string, count: number): Promise<BatchQuestionPayload[]> {
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${questionModel}:generateContent?key=${geminiApiKey}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                text: `${BATCH_GENERATION_PROMPT}\n\n老師需求：${prompt}\n\n題數：${count}`,
                            },
                        ],
                    },
                ],
                generationConfig: {
                    temperature: 0.7,
                    responseMimeType: 'application/json',
                },
            }),
        },
    );

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini 批次出題失敗：${response.status} ${errorText}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const rawText = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();

    if (!rawText) {
        throw new Error('Gemini 沒有回傳批次題目內容。');
    }

    return parseBatchQuestions(rawText, count);
}

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
        questions: row.questions,
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
        questions,
        createdAt: new Date().toISOString(),
    };

    await saveBatchDraft(record);
    return record;
}

export async function approveQuestionBatchDraft(batchId: string, userId: string): Promise<QuestionRecord[]> {
    const batchDraft = await getBatchDraftById(batchId);

    if (!batchDraft || batchDraft.userId !== userId) {
        throw new Error('這份批次草稿已建立、已失效或已被清除。請重新生成。');
    }

    const createdQuestions: QuestionRecord[] = [];
    for (const question of batchDraft.questions) {
        const createdQuestion = await createMultipleChoiceQuestion({
            content: question.content,
            category: question.category,
            options: question.options,
            correctAnswer: question.correct_answer,
            explanation: question.explanation,
        });
        createdQuestions.push(createdQuestion);
    }

    await deleteBatchDraft(batchId);
    return createdQuestions;
}

export async function discardQuestionBatchDraft(batchId: string, userId: string): Promise<void> {
    const batchDraft = await getBatchDraftById(batchId);

    if (!batchDraft || batchDraft.userId !== userId) {
        throw new Error('這份批次草稿已失效或已被清除。');
    }

    await deleteBatchDraft(batchId);
}
