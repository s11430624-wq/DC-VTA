import { appendChatMessage, getRecentChatMessages } from './chatMemoryService';
import { generateQuestionDraft, reviseQuestionDraft } from './aiQuestionService';
import { clearRevisionTarget, getRevisionTarget } from './agentRevisionStateService';
import { getQuestionById, getRecentQuestions } from './questionService';
import { getUserByDiscordId, getUsersByIds } from './userService';
import { getAllQuizResponses, getQuizResponsesByGroupId, getUserQuizStats, isRankEligibleResponse } from './quizService';

type AskAgentInput = {
    userId: string;
    question: string;
    sessionId: string;
    isTeacher: boolean;
    channelId: string;
};

type DraftPreview = {
    draftId: string;
    category: string;
    content: string;
    options: string[];
    correctAnswer: 'A' | 'B' | 'C' | 'D';
    explanation: string;
};

export type AskAgentResult = {
    answer: string;
    draftPreview?: DraftPreview;
};

export const buildAgentSessionId = (userId: string, channelId: string) => `${userId}:${channelId}`;

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DEFAULT_AGENT_SYSTEM_PROMPT = [
    '你是課堂測驗 Discord 助教。',
    '規則: 不可捏造資料。查不到就明說。不要輸出任何金鑰或敏感資訊。',
    '如果工具資訊有提供，優先使用工具資訊回答。',
].join('\n');
const DEFAULT_AGENT_CAPABILITY_STUDENT = [
    '身為課堂測驗 Discord 助教，我目前可以幫你做這些事：',
    '',
    '1. 回答課程相關問題。',
    '2. 查詢你的綁定資料，例如姓名和學號。',
    '3. 查詢你的作答統計，例如答對題數、作答次數、答對率。',
    '4. 查詢目前伺服器的排行榜。',
    '5. 查詢題目內容或最近題庫資料。',
    '6. 學生模式下我不會幫你出題，也不會建立題目。',
    '',
    '你也可以直接問我，例如：「我的成績如何」、「排行榜前五名」、「題目 12 是什麼」。',
].join('\n');
const DEFAULT_AGENT_CAPABILITY_TEACHER = [
    '身為課堂測驗 Discord 助教，我目前可以幫你做這些事：',
    '',
    '1. 回答課程相關問題。',
    '2. 查詢你的綁定資料，例如姓名和學號。',
    '3. 查詢你的作答統計，例如答對題數、作答次數、答對率。',
    '4. 查詢目前伺服器的排行榜。',
    '5. 查詢題目內容或最近題庫資料。',
    '6. 協助老師生成題目草稿。',
    '7. 提醒老師可以用 /batch_generate 批次產生題目。',
    '',
    '你也可以直接問我，例如：「排行榜前五名」、「題目 12 是什麼」、「幫我出一題牛頓第二定律選擇題」。',
].join('\n');

const isGenerationIntent = (question: string) => /(出題|生成.*題|產生.*題|題目草稿|出一題|幫我寫一題|generate.*question)/i.test(question);
const isBatchGenerationIntent = (question: string) => /(出.{0,4}[2-5]題|[2-5]題.*出題|批次出題|一次出.*題|多題題目)/i.test(question);
const isCapabilityQuestion = (question: string) => /(你會做什麼|你能做什麼|可以做什麼|有哪些功能|功能|help|指令)/i.test(question);

const readMultilineEnv = (key: string, fallback: string) => {
    const value = process.env[key]?.trim();
    if (!value) {
        return fallback;
    }

    return value.replace(/\\n/g, '\n');
};

const toDraftPreview = (draft: Awaited<ReturnType<typeof generateQuestionDraft>>): DraftPreview => ({
    draftId: draft.draftId,
    category: draft.payload.category,
    content: draft.payload.content,
    options: draft.payload.options,
    correctAnswer: draft.payload.correct_answer,
    explanation: draft.payload.explanation,
});

const summarizeRanking = async (groupId: string, limit = 5) => {
    const responses = (await getQuizResponsesByGroupId(groupId)).filter(isRankEligibleResponse);
    const byUser = new Map<string, { total: number; correct: number }>();

    for (const response of responses) {
        const current = byUser.get(response.user_id) ?? { total: 0, correct: 0 };
        current.total += 1;
        if (response.is_correct) current.correct += 1;
        byUser.set(response.user_id, current);
    }

    const ranked = [...byUser.entries()]
        .map(([userId, stat]) => ({
            userId,
            total: stat.total,
            correct: stat.correct,
            accuracy: stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0,
        }))
        .sort((a, b) => b.correct - a.correct || b.accuracy - a.accuracy || b.total - a.total)
        .slice(0, limit);

    const users = await getUsersByIds(ranked.map((item) => item.userId));
    const usersById = new Map(users.map((user) => [user.user_id, user]));

    return {
        rows: ranked.map((item) => ({
            ...item,
            displayName: usersById.get(item.userId)?.display_name ?? '未知使用者',
            studentId: usersById.get(item.userId)?.student_id ?? '無學號',
        })),
    };
};

