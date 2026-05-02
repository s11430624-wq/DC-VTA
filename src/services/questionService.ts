import { supabase } from './supabase';

export type QuestionRecord = {
    id: number;
    category: string | null;
    question_type: string | null;
    content: string | null;
    metadata: Record<string, unknown> | null;
    embedding?: unknown[] | string | null;
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
