import type { QuestionRecord } from './questionService';
import { supabase } from './supabase';

export type QuizResponse = {
    user_id: string;
    question_id: number;
    group_id?: string | null;
    selected_option: string | null;
    is_correct: boolean;
    reaction_time?: number | null;
    answer_text?: string | null;
    status?: string | null;
    score?: number | null;
    created_at?: string | null;
};

export type UserQuizStats = {
    totalAnswered: number;
    correctCount: number;
    wrongCount: number;
    accuracyPercent: number;
};

const formatHistoryTimestamp = (isoLike?: string | null): string => {
    if (!isoLike) {
        return '時間未知';
    }

    const date = new Date(isoLike);
    if (Number.isNaN(date.getTime())) {
        return '時間未知';
    }

    return date.toLocaleString('zh-TW', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
};

const truncateText = (value: string, maxLength: number): string => (
    value.length <= maxLength ? value : `${value.slice(0, Math.max(maxLength - 1, 1))}…`
);

const buildHistoryResultLabel = (response: QuizResponse, question?: QuestionRecord): string => {
    const questionType = question?.question_type ?? null;
    if (questionType === 'short_answer' || questionType === 'survey') {
        if (response.status === 'pending') {
            return '待批改';
        }
        if (typeof response.score === 'number') {
            return `${response.score} 分`;
        }
        return response.is_correct ? '已批改' : '已送出';
    }

    return response.is_correct ? '答對' : '答錯';
};

const buildHistoryAnswerLabel = (response: QuizResponse, question?: QuestionRecord): string => {
    const questionType = question?.question_type ?? null;
    if (questionType === 'short_answer' || questionType === 'survey') {
        const rawText = response.answer_text?.trim();
        return `簡答：${truncateText(rawText || '未填答', 18)}`;
    }

    return `選 ${response.selected_option ?? '-'}`;
};

export function formatRecentHistoryLines(
    responses: QuizResponse[],
    questions: QuestionRecord[],
    limit = 10,
): string[] {
    const questionMap = new Map(questions.map((question) => [question.id, question]));

    return [...responses]
        .sort((a, b) => {
            const aTime = new Date(a.created_at ?? 0).getTime();
            const bTime = new Date(b.created_at ?? 0).getTime();
            return bTime - aTime;
        })
        .slice(0, limit)
        .map((response) => {
            const question = questionMap.get(response.question_id);
            const title = truncateText(question?.content?.trim() || '題目已刪除或不可用', 14);
            return `• [${formatHistoryTimestamp(response.created_at)}] #${response.question_id} ${title}｜${buildHistoryAnswerLabel(response, question)}｜${buildHistoryResultLabel(response, question)}`;
        });
}

export function isRankEligibleResponse(response: QuizResponse): boolean {
    return response.status === 'graded' || response.status === null || response.status === undefined;
}

export async function getExistingResponse(
    userId: string,
    questionId: number,
): Promise<QuizResponse | null> {
    const { data, error } = await supabase
        .from('quiz_responses')
        .select('*')
        .eq('user_id', userId)
        .eq('question_id', questionId)
        .limit(1);

    if (error) {
        throw new Error(`查詢作答紀錄失敗：${error.message}`);
    }

    return (data?.[0] ?? null) as QuizResponse | null;
}

export async function upsertQuizResponse(data: QuizResponse): Promise<{ response: QuizResponse; updated: boolean }> {
    const existingResponse = await getExistingResponse(data.user_id, data.question_id);

    if (existingResponse) {
        const { error } = await supabase
            .from('quiz_responses')
            .update({
                group_id: data.group_id ?? null,
                selected_option: data.selected_option,
                is_correct: data.is_correct,
                reaction_time: data.reaction_time ?? null,
                answer_text: data.answer_text ?? null,
                status: data.status ?? 'graded',
            })
            .eq('user_id', data.user_id)
            .eq('question_id', data.question_id);

        if (error) {
            throw new Error(`儲存作答紀錄失敗：${error.message}`);
        }

        return {
            response: data,
            updated: true,
        };
    }

    const result = await supabase
        .from('quiz_responses')
        .insert({
            ...data,
            group_id: data.group_id ?? null,
            reaction_time: data.reaction_time ?? null,
            answer_text: data.answer_text ?? null,
            status: data.status ?? 'graded',
        })
        .select('*')
        .single();

    if (result.error) {
        throw new Error(`儲存作答紀錄失敗：${result.error.message}`);
    }

    return {
        response: result.data as QuizResponse,
        updated: false,
    };
}

export async function getResponsesByQuestionId(questionId: number): Promise<QuizResponse[]> {
    const { data, error } = await supabase
        .from('quiz_responses')
        .select('*')
        .eq('question_id', questionId);

    if (error) {
        throw new Error(`查詢題目作答紀錄失敗：${error.message}`);
    }

    return (data ?? []) as QuizResponse[];
}

export async function getAllQuizResponses(): Promise<QuizResponse[]> {
    const { data, error } = await supabase
        .from('quiz_responses')
        .select('*');

    if (error) {
        throw new Error(`查詢全部作答紀錄失敗：${error.message}`);
    }

    return (data ?? []) as QuizResponse[];
}

export async function getPendingQuizResponses(): Promise<QuizResponse[]> {
    const { data, error } = await supabase
        .from('quiz_responses')
        .select('*')
        .eq('status', 'pending');

    if (error) {
        throw new Error(`查詢待處理作答紀錄失敗：${error.message}`);
    }

    return (data ?? []) as QuizResponse[];
}

export async function getUserQuizStats(userId: string): Promise<UserQuizStats> {
    const responses = await getAllQuizResponses();
    const userResponses = responses.filter((response) => response.user_id === userId && isRankEligibleResponse(response));
    const correctCount = userResponses.filter((response) => response.is_correct).length;
    const totalAnswered = userResponses.length;

    return {
        totalAnswered,
        correctCount,
        wrongCount: totalAnswered - correctCount,
        accuracyPercent: totalAnswered === 0 ? 0 : Math.round((correctCount / totalAnswered) * 100),
    };
}

export async function getRecentQuizResponsesByUserId(userId: string, limit = 10): Promise<QuizResponse[]> {
    const { data, error } = await supabase
        .from('quiz_responses')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        throw new Error(`查詢個人作答紀錄失敗：${error.message}`);
    }

    return (data ?? []) as QuizResponse[];
}

export async function getQuizResponsesByUserIds(userIds: string[]): Promise<QuizResponse[]> {
    if (userIds.length === 0) {
        return [];
    }

    const { data, error } = await supabase
        .from('quiz_responses')
        .select('*')
        .in('user_id', userIds);

    if (error) {
        throw new Error(`依使用者查詢作答紀錄失敗：${error.message}`);
    }

    return (data ?? []) as QuizResponse[];
}

export async function getQuizResponsesByGroupId(groupId: string): Promise<QuizResponse[]> {
    const { data, error } = await supabase
        .from('quiz_responses')
        .select('*')
        .eq('group_id', groupId);

    if (error) {
        throw new Error(`依群組查詢作答紀錄失敗：${error.message}`);
    }

    return (data ?? []) as QuizResponse[];
}

export const __quizServiceForTests = {
    formatRecentHistoryLines,
};
