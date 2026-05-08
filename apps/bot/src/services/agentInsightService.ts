import { formatAgentStructuredReply, type AgentAnalysisIntent } from './agentAnalysisRuntime';
import { getQuestionsByIds } from './questionService';
import { getQuizResponsesByGroupId, type QuizResponse } from './quizService';
import { getUserByDiscordId, getUsersByIds, type UserRecord } from './userService';

type StructuredInsightParams = {
    intent: AgentAnalysisIntent;
    channelId: string;
    userId: string;
    question: string;
    isTeacher: boolean;
};

type QuestionAggregate = {
    questionId: number;
    attempts: number;
    correct: number;
    wrong: number;
    pending: number;
    accuracyPercent: number;
};

type InsightDependencies = {
    getQuizResponsesByGroupId: (groupId: string) => Promise<QuizResponse[]>;
    getQuestionsByIds: (ids: number[]) => Promise<Array<{ id: number; content: string | null }>>;
    getUserByDiscordId: (userId: string) => Promise<UserRecord | null>;
    getUsersByIds: (userIds: string[]) => Promise<UserRecord[]>;
};

const MIN_ANALYSIS_SAMPLE = 3;

const toDisplayName = (user: UserRecord | undefined) => user?.display_name?.trim() || user?.student_id?.trim() || '未知學生';

const buildQuestionSnippet = (content: string | null | undefined) => {
    const text = (content ?? '').trim();
    return text.length > 20 ? `${text.slice(0, 20)}...` : text || '（無題目內容）';
};

const aggregateQuestions = (responses: QuizResponse[]): QuestionAggregate[] => {
    const byQuestion = new Map<number, QuestionAggregate>();

    for (const response of responses) {
        const current = byQuestion.get(response.question_id) ?? {
            questionId: response.question_id,
            attempts: 0,
            correct: 0,
            wrong: 0,
            pending: 0,
            accuracyPercent: 0,
        };

        current.attempts += 1;
        if (response.status === 'pending') {
            current.pending += 1;
        } else if (response.is_correct) {
            current.correct += 1;
        } else {
            current.wrong += 1;
        }

        const gradedAttempts = current.correct + current.wrong;
        current.accuracyPercent = gradedAttempts > 0
            ? Math.round((current.correct / gradedAttempts) * 100)
            : 0;

        byQuestion.set(response.question_id, current);
    }

    return [...byQuestion.values()];
};

const buildRanking = async (responses: QuizResponse[]) => {
    const byUser = new Map<string, { total: number; correct: number; wrong: number }>();

    for (const response of responses) {
        const current = byUser.get(response.user_id) ?? { total: 0, correct: 0, wrong: 0 };
        if (response.status !== 'pending') {
            current.total += 1;
            if (response.is_correct) {
                current.correct += 1;
            } else {
                current.wrong += 1;
            }
        }
        byUser.set(response.user_id, current);
    }

    const ranked = [...byUser.entries()]
        .map(([userId, stat]) => ({
            userId,
            total: stat.total,
            correct: stat.correct,
            wrong: stat.wrong,
            accuracyPercent: stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0,
        }))
        .sort((a, b) => b.correct - a.correct || b.accuracyPercent - a.accuracyPercent || b.total - a.total);

    const users = await getUsersByIds(ranked.map((item) => item.userId));
    const usersById = new Map(users.map((user) => [user.user_id, user]));

    return ranked.map((item, index) => ({
        rank: index + 1,
        ...item,
        name: toDisplayName(usersById.get(item.userId)),
    }));
};

const findTargetStudent = async (question: string, responses: QuizResponse[]) => {
    const userIds = [...new Set(responses.map((response) => response.user_id))];
    const users = await getUsersByIds(userIds);
    const normalizedQuestion = question.replace(/\s+/g, '').toLowerCase();

    const matched = users.find((user) => {
        const studentId = user.student_id?.replace(/\s+/g, '').toLowerCase() ?? '';
        const displayName = user.display_name?.replace(/\s+/g, '').toLowerCase() ?? '';
        return (studentId.length > 0 && normalizedQuestion.includes(studentId))
            || (displayName.length > 0 && normalizedQuestion.includes(displayName));
    });

    return matched ?? null;
};

const getUserScopedResponses = (responses: QuizResponse[], userId: string) => responses.filter((response) => response.user_id === userId);

