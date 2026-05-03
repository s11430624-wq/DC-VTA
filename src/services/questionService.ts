import { supabase } from './supabase';

export type QuestionRecord = {
    id: number;
    category: string | null;
    question_type: string | null;
    content: string | null;
    metadata: Record<string, unknown> | string | null;
    explanation?: string | null;
    embedding?: unknown[] | string | null;
    rubric?: string | null;
};

type CreateMultipleChoiceQuestionInput = {
    content: string;
    category?: string;
    options: string[];
    correctAnswer: 'A' | 'B' | 'C' | 'D';
    explanation?: string;
};

type CreateShortAnswerQuestionInput = {
    content: string;
    category?: string;
    rubric: string;
};

const isMissingRubricColumn = (error: { message?: string; code?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST204' || message.includes('rubric');
};

export async function getRecentQuestions(limit = 10): Promise<QuestionRecord[]> {
    const { data, error } = await supabase
        .from('question_bank')
        .select('*')
        .order('id', { ascending: false })
        .limit(limit);

    if (error) {
        throw new Error(`查詢題庫失敗：${error.message}`);
    }

    return (data ?? []) as QuestionRecord[];
}

export async function getQuestionById(id: number): Promise<QuestionRecord | null> {
    const { data, error } = await supabase
        .from('question_bank')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (error) {
        throw new Error(`查詢題目失敗：${error.message}`);
    }

    return data as QuestionRecord | null;
}

export async function addMultipleChoiceQuestion(content: string): Promise<QuestionRecord> {
    return createMultipleChoiceQuestion({
        content,
        category: '一般',
        options: ['選項A', '選項B', '選項C', '選項D'],
        correctAnswer: 'A',
        explanation: '',
    });
}

export async function createMultipleChoiceQuestion(input: CreateMultipleChoiceQuestionInput): Promise<QuestionRecord> {
    const payload = {
        content: input.content,
        category: input.category ?? '一般',
        question_type: 'multiple_choice',
        explanation: input.explanation ?? '',
        metadata: {
            options: input.options,
            correct_answer: input.correctAnswer,
            explanation: input.explanation ?? '',
        },
        rubric: null,
    };

    const insertWithoutRubric = async () => {
        const { rubric, ...payloadWithoutRubric } = payload;
        return supabase
            .from('question_bank')
            .insert(payloadWithoutRubric)
            .select('*')
            .single();
    };

    const result = await supabase
        .from('question_bank')
        .insert(payload)
        .select('*')
        .single();

    if (result.error) {
        if (isMissingRubricColumn(result.error)) {
            const fallbackResult = await insertWithoutRubric();
            if (fallbackResult.error) {
                throw new Error(`新增題目失敗：${fallbackResult.error.message}`);
            }

            return fallbackResult.data as QuestionRecord;
        }

        throw new Error(`新增題目失敗：${result.error.message}`);
    }

    return result.data as QuestionRecord;
}

export async function createShortAnswerQuestion(input: CreateShortAnswerQuestionInput): Promise<QuestionRecord> {
    const payload = {
        content: input.content,
        category: input.category ?? '一般',
        question_type: 'short_answer',
        explanation: null,
        metadata: {
            rubric: input.rubric,
        },
        rubric: input.rubric,
    };

    const insertWithoutRubric = async () => {
        const { rubric, ...payloadWithoutRubric } = payload;
        return supabase
            .from('question_bank')
            .insert(payloadWithoutRubric)
            .select('*')
            .single();
    };

    const result = await supabase
        .from('question_bank')
        .insert(payload)
        .select('*')
        .single();

    if (result.error) {
        if (isMissingRubricColumn(result.error)) {
            const fallbackResult = await insertWithoutRubric();
            if (fallbackResult.error) {
                throw new Error(`新增短答題失敗：${fallbackResult.error.message}`);
            }

            return fallbackResult.data as QuestionRecord;
        }

        throw new Error(`新增短答題失敗：${result.error.message}`);
    }

    return result.data as QuestionRecord;
}
