import { generateQuestionDraft } from './aiQuestionService';
import { getQuestionById, getRecentQuestions } from './questionService';
import { getAllQuizResponses } from './quizService';
import { getUserByDiscordId, getUsersByIds } from './userService';

type RankingStat = {
    userId: string;
    totalAnswered: number;
    correctCount: number;
    wrongCount: number;
    accuracy: number;
};

type AgentToolContext = {
    userId: string;
    userRole: string | null;
};

export type AgentToolCall =
    | { tool: 'get_my_profile' }
    | { tool: 'get_question'; questionId: number }
    | { tool: 'get_my_stats' }
    | { tool: 'get_rank'; limit?: number }
    | { tool: 'get_recent_questions'; limit?: number }
    | { tool: 'create_question'; instructions: string };

const getLimitedRankCount = (value: number | null | undefined) => {
    if (!value) return 10;
    return Math.max(1, Math.min(20, value));
};

const buildRankingStats = (responses: Awaited<ReturnType<typeof getAllQuizResponses>>): RankingStat[] => {
    const statsByUserId = new Map<string, RankingStat>();

    for (const response of responses) {
        const current = statsByUserId.get(response.user_id) ?? {
            userId: response.user_id,
            totalAnswered: 0,
            correctCount: 0,
            wrongCount: 0,
            accuracy: 0,
        };

        current.totalAnswered += 1;
        if (response.is_correct) {
            current.correctCount += 1;
        } else {
            current.wrongCount += 1;
        }
        current.accuracy = current.correctCount / current.totalAnswered;
        statsByUserId.set(response.user_id, current);
    }

    return [...statsByUserId.values()].sort((a, b) => {
        if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
        if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
        return b.totalAnswered - a.totalAnswered;
    });
};

const parseMetadata = (metadata: Record<string, unknown> | string | null) => {
    if (!metadata) return null;
    if (typeof metadata === 'string') {
        try {
            const parsed = JSON.parse(metadata) as unknown;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    }

    return metadata;
};

export const AGENT_TOOL_SPECS = [
    {
        name: 'get_my_profile',
        description: '查詢目前發問者自己的綁定資料與身份。',
    },
    {
        name: 'get_question',
        description: '依題目 ID 查詢題目內容、題型、選項、答案與解析。',
        input: { questionId: 'number' },
    },
    {
        name: 'get_my_stats',
        description: '查詢目前發問者自己的答題總數、答對數與答對率。',
    },
    {
        name: 'get_rank',
        description: '查詢排行榜前幾名，limit 介於 1 到 20。',
        input: { limit: 'number optional' },
    },
    {
        name: 'get_recent_questions',
        description: '查詢最近題庫資料，limit 介於 1 到 10。',
        input: { limit: 'number optional' },
    },
    {
        name: 'create_question',
        description: '老師專用。依需求生成一題四選一題目並直接寫入題庫。',
        input: { instructions: 'string' },
    },
] as const;

export async function runAgentTool(
    call: AgentToolCall,
    context: AgentToolContext,
): Promise<string> {
    void context.userRole;

    switch (call.tool) {
        case 'get_my_profile': {
            const user = await getUserByDiscordId(context.userId);
            if (!user) {
                return '查無目前使用者的綁定資料。';
            }

            return JSON.stringify({
                display_name: user.display_name,
                student_id: user.student_id,
                role: user.role,
            });
        }

        case 'get_question': {
            const question = await getQuestionById(call.questionId);
            if (!question) {
                return `查無題目 ID ${call.questionId}。`;
            }

            const metadata = parseMetadata(question.metadata);
            return JSON.stringify({
                id: question.id,
                category: question.category,
                question_type: question.question_type,
                content: question.content,
                options: metadata?.options ?? null,
                correct_answer: metadata?.correct_answer ?? null,
                explanation: metadata?.explanation ?? question.rubric ?? null,
            });
        }

        case 'get_my_stats': {
            const responses = await getAllQuizResponses();
            const myResponses = responses.filter((response) => response.user_id === context.userId);
            const correctCount = myResponses.filter((response) => response.is_correct).length;
            const totalAnswered = myResponses.length;
            const accuracy = totalAnswered === 0 ? 0 : Math.round((correctCount / totalAnswered) * 100);

            return JSON.stringify({
                user_id: context.userId,
                total_answered: totalAnswered,
                correct_count: correctCount,
                wrong_count: totalAnswered - correctCount,
                accuracy_percent: accuracy,
            });
        }

        case 'get_rank': {
            const limit = getLimitedRankCount(call.limit);
            const responses = await getAllQuizResponses();
            const topStats = buildRankingStats(responses).slice(0, limit);
            const users = await getUsersByIds(topStats.map((stat) => stat.userId));
            const usersById = new Map(users.map((user) => [user.user_id, user]));

            return JSON.stringify(topStats.map((stat, index) => ({
                rank: index + 1,
                display_name: usersById.get(stat.userId)?.display_name ?? '未知使用者',
                student_id: usersById.get(stat.userId)?.student_id ?? null,
                correct_count: stat.correctCount,
                total_answered: stat.totalAnswered,
                accuracy_percent: Math.round(stat.accuracy * 100),
            })));
        }

        case 'get_recent_questions': {
            const limit = Math.max(1, Math.min(10, call.limit ?? 5));
            const questions = await getRecentQuestions(limit);
            return JSON.stringify(questions.map((question) => ({
                id: question.id,
                category: question.category,
                question_type: question.question_type,
                content: question.content,
            })));
        }

        case 'create_question': {
            if (context.userRole !== 'teacher') {
                return '權限不足，只有老師可以透過 Agent 生成題目。';
            }

            const draft = await generateQuestionDraft(context.userId, call.instructions);
            return JSON.stringify({
                draft_id: draft.draftId,
                category: draft.payload.category,
                question_type: 'multiple_choice',
                content: draft.payload.content,
                options: draft.payload.options,
                correct_answer: draft.payload.correct_answer,
                explanation: draft.payload.explanation,
            });
        }
    }
}
