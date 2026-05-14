import { appendChatMessage, getRecentChatMessages } from './chatMemoryService';
import { resolveAgentIntent, shouldDenyStudentScope } from './agentAnalysisRuntime';
import { buildStructuredInsight } from './agentInsightService';
import { generateQuestionDraft, generateShortAnswerQuestionPayload, reviseQuestionDraft } from './aiQuestionService';
import { clearRevisionTarget, getRevisionTarget } from './agentRevisionStateService';
import { generateModelText } from './llmService';
import { getQuestionById, getRecentQuestions } from './questionService';
import { getUserByDiscordId, getUsersByIds } from './userService';
import { getAllQuizResponses, getQuizResponsesByGroupId, getUserQuizStats, isRankEligibleResponse } from './quizService';
import { formatWebSearchSummary, searchWeb, shouldUseWebSearch } from './webSearchService';

type AskAgentInput = {
    userId: string;
    question: string;
    sessionId: string;
    isTeacher: boolean;
    channelId: string;
    chatMode?: boolean;
};

type DraftPreview = {
    draftId: string;
    category: string;
    content: string;
    options: string[];
    correctAnswer: 'A' | 'B' | 'C' | 'D';
    explanation: string;
};

type ShortAnswerDraftPreview = {
    category: string;
    content: string;
    rubric: string;
};

type PollDraftPreview = {
    question: string;
    options: string[];
    durationHours: number;
    allowMultiselect: boolean;
};

export type AskAgentResult = {
    answer: string;
    draftPreview?: DraftPreview;
    shortAnswerDraftPreview?: ShortAnswerDraftPreview;
    pollDraftPreview?: PollDraftPreview;
};

export const buildAgentSessionId = (_userId: string, channelId: string) => `channel:${channelId}`;

const getAgentModel = () => process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';
const DEFAULT_AGENT_SYSTEM_PROMPT = [
    '你是課堂測驗 Discord 助教。',
    '規則: 不可捏造資料。查不到就明說。不要輸出任何金鑰或敏感資訊。',
    '如果工具資訊有提供，優先使用工具資訊回答。',
].join('\n');
const DEFAULT_AGENT_CAPABILITY_STUDENT = [
    '身為課堂測驗 Discord 助教，我目前可以幫你做這些事：',
    '',
    '1. 幫你做個人成績診斷，例如答對率、作答量、最近表現。',
    '2. 幫你整理常錯題目與目前較弱的地方。',
    '3. 根據你的作答資料給你短期複習建議。',
    '4. 查詢你的綁定資料，例如姓名和學號。',
    '5. 查詢題目內容或最近題庫資料。',
    '6. 學生模式下我不會幫你出題，也不會提供其他同學或全班的細部資料。',
    '',
    '你也可以直接問我，例如：「我最近哪裡最弱」、「我這週該先複習什麼」、「題目 12 是什麼」。',
].join('\n');
const DEFAULT_AGENT_CAPABILITY_TEACHER = [
    '身為課堂測驗 Discord 助教，我目前可以幫你做這些事：',
    '',
    '1. 幫你看班級整體狀況，例如作答量、答對率、待批改量。',
    '2. 幫你找最近最常錯的題目與需要優先複盤的內容。',
    '3. 幫你觀察指定學生目前的作答狀況。',
    '4. 幫你解讀排行榜與題目品質風險。',
    '5. 查詢題目內容或最近題庫資料。',
    '6. 協助老師生成題目草稿。',
    '7. 提醒老師可以用 /batch_generate 批次產生題目。',
    '',
    '你也可以直接問我，例如：「幫我看這週全班狀況」、「最近哪幾題最多人錯」、「幫我出一題牛頓第二定律選擇題」。',
].join('\n');

type AgentIntentFlags = {
    generation: boolean;
    batchGeneration: boolean;
    capability: boolean;
    shortAnswer: boolean;
    multipleChoice: boolean;
    surveyCreation: boolean;
    pollCreation: boolean;
};

const extractFirstJsonObject = (raw: string) => {
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                return text.slice(start, i + 1);
            }
        }
    }
    return text;
};

const regexFallbackIntents = (question: string): AgentIntentFlags => ({
    generation: /(出題|生成.*題|產生.*題|題目草稿|出一題|幫我寫一題|generate.*question|簡答題|選擇題|單選題|四選一)/i.test(question),
    batchGeneration: /(出.{0,4}[2-5]題|[2-5]題.*出題|批次出題|一次出.*題|多題題目)/i.test(question),
    capability: /(你會做什麼|你能做什麼|可以做什麼|有哪些功能|幫助|\/help|help|指令(列表|說明)?)/i.test(question),
    shortAnswer: /(簡答題|問答題|申論題|開放題|敘述題|short\s*answer)/i.test(question),
    multipleChoice: /(選擇題|單選題|四選一|四選一題|abc[dＤ]|multiple\s*choice)/i.test(question),
    surveyCreation: /(問卷|survey).*(建立|新增|出題|出|產生|生成|create|add)|((建立|新增|出題|出|產生|生成|create|add).*(問卷|survey))/i.test(question),
    pollCreation: /(投票|poll).*(建立|新增|做|產生|生成|create|add)|((建立|新增|做|產生|生成|create|add).*(投票|poll))/i.test(question),
});