const formatNoDataReply = (summary: string, suggestion: string) => formatAgentStructuredReply({
    summary,
    findings: ['目前查不到足夠的作答資料。'],
    suggestions: [suggestion],
    caveat: '若這個班級或學生剛開始使用系統，請先累積更多作答紀錄再分析。',
});

export function createStructuredInsightBuilder(deps: InsightDependencies) {
    return async function buildStructuredInsight(params: StructuredInsightParams): Promise<string | null> {
        const responses = await deps.getQuizResponsesByGroupId(params.channelId);
        const aggregates = aggregateQuestions(responses);

        switch (params.intent) {
            case 'class_overview': {
                if (responses.length === 0) {
                    return formatNoDataReply('目前這個頻道還沒有可分析的班級資料。', '先開放題目並累積作答後，我再幫你整理班級概況。');
                }

                const uniqueStudents = new Set(responses.map((response) => response.user_id)).size;
                const graded = responses.filter((response) => response.status !== 'pending');
                const pending = responses.filter((response) => response.status === 'pending').length;
                const correct = graded.filter((response) => response.is_correct).length;
                const accuracy = graded.length > 0 ? Math.round((correct / graded.length) * 100) : 0;
                const weakQuestion = [...aggregates].sort((a, b) => b.wrong - a.wrong || a.accuracyPercent - b.accuracyPercent)[0];

                return formatAgentStructuredReply({
                    summary: `目前本頻道共有 ${uniqueStudents} 位學生、${responses.length} 份作答資料，整體答對率約 ${accuracy}%。`,
                    findings: [
                        `已批改 ${graded.length} 份，待批改 ${pending} 份。`,
                        `涉及 ${aggregates.length} 題題目。`,
                        weakQuestion ? `目前最需要關注的是題目 ${weakQuestion.questionId}，共有 ${weakQuestion.wrong} 人答錯。` : '目前沒有明顯的高錯題目。',
                    ],
                    suggestions: [
                        pending > 0 ? '先處理待批改短答，避免分析被未完成資料拉偏。' : '可先查看錯題最多的題目並安排講解。',
                        accuracy < 60 ? '整體答對率偏低，建議先做一次全班錯題複盤。' : '可優先關注低表現學生是否需要額外提醒。',
                    ],
                    caveat: graded.length < MIN_ANALYSIS_SAMPLE ? '目前樣本數偏少，分析方向僅供參考。' : null,
                });
            }

            case 'mistake_hotspots': {
                const hotspotIds = aggregates
                    .filter((item) => item.wrong > 0)
                    .sort((a, b) => b.wrong - a.wrong || a.accuracyPercent - b.accuracyPercent)
                    .slice(0, 3);

                if (hotspotIds.length === 0) {
                    return formatNoDataReply('目前還沒有足夠的錯題資料可整理熱點。', '先累積更多已批改作答，之後我可以幫你抓出最常錯的題目。');
                }

                const questions = await deps.getQuestionsByIds(hotspotIds.map((item) => item.questionId));
                const byId = new Map(questions.map((question) => [question.id, question]));

                return formatAgentStructuredReply({
                    summary: `目前最常錯的 ${hotspotIds.length} 題已整理出來，適合優先講解。`,
                    findings: hotspotIds.map((item) => {
                        const question = byId.get(item.questionId);
                        return `題目 ${item.questionId}「${buildQuestionSnippet(question?.content)}」共 ${item.wrong} 人答錯，答對率 ${item.accuracyPercent}%。`;
                    }),
                    suggestions: [
                        '先重講錯誤率最高的題目，再補一題同概念練習。',
                        '若同一題同時錯很多，優先檢查題幹是否容易誤解。',
                    ],
                    caveat: hotspotIds.some((item) => item.attempts < MIN_ANALYSIS_SAMPLE) ? '部分題目的作答樣本還不多，請搭配課堂觀察一起判斷。' : null,
                });
            }

            case 'student_observation': {
                const target = await findTargetStudent(params.question, responses);
                if (!target) {
                    return formatAgentStructuredReply({
                        summary: '我還沒辦法確定你要觀察的是哪位學生。',
                        findings: ['目前沒有從這段訊息中穩定辨識出學生姓名或學號。'],
                        suggestions: ['請直接補學生姓名或學號，例如「觀察一下王小明最近是不是狀況不好」。'],
                    });
                }

                const studentResponses = getUserScopedResponses(responses, target.user_id);
                if (studentResponses.length === 0) {
                    return formatNoDataReply(`目前查不到 ${toDisplayName(target)} 在這個頻道的作答資料。`, '請確認學生是否已在這個班級頻道作答。');
                }

                const graded = studentResponses.filter((response) => response.status !== 'pending');
                const correct = graded.filter((response) => response.is_correct).length;
                const accuracy = graded.length > 0 ? Math.round((correct / graded.length) * 100) : 0;

                return formatAgentStructuredReply({
                    summary: `${toDisplayName(target)} 目前共有 ${studentResponses.length} 份作答，答對率約 ${accuracy}%。`,
                    findings: [
                        `已批改 ${graded.length} 份，待批改 ${studentResponses.length - graded.length} 份。`,
                        accuracy < 60 ? '目前表現偏弱，屬於需要優先關注的學生。' : '目前整體表現尚可，可持續追蹤後續變化。',
                        graded.length === 0 ? '目前還沒有已批改資料，暫時不能下明確學習判斷。' : `已批改資料中答對 ${correct} 題、答錯 ${graded.length - correct} 題。`,
                    ],
                    suggestions: [
                        accuracy < 60 ? '建議先和學生確認是否卡在觀念理解或只是沒跟上題目節奏。' : '可以搭配下一次作答再看是否穩定維持。',
                        '若要更精準判斷，建議再搭配學生最近錯題內容一起看。',
                    ],
                    caveat: graded.length < MIN_ANALYSIS_SAMPLE ? '目前樣本數偏少，請不要只靠這次資料就下定論。' : null,
                });
            }

            case 'question_quality_check': {
            const sorted = aggregates
                .filter((item) => item.attempts >= MIN_ANALYSIS_SAMPLE)
                .sort((a, b) => a.accuracyPercent - b.accuracyPercent || b.attempts - a.attempts)
                .slice(0, 4);

            if (sorted.length === 0) {
                return formatNoDataReply('目前還沒有足夠樣本可檢查題目品質。', '至少累積幾輪已批改作答後，再看哪些題目太難或太簡單。');
            }

            const questions = await deps.getQuestionsByIds(sorted.map((item) => item.questionId));
            const byId = new Map(questions.map((question) => [question.id, question]));
            const findings = sorted.map((item) => {
                const difficulty = item.accuracyPercent <= 30 ? '偏難' : item.accuracyPercent >= 90 ? '偏簡單' : '中間';
                return `題目 ${item.questionId}「${buildQuestionSnippet(byId.get(item.questionId)?.content)}」答對率 ${item.accuracyPercent}%，目前看起來 ${difficulty}。`;
            });

            return formatAgentStructuredReply({
                summary: '已根據目前作答樣本整理出最值得檢查的題目品質風險。',
                findings,
                suggestions: [
                    '答對率過低的題目先檢查題幹是否不夠清楚，或是否跨了還沒教穩的概念。',
                    '答對率過高的題目可考慮提高選項干擾度，避免鑑別度不足。',
                ],
            });
        }

            case 'rank_interpretation': {
            const ranking = await buildRankingWithDeps(responses, deps.getUsersByIds);
            if (ranking.length === 0) {
                return formatNoDataReply('目前這個頻道還沒有排行榜資料可解讀。', '先累積一些已批改作答後，我再幫你看前段與風險群。');
            }

            const top = ranking.slice(0, 3);
            const tail = ranking.slice(-2);

            return formatAgentStructuredReply({
                summary: `目前排行榜前段由 ${top.map((item) => item.name).join('、')} 領先。`,
                findings: [
                    `第一名 ${top[0]?.name ?? '未知'} 目前答對 ${top[0]?.correct ?? 0} 題、答對率 ${top[0]?.accuracyPercent ?? 0}%。`,
                    tail.length > 0 ? `後段學生目前是 ${tail.map((item) => item.name).join('、')}，可優先確認是否作答量不足。` : '目前沒有明顯的後段學生。',
                    '排行榜會同時受作答量與答對率影響，不建議只看名次本身。',
                ],
                suggestions: [
                    '解讀排行榜時先分辨是答題量不夠，還是真的觀念落後。',
                    '若要做教學決策，請把排行榜和錯題熱點一起看。',
                ],
                caveat: ranking.length < MIN_ANALYSIS_SAMPLE ? '目前進入排行榜的人數不多，名次波動會比較大。' : null,
            });
        }

            case 'student_self_diagnosis':
            case 'student_weakness_summary':
            case 'student_review_coach': {
            const me = await deps.getUserByDiscordId(params.userId);
            const myResponses = getUserScopedResponses(responses, params.userId);
            if (!me) {
                return formatAgentStructuredReply({
                    summary: '目前查不到你的綁定資料。',
                    findings: ['系統還不知道你的姓名或學號。'],
                    suggestions: ['請先使用 `/link student_id name` 完成綁定，再來找我做個人診斷。'],
                });
            }

            if (myResponses.length === 0) {
                return formatNoDataReply('目前查不到你在這個頻道的作答資料。', '先完成幾次作答後，我再幫你整理個人狀況。');
            }

            const graded = myResponses.filter((response) => response.status !== 'pending');
            const correct = graded.filter((response) => response.is_correct).length;
            const wrongResponses = graded.filter((response) => !response.is_correct);
            const accuracy = graded.length > 0 ? Math.round((correct / graded.length) * 100) : 0;
            const wrongAggregates = aggregateQuestions(wrongResponses)
                .sort((a, b) => b.wrong - a.wrong)
                .slice(0, 3);
            const wrongQuestions = await deps.getQuestionsByIds(wrongAggregates.map((item) => item.questionId));
            const wrongQuestionById = new Map(wrongQuestions.map((question) => [question.id, question]));

            const findings = [
                `你目前共有 ${myResponses.length} 份作答，已批改 ${graded.length} 份，答對率 ${accuracy}%。`,
                wrongAggregates.length > 0
                    ? `最近最常錯的是 ${wrongAggregates.map((item) => `題目 ${item.questionId}`).join('、')}。`
                    : '目前沒有明顯重複出錯的題目。',
                graded.length === 0 ? '目前還沒有已批改資料，暫時不能做明確判讀。' : `已批改資料中答對 ${correct} 題、答錯 ${graded.length - correct} 題。`,
            ];

            const suggestions = [
                wrongAggregates.length > 0
                    ? `先回頭看 ${wrongAggregates
                        .map((item) => `題目 ${item.questionId}「${buildQuestionSnippet(wrongQuestionById.get(item.questionId)?.content)}」`)
                        .join('、')}。`
                    : '先維持作答節奏，讓系統有更多資料判斷你的弱點。',
                accuracy < 60 ? '你現在最需要的是先補基礎錯題，不要急著追更多新題目。' : '你可以把重點放在把零星錯題整理成自己的筆記。',
                params.intent === 'student_review_coach' ? '下次作答前先看一次最近錯題，避免同樣概念重複失分。' : '如果你想要，我下一輪可以直接幫你拆出一個短期複習順序。',
            ];

            return formatAgentStructuredReply({
                summary: `${toDisplayName(me)}，你目前的整體表現 ${accuracy >= 80 ? '相對穩定' : accuracy >= 60 ? '中等' : '偏需要補強'}。`,
                findings,
                suggestions,
                caveat: wrongAggregates.length === 0 ? '目前沒有細主題標籤欄位，所以弱點主要依錯題紀錄推估。' : '目前弱點判斷是依錯題紀錄推估，不代表完整能力輪廓。',
            });
        }

            default:
                return null;
        }
    };
}