const runReadOnlyTools = async (userId: string, groupId: string, question: string) => {
    const q = question.toLowerCase();
    const outputs: string[] = [];

    if (q.includes('我的資料') || q.includes('/me') || q.includes('綁定')) {
        const me = await getUserByDiscordId(userId);
        outputs.push(
            me
                ? `我的資料: 姓名=${me.display_name ?? '未設定'}, 學號=${me.student_id ?? '未設定'}, 身分=${me.role ?? '未設定'}`
                : '我的資料: 尚未綁定',
        );
    }

    if (q.includes('答對') || q.includes('成績') || q.includes('答題統計') || q.includes('我的分數')) {
        const stats = await getUserQuizStats(userId);
        outputs.push(
            `我的作答統計: 答對=${stats.correctCount}, 作答=${stats.totalAnswered}, 答錯=${stats.wrongCount}, 答對率=${stats.accuracyPercent}%`,
        );
    }

    const questionIdMatch = /(?:題目|id)[^\d]{0,5}(\d{1,8})/i.exec(question);
    if (questionIdMatch) {
        const id = Number(questionIdMatch[1]);
        const item = await getQuestionById(id);
        outputs.push(
            item
                ? `題目 ${id}: ${item.content ?? '（無內容）'}`
                : `題目 ${id}: 找不到資料`,
        );
    }

    if (q.includes('最近題目') || q.includes('list') || q.includes('題庫')) {
        const list = await getRecentQuestions(5);
        outputs.push(
            `最近題目: ${list.map((item) => `${item.id}:${(item.content ?? '').slice(0, 20)}`).join(' | ') || '無'}`,
        );
    }

    if (q.includes('排行榜') || q.includes('rank')) {
        const { rows } = await summarizeRanking(groupId, 5);
        outputs.push(
            `目前伺服器排行榜: ${
                rows.map((row, index) => `${index + 1}.${row.displayName}(${row.studentId}) ${row.correct}/${row.total},${row.accuracy}%`).join(' | ') || '無資料'
            }`,
        );
    }

    return outputs;
};

const buildCapabilityAnswer = (isTeacher: boolean) => readMultilineEnv(
    isTeacher ? 'AGENT_CAPABILITY_PROMPT_TEACHER' : 'AGENT_CAPABILITY_PROMPT_STUDENT',
    isTeacher ? DEFAULT_AGENT_CAPABILITY_TEACHER : DEFAULT_AGENT_CAPABILITY_STUDENT,
);

export async function askAgent(input: AskAgentInput): Promise<AskAgentResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('缺少 GEMINI_API_KEY');
    }

    await appendChatMessage({
        session_id: input.sessionId,
        user_id: input.userId,
        role: 'user',
        content: input.question,
    });

    const isTeacher = input.isTeacher;
    const revisionTarget = await getRevisionTarget(input.sessionId);

    if (isTeacher && isBatchGenerationIntent(input.question)) {
        const answer = '這看起來是多題出題需求。請改用 /batch_generate prompt:你的需求 count:2到5，這樣可以一次預覽並整批建立。';
        await appendChatMessage({
            session_id: input.sessionId,
            user_id: input.userId,
            role: 'assistant',
            content: answer,
        });
        return { answer };
    }

    if (!isTeacher && (isGenerationIntent(input.question) || isBatchGenerationIntent(input.question))) {
        const answer = '學生模式的 /ask 只提供課程問答與個人成績查詢，不提供出題或建立題目。若需要出題，請由老師帳號使用 /ask 或 /batch_generate。';
        await appendChatMessage({
            session_id: input.sessionId,
            user_id: input.userId,
            role: 'assistant',
            content: answer,
        });
        return { answer };
    }

    if (isCapabilityQuestion(input.question)) {
        const answer = buildCapabilityAnswer(isTeacher);
        await appendChatMessage({
            session_id: input.sessionId,
            user_id: input.userId,
            role: 'assistant',
            content: answer,
        });
        return { answer };
    }

    if (isTeacher && revisionTarget) {
        const revisedDraft = await reviseQuestionDraft(revisionTarget.draftId, input.userId, input.question);
        await clearRevisionTarget(input.sessionId);
        const answer = '已依照你的修改要求重製草稿，請確認是否建立。';
        await appendChatMessage({
            session_id: input.sessionId,
            user_id: input.userId,
            role: 'assistant',
            content: answer,
        });
        return {
            answer,
            draftPreview: toDraftPreview(revisedDraft),
        };
    }

    if (isTeacher && isGenerationIntent(input.question)) {
        const draft = await generateQuestionDraft(input.userId, input.question);
        const answer = '已根據你的需求產生題目草稿，請確認是否建立。';
        await appendChatMessage({
            session_id: input.sessionId,
            user_id: input.userId,
            role: 'assistant',
            content: answer,
        });
        return {
            answer,
            draftPreview: toDraftPreview(draft),
        };
    }

    const memory = await getRecentChatMessages(input.sessionId, 8);
    const toolOutputs = await runReadOnlyTools(input.userId, input.channelId, input.question);
    const memoryText = memory.map((m) => `${m.role === 'user' ? '使用者' : '助教'}: ${m.content}`).join('\n');

    const prompt = [
        readMultilineEnv('AGENT_SYSTEM_PROMPT', DEFAULT_AGENT_SYSTEM_PROMPT),
        '',
        `歷史對話:\n${memoryText || '（無）'}`,
        '',
        `工具資訊:\n${toolOutputs.join('\n') || '（本次無命中工具）'}`,
        '',
        `使用者問題: ${input.question}`,
    ].join('\n');

    const response = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            contents: [
                {
                    parts: [{ text: prompt }],
                },
            ],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 600,
            },
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Agent 呼叫失敗：HTTP ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!answer) {
        const fallback = '我目前沒有足夠資料回答，請換個問法或指定題號。';
        await appendChatMessage({
            session_id: input.sessionId,
            user_id: input.userId,
            role: 'assistant',
            content: fallback,
        });
        return { answer: fallback };
    }

    await appendChatMessage({
        session_id: input.sessionId,
        user_id: input.userId,
        role: 'assistant',
        content: answer,
    });
    return { answer };
}