const detectAgentIntents = async (question: string): Promise<AgentIntentFlags> => {
    const fallback = regexFallbackIntents(question);
    const model = process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';
    const prompt = [
        '你是課堂助教的意圖分類器。',
        '請把使用者句子分類成布林旗標，只輸出 JSON，不要其他文字。',
        'JSON 格式：{"generation":false,"batchGeneration":false,"capability":false,"shortAnswer":false,"multipleChoice":false,"surveyCreation":false,"pollCreation":false}',
        '規則：',
        '- generation: 想要出題或生成題目',
        '- batchGeneration: 想一次出多題',
        '- capability: 問機器人能做什麼',
        '- shortAnswer: 指定簡答題/申論題',
        '- multipleChoice: 指定選擇題/四選一',
        '- surveyCreation: 想建立問卷',
        '- pollCreation: 想建立投票',
        `使用者輸入：${question}`,
    ].join('\n');

    try {
        const answer = await generateModelText({
            model,
            prompt,
            temperature: 0,
            maxOutputTokens: 160,
            responseMimeType: 'application/json',
        });
        const parsed = JSON.parse(extractFirstJsonObject(answer)) as Partial<AgentIntentFlags>;
        return {
            generation: Boolean(parsed.generation),
            batchGeneration: Boolean(parsed.batchGeneration),
            capability: Boolean(parsed.capability),
            shortAnswer: Boolean(parsed.shortAnswer),
            multipleChoice: Boolean(parsed.multipleChoice),
            surveyCreation: Boolean(parsed.surveyCreation),
            pollCreation: Boolean(parsed.pollCreation),
        };
    } catch {
        return fallback;
    }
};
const POLL_DRAFT_FALLBACK_OPTIONS = ['選項 A', '選項 B', '選項 C'];

const parseGeminiText = (raw: string) => {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    return (fenced?.[1] ?? raw).trim();
};

const generatePollDraftPayload = async (userPrompt: string): Promise<PollDraftPreview> => {
    const prompt = [
        '你是 Discord 投票建立器，請把使用者需求轉成 JSON。',
        '只輸出 JSON，不要輸出其他說明。',
        '格式如下：{"question":"...", "options":["...","..."], "durationHours":24, "allowMultiselect":false}',
        '規則：',
        '- options 至少 2 個，最多 10 個',
        '- durationHours 範圍 1 到 168，預設 24',
        '- question 與 options 使用繁體中文',
        `使用者需求：${userPrompt}`,
    ].join('\n');

    const answer = await generateModelText({
        model: getAgentModel(),
        prompt,
        temperature: 0.2,
        maxOutputTokens: 400,
    });
    const parsed = JSON.parse(parseGeminiText(answer)) as Partial<PollDraftPreview>;
    const question = (parsed.question ?? '').trim();
    const options = (parsed.options ?? []).map((item) => `${item ?? ''}`.trim()).filter((item) => item.length > 0).slice(0, 10);
    const durationHours = Number.isFinite(parsed.durationHours) ? Math.max(1, Math.min(168, Math.floor(parsed.durationHours!))) : 24;
    const allowMultiselect = Boolean(parsed.allowMultiselect);

    return {
        question: question || '請設定投票問題',
        options: options.length >= 2 ? options : POLL_DRAFT_FALLBACK_OPTIONS,
        durationHours,
        allowMultiselect,
    };
};

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

const buildCapabilityAnswer = (isTeacher: boolean) => (
    isTeacher ? DEFAULT_AGENT_CAPABILITY_TEACHER : DEFAULT_AGENT_CAPABILITY_STUDENT
);

const saveAssistantAnswer = async (sessionId: string, userId: string, content: string) => {
    await appendChatMessage({
        session_id: sessionId,
        user_id: userId,
        role: 'assistant',
        content,
    });
};