const buildRankingWithDeps = async (responses: QuizResponse[], getUsers: InsightDependencies['getUsersByIds']) => {
    const byUser = new Map<string, { total: number; correct: number; wrong: number }>();

    for (const response of responses) {
        const current = byUser.get(response.user_id) ?? { total: 0, correct: 0, wrong: 0 };
        if (response.status !== 'pending') {
            current.total += 1;
            if (response.is_correct) {
                current.correct += 1;
            } else {
                current.wrong += 1;
            }
        }
        byUser.set(response.user_id, current);
    }

    const ranked = [...byUser.entries()]
        .map(([userId, stat]) => ({
            userId,
            total: stat.total,
            correct: stat.correct,
            wrong: stat.wrong,
            accuracyPercent: stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0,
        }))
        .sort((a, b) => b.correct - a.correct || b.accuracyPercent - a.accuracyPercent || b.total - a.total);

    const users = await getUsers(ranked.map((item) => item.userId));
    const usersById = new Map(users.map((user) => [user.user_id, user]));

    return ranked.map((item, index) => ({
        rank: index + 1,
        ...item,
        name: toDisplayName(usersById.get(item.userId)),
    }));
};

export const buildStructuredInsight = createStructuredInsightBuilder({
    getQuizResponsesByGroupId,
    getQuestionsByIds,
    getUserByDiscordId,
    getUsersByIds,
});