export async function askAgent(input: AskAgentInput): Promise<AskAgentResult> {
    const isChatMode = input.chatMode === true;

    await appendChatMessage({
        session_id: input.sessionId,
        user_id: input.userId,
        role: 'user',
        content: input.question,
    });

    const isTeacher = input.isTeacher;
    const revisionTarget = await getRevisionTarget(input.sessionId);
    const intents = await detectAgentIntents(input.question);
    const resolvedIntent = resolveAgentIntent(input.question, isTeacher);
    const explicitCapabilityQuery = regexFallbackIntents(input.question).capability || resolvedIntent.intent === 'capability';

    if (!isTeacher) {
        const guard = shouldDenyStudentScope(input.question);
        if (guard.denied) {
            await saveAssistantAnswer(input.sessionId, input.userId, guard.reason);
            return { answer: guard.reason };
        }
    }

    if (!isChatMode && isTeacher && intents.batchGeneration) {
        const answer = '這看起來是多題出題需求。請改用 /batch_generate prompt:你的需求 count:2到5，這樣可以一次預覽並整批建立。';
        await saveAssistantAnswer(input.sessionId, input.userId, answer);
        return { answer };
    }

    if (!isChatMode && !isTeacher && (intents.generation || intents.batchGeneration)) {
        const answer = '學生模式的 /ask 只提供課程問答與個人成績查詢，不提供出題或建立題目。若需要出題，請由老師帳號使用 /ask 或 /batch_generate。';
        await saveAssistantAnswer(input.sessionId, input.userId, answer);
        return { answer };
    }

    if (!isChatMode && isTeacher && intents.surveyCreation) {
        const answer = '目前 /ask 不支援建立問卷題。請改用 `/add_survey content:你的問卷題目`。';
        await saveAssistantAnswer(input.sessionId, input.userId, answer);
        return { answer };
    }

    if (!isChatMode && intents.pollCreation) {
        const pollDraft = await generatePollDraftPayload(input.question);
        const answer = '已依你的需求產生投票草稿，請確認後建立。';
        await saveAssistantAnswer(input.sessionId, input.userId, answer);
        return { answer, pollDraftPreview: pollDraft };
    }

    if (!isChatMode && explicitCapabilityQuery) {
        const answer = buildCapabilityAnswer(isTeacher);
        await saveAssistantAnswer(input.sessionId, input.userId, answer);
        return { answer };
    }

    if (!isChatMode && isTeacher && revisionTarget) {
        const revisedDraft = await reviseQuestionDraft(revisionTarget.draftId, input.userId, input.question);
        await clearRevisionTarget(input.sessionId);
        const answer = '已依照你的修改要求重製草稿，請確認是否建立。';
        await saveAssistantAnswer(input.sessionId, input.userId, answer);
        return {
            answer,
            draftPreview: toDraftPreview(revisedDraft),
        };
    }

    if (!isChatMode && isTeacher && intents.generation) {
        const shortIntent = intents.shortAnswer;
        const multipleChoiceIntent = intents.multipleChoice;

        if (shortIntent && multipleChoiceIntent) {
            const answer = '我判斷到你同時提到簡答題與選擇題，請明確指定其中一種，例如：「幫我出一題簡答題 ...」或「幫我出一題四選一 ...」。';
            await saveAssistantAnswer(input.sessionId, input.userId, answer);
            return { answer };
        }

        if (shortIntent && !multipleChoiceIntent) {
            const shortDraft = await generateShortAnswerQuestionPayload(input.question);
            const answer = '已根據你的需求產生簡答題草稿。';
            await saveAssistantAnswer(input.sessionId, input.userId, answer);

            return {
                answer,
                shortAnswerDraftPreview: shortDraft,
            };
        }

        const draft = await generateQuestionDraft(input.userId, input.question);
        const answer = '已根據你的需求產生題目草稿，請確認是否建立。';
        await saveAssistantAnswer(input.sessionId, input.userId, answer);
        return {
            answer,
            draftPreview: toDraftPreview(draft),
        };
    }

    if (!isChatMode && resolvedIntent.intent !== 'general_chat') {
        const structuredAnswer = await buildStructuredInsight({
            intent: resolvedIntent.intent,
            channelId: input.channelId,
            userId: input.userId,
            question: input.question,
            isTeacher,
        });

        if (structuredAnswer) {
            await saveAssistantAnswer(input.sessionId, input.userId, structuredAnswer);
            return { answer: structuredAnswer };
        }
    }

    const memory = await getRecentChatMessages(input.sessionId, 8);
    const toolOutputs = await runReadOnlyTools(input.userId, input.channelId, input.question);
    const useWebSearch = await shouldUseWebSearch(input.question);
    const webResults = useWebSearch ? await searchWeb(input.question, 5) : [];
    const memoryText = memory.map((m) => `${m.role === 'user' ? '使用者' : '助教'}: ${m.content}`).join('\n');

    const prompt = [
        readMultilineEnv('AGENT_SYSTEM_PROMPT', DEFAULT_AGENT_SYSTEM_PROMPT),
        '',
        `歷史對話:\n${memoryText || '（無）'}`,
        '',
        `工具資訊:\n${toolOutputs.join('\n') || '（本次無命中工具）'}`,
        '',
        `網路搜尋結果:\n${formatWebSearchSummary(webResults)}`,
        '',
        `使用者問題: ${input.question}`,
        '',
        '回答要求：若引用網路資訊，請在回答最後附上「來源」段落，列出你使用的網址。',
    ].join('\n');

    let answer = await generateModelText({
        model: getAgentModel(),
        prompt,
        temperature: 0.2,
        maxOutputTokens: 1600,
    });

    if (webResults.length > 0) {
        const sources = webResults.slice(0, 3).map((item, index) => `${index + 1}. ${item.link}`).join('\n');
        if (!/來源[:：]/.test(answer)) {
            answer = `${answer}\n\n來源：\n${sources}`;
        }
    }

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
