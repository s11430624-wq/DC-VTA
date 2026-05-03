import {
    ActionRowBuilder,
    ApplicationCommandOptionType,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    Client,
    EmbedBuilder,
    GatewayIntentBits,
    ModalBuilder,
    REST,
    Routes,
    TextInputBuilder,
    TextInputStyle,
    type APIEmbedField,
} from 'discord.js';
import dotenv from 'dotenv';
import { approveQuestionDraft, clearDraftsByUser, getDraftById } from './services/aiQuestionService';
import { askAgent, buildAgentSessionId } from './services/agentService';
import { clearAgentMessages } from './services/agentMemoryService';
import { clearRevisionTarget, setRevisionTarget } from './services/agentRevisionStateService';
import {
    approveQuestionBatchDraft,
    clearBatchDraftsByUser,
    discardQuestionBatchDraft,
    generateQuestionBatchDraft,
} from './services/batchQuestionService';
import { ensureDiscordChannelGroup, ensureGroupMember, setCurrentQuestionForGroup } from './services/groupService';
import { addMultipleChoiceQuestion, createShortAnswerQuestion, getQuestionById, getRecentQuestions } from './services/questionService';
import {
    getAllQuizResponses,
    getPendingQuizResponses,
    getResponsesByQuestionId,
    getUserQuizStats,
    isRankEligibleResponse,
    QuizResponse,
    upsertQuizResponse,
} from './services/quizService';
import { getUserByDiscordId, getUsersByIds, linkStudent, UserRecord } from './services/userService';
import { formatError, safeReply } from './utils/errorHandler';
import { parseAnswerCustomId } from './utils/parseCustomId';
import { isTeacher, requireTeacher } from './utils/roleGuard';

// 載入環境變數
dotenv.config();

const requiredEnvVars = [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
    'TEACHER_ROLE_ID',
    'STUDENT_ROLE_ID',
] as const;

const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
    throw new Error(`缺少必要環境變數：${missingEnvVars.join(', ')}`);
}

const token = process.env.DISCORD_TOKEN!;
const clientId = process.env.DISCORD_CLIENT_ID!;
const guildId = process.env.DISCORD_GUILD_ID!;
const frontendBaseUrl = (process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

// 初始化機器人客戶端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
});

// 定義 Slash Commands
const commands = [
    {
        name: 'help',
        description: '顯示 VTA Bot 的可用指令清單',
    },
    {
        name: 'link',
        description: '綁定 Discord 使用者與學生資料',
        options: [
            {
                name: 'student_id',
                description: '學生學號',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'name',
                description: '學生姓名',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: 'me',
        description: '查詢我的綁定資料',
    },
    {
        name: 'list',
        description: '列出最近 10 筆題庫資料',
    },
    {
        name: 'question',
        description: '查看指定題目詳情',
        options: [
            {
                name: 'id',
                description: '題目 ID',
                type: ApplicationCommandOptionType.Integer,
                required: true,
            },
        ],
    },
    {
        name: 'add',
        description: '老師新增一題選擇題',
        options: [
            {
                name: 'content',
                description: '題目內容',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: 'add_short',
        description: '老師新增一題短答題',
        options: [
            {
                name: 'content',
                description: '題目內容',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'rubric',
                description: '評分規準或參考答案',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: 'open',
        description: '老師開放一題選擇題',
        options: [
            {
                name: 'id',
                description: '題目 ID',
                type: ApplicationCommandOptionType.Integer,
                required: true,
            },
        ],
    },
    {
        name: 'check',
        description: '老師查看指定題目的答題統計',
        options: [
            {
                name: 'id',
                description: '題目 ID',
                type: ApplicationCommandOptionType.Integer,
                required: true,
            },
        ],
    },
    {
        name: 'grading_queue',
        description: '老師查看目前待批改的簡答題清單',
    },
    {
        name: 'grade_link',
        description: '老師取得簡答題批改頁連結',
        options: [
            {
                name: 'id',
                description: '短答題 ID',
                type: ApplicationCommandOptionType.Integer,
                required: true,
            },
        ],
    },
    {
        name: 'rank',
        description: '顯示學生排行榜',
        options: [
            {
                name: 'limit',
                description: '顯示名次數量，預設 10，最多 20',
                type: ApplicationCommandOptionType.Integer,
                required: false,
                min_value: 1,
                max_value: 20,
            },
        ],
    },
    {
        name: 'ask',
        description: '向課堂助教 Agent 發問',
        options: [
            {
                name: 'prompt',
                description: '你想問 Agent 的問題',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: 'clear_memory',
        description: '清除目前頻道中的 Agent 對話記憶與未確認題目草稿',
    },
    {
        name: 'batch_generate',
        description: '老師批次產生多題四選一題目草稿',
        options: [
            {
                name: 'prompt',
                description: '出題需求，例如主題、難度、適合對象',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'count',
                description: '題數，最少 2 題，最多 5 題',
                type: ApplicationCommandOptionType.Integer,
                required: true,
                min_value: 2,
                max_value: 5,
            },
        ],
    },
];

type QuestionMetadata = Record<string, unknown>;

type MetadataParseResult =
    | { ok: true; metadata: QuestionMetadata | null }
    | { ok: false; error: string };

type RankingStat = {
    userId: string;
    totalAnswered: number;
    correctCount: number;
    wrongCount: number;
    accuracy: number;
};

const parseQuestionMetadata = (metadata: QuestionMetadata | string | null): MetadataParseResult => {
    if (!metadata) {
        return { ok: true, metadata: null };
    }

    if (typeof metadata === 'string') {
        try {
            const parsed = JSON.parse(metadata) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return { ok: true, metadata: parsed as QuestionMetadata };
            }

            return { ok: false, error: '題目資料格式錯誤' };
        } catch {
            return { ok: false, error: '題目資料格式錯誤' };
        }
    }

    return { ok: true, metadata };
};

const getQuestionTopic = (metadata: QuestionMetadata | string | null, category: string | null) => {
    const parsed = parseQuestionMetadata(metadata);
    const topic = parsed.ok ? parsed.metadata?.topic : null;
    return category || (typeof topic === 'string' ? topic : '未分類');
};

const truncateContent = (content: string | null, maxLength = 40) => {
    if (!content) return '（無題目內容）';
    return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content;
};

const hasEmbedding = (embedding: unknown[] | string | null | undefined) => {
    if (Array.isArray(embedding)) return embedding.length > 0;
    if (typeof embedding === 'string') return embedding.length > 0;
    return Boolean(embedding);
};

const getStringMetadata = (metadata: QuestionMetadata | null, key: string) => {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

const getOptionsText = (metadata: QuestionMetadata | string | null) => {
    const parsed = parseQuestionMetadata(metadata);

    if (!parsed.ok) {
        return '題目資料格式錯誤';
    }

    const rawOptions = parsed.metadata?.options;

    if (Array.isArray(rawOptions)) {
        return rawOptions
            .slice(0, 4)
            .map((option, index) => `${String.fromCharCode(65 + index)}. ${String(option)}`)
            .join('\n');
    }

    if (rawOptions && typeof rawOptions === 'object') {
        return ['A', 'B', 'C', 'D']
            .map((key) => {
                const option = (rawOptions as Record<string, unknown>)[key];
                return option ? `${key}. ${String(option)}` : null;
            })
            .filter((line): line is string => Boolean(line))
            .join('\n');
    }

    return '無';
};

const getMultipleChoiceOptions = (metadata: QuestionMetadata | string | null) => {
    const parsed = parseQuestionMetadata(metadata);

    if (!parsed.ok) {
        return [];
    }

    const rawOptions = parsed.metadata?.options;

    if (Array.isArray(rawOptions)) {
        return rawOptions.slice(0, 4).map((option) => String(option));
    }

    if (rawOptions && typeof rawOptions === 'object') {
        return ['A', 'B', 'C', 'D']
            .map((key) => (rawOptions as Record<string, unknown>)[key])
            .filter((option) => option !== null && option !== undefined)
            .slice(0, 4)
            .map((option) => String(option));
    }

    return [];
};

type QuestionDetail = Awaited<ReturnType<typeof getQuestionById>>;

const formatQuestionDetail = (question: QuestionDetail) => {
    if (!question) return '找不到這個題目';

    const parsedMetadata = parseQuestionMetadata(question.metadata);
    if (!parsedMetadata.ok) return parsedMetadata.error;

    const topic = getQuestionTopic(question.metadata, question.category);
    const questionType = question.question_type ?? '未設定';
    const lines = [
        `🧐 題目詳情 ID: ${question.id}`,
        `📂 分類：${topic}`,
        `🧩 題型：${questionType}`,
        '',
        '📝 題目：',
        question.content ?? '（無題目內容）',
        '',
    ];

    if (questionType === 'multiple_choice') {
        lines.push(
            '🔢 選項：',
            getOptionsText(question.metadata),
            '',
            `🔑 答案：${getStringMetadata(parsedMetadata.metadata, 'correct_answer') ?? '無'}`,
            `💡 解析：${getStringMetadata(parsedMetadata.metadata, 'explanation') ?? '無'}`,
            '',
        );
    }

    if (questionType === 'short_answer') {
        lines.push(
            `🧾 評分規準：${getStringMetadata(parsedMetadata.metadata, 'rubric') ?? question.rubric ?? '無'}`,
            '',
        );
    }

    lines.push(`Vector：${hasEmbedding(question.embedding) ? '✅ 已生成' : '⬜ NULL'}`);

    return lines.join('\n');
};

const formatResponseList = (
    responses: QuizResponse[],
    usersById: Map<string, UserRecord>,
    maxLines: number,
) => {
    const lines = responses.slice(0, maxLines).map((response, index) => {
        const user = usersById.get(response.user_id);
        const displayName = user?.display_name || '未知使用者';
        const studentId = user?.student_id || '無學號';
        return `${index + 1}. ${displayName} (${studentId}) [選${response.selected_option}]`;
    });

    return {
        lines,
        truncated: responses.length > maxLines,
    };
};

const formatCheckResult = async (questionId: number) => {
    const question = await getQuestionById(questionId);

    if (!question) {
        return '找不到這個題目';
    }

    const responses = await getResponsesByQuestionId(questionId);

    if (question.question_type === 'short_answer') {
        const gradingLink = buildGradingLink({ questionId, status: 'pending' });

        if (responses.length === 0) {
            return `📊 第 ${questionId} 題目前還沒有短答提交。\n\n🔗 批改頁面：\n${gradingLink}`;
        }

        const users = await getUsersByIds([...new Set(responses.map((response) => response.user_id))]);
        const usersById = new Map(users.map((user) => [user.user_id, user]));
        const lines = [
            `📊 第 ${questionId} 題短答提交`,
            '',
            '📝 題目：',
            truncateContent(question.content, 80),
            '',
            `👥 已提交人數：${responses.length} 人`,
            `🔗 批改頁面：${gradingLink}`,
            '',
            ...responses.slice(0, 20).map((response, index) => {
                const user = usersById.get(response.user_id);
                const displayName = user?.display_name || '未知使用者';
                const studentId = user?.student_id || '無學號';
                const answerText = response.answer_text?.trim() || '（未填寫內容）';
                return `${index + 1}. ${displayName} (${studentId})\n${answerText}`;
            }),
        ];

        if (responses.length > 20) {
            lines.push('', '提交內容過長，僅顯示前 20 筆。');
        }

        return lines.join('\n');
    }

    if (responses.length === 0) {
        return `📊 第 ${questionId} 題目前還沒有人作答。`;
    }

    const users = await getUsersByIds([...new Set(responses.map((response) => response.user_id))]);
    const usersById = new Map(users.map((user) => [user.user_id, user]));
    const correctResponses = responses.filter((response) => response.is_correct);
    const wrongResponses = responses.filter((response) => !response.is_correct);
    const maxShownPerGroup = 25;
    const correctList = formatResponseList(correctResponses, usersById, maxShownPerGroup);
    const wrongList = formatResponseList(wrongResponses, usersById, maxShownPerGroup);
    const lines = [
        `📊 第 ${questionId} 題完整統計`,
        '',
        '📝 題目：',
        truncateContent(question.content, 80),
        '',
        `✅ 答對人數：${correctResponses.length} 人`,
        ...(correctList.lines.length > 0 ? correctList.lines : ['無']),
        '',
        `❌ 答錯人數：${wrongResponses.length} 人`,
        ...(wrongList.lines.length > 0 ? wrongList.lines : ['無']),
    ];

    if (correctList.truncated || wrongList.truncated) {
        lines.push('', `名單過長，僅顯示前 ${maxShownPerGroup} 筆。`);
    }

    let output = lines.join('\n');

    if (output.length > 1900) {
        const safeLines: string[] = [];
        for (const line of lines) {
            const nextOutput = [...safeLines, line, '', '名單過長，已截斷以符合 Discord 訊息限制。'].join('\n');
            if (nextOutput.length > 1900) break;
            safeLines.push(line);
        }
        output = [...safeLines, '', '名單過長，已截斷以符合 Discord 訊息限制。'].join('\n');
    }

    return output;
};

const getLimitedRankCount = (value: number | null) => {
    if (!value) return 10;
    return Math.max(1, Math.min(20, value));
};

const getChannelGroupName = (
    channel: unknown,
    channelId: string | null,
) => {
    const channelName = (
        channel
        && typeof channel === 'object'
        && 'name' in channel
        && typeof (channel as { name?: unknown }).name === 'string'
    )
        ? (channel as { name: string }).name.trim()
        : null;
    return channelName && channelName.length > 0
        ? channelName
        : (channelId ? `discord-${channelId}` : null);
};

const resolveChannelGroupId = async (
    channelId: string | null,
    channel: unknown,
) => {
    if (!channelId) {
        return null;
    }

    const group = await ensureDiscordChannelGroup(channelId, getChannelGroupName(channel, channelId));
    return group?.group_id ?? null;
};

const getQuestionExplanation = (metadata: QuestionMetadata | string | null) => {
    const parsed = parseQuestionMetadata(metadata);
    if (!parsed.ok) return null;
    return getStringMetadata(parsed.metadata, 'explanation');
};

const buildGradingLink = (params: { questionId?: number; responseId?: number; status?: 'pending' | 'graded' }) => {
    const searchParams = new URLSearchParams({
        tab: 'grading',
        status: params.status ?? 'pending',
    });

    if (params.questionId !== undefined) {
        searchParams.set('question_id', String(params.questionId));
    }

    if (params.responseId !== undefined) {
        searchParams.set('response_id', String(params.responseId));
    }

    return `${frontendBaseUrl}/?${searchParams.toString()}`;
};

const buildQuestionOpenFields = (options: string[], category: string) => {
    const fields: APIEmbedField[] = [
        {
            name: '分類',
            value: category,
            inline: true,
        },
        {
            name: '作答方式',
            value: '請直接按下 A / B / C / D 按鈕作答',
            inline: true,
        },
    ];

    for (const [index, option] of options.entries()) {
        fields.push({
            name: String.fromCharCode(65 + index),
            value: option,
            inline: false,
        });
    }

    return fields;
};

const buildShortAnswerOpenFields = (category: string, rubric: string | null) => {
    const fields: APIEmbedField[] = [
        {
            name: '分類',
            value: category,
            inline: true,
        },
        {
            name: '作答方式',
            value: '按下「提交短答」後輸入文字答案',
            inline: true,
        },
    ];

    if (rubric) {
        fields.push({
            name: '評分重點',
            value: rubric.length > 200 ? `${rubric.slice(0, 200)}...` : rubric,
            inline: false,
        });
    }

    return fields;
};

const getDraftPreviewText = (draft: {
    category: string;
    content: string;
    options: string[];
    correctAnswer: 'A' | 'B' | 'C' | 'D';
    explanation: string;
}) => [
    '以下是題目草稿，請確認：',
    '',
    `分類：${draft.category}`,
    `題目：${draft.content}`,
    '',
    `A. ${draft.options[0] ?? ''}`,
    `B. ${draft.options[1] ?? ''}`,
    `C. ${draft.options[2] ?? ''}`,
    `D. ${draft.options[3] ?? ''}`,
    '',
    `答案：${draft.correctAnswer}`,
    `解析：${draft.explanation || '無'}`,
    '',
    '如果可以，按「同意建立」。如果要改，按「我要修改」後再用 /ask 補充修改要求。',
].join('\n');

const getBatchPreviewText = (questions: Array<{
    category: string;
    content: string;
    options: string[];
    correct_answer: 'A' | 'B' | 'C' | 'D';
    explanation: string;
}>) => [
    '以下是批次題目草稿，請確認：',
    '',
    ...questions.flatMap((question, index) => ([
        `第 ${index + 1} 題｜分類：${question.category}`,
        `題目：${question.content}`,
        `A. ${question.options[0] ?? ''}`,
        `B. ${question.options[1] ?? ''}`,
        `C. ${question.options[2] ?? ''}`,
        `D. ${question.options[3] ?? ''}`,
        `答案：${question.correct_answer}`,
        `解析：${question.explanation || '無'}`,
        '',
    ])),
    '如果可以，按「全部建立」。如果不要這批草稿，按「全部作廢」。',
].join('\n');

const hasValidDraftPreview = (draft: {
    category: string;
    content: string;
    options: string[];
    correctAnswer: 'A' | 'B' | 'C' | 'D';
}) => (
    draft.category.trim().length > 0
    && draft.content.trim().length > 0
    && draft.options.length === 4
    && draft.options.every((option) => option.trim().length > 0)
    && ['A', 'B', 'C', 'D'].includes(draft.correctAnswer)
);

const buildRankingStats = (responses: QuizResponse[]): RankingStat[] => {
    const statsByUserId = new Map<string, RankingStat>();

    for (const response of responses.filter(isRankEligibleResponse)) {
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

const formatRankResult = async (limit: number) => {
    const responses = await getAllQuizResponses();

    if (responses.length === 0) {
        return '目前還沒有排行榜資料。';
    }

    const rankingStats = buildRankingStats(responses).slice(0, limit);
    const users = await getUsersByIds(rankingStats.map((stat) => stat.userId));
    const usersById = new Map(users.map((user) => [user.user_id, user]));
    const lines = [
        `🏆 排行榜 Top ${limit}`,
        '',
        ...rankingStats.map((stat, index) => {
            const user = usersById.get(stat.userId);
            const displayName = user?.display_name || '未知使用者';
            const studentId = user?.student_id || '無學號';
            const accuracyPercent = Math.round(stat.accuracy * 100);
            return `${index + 1}. ${displayName} (${studentId}) - ${stat.correctCount} 分｜答題 ${stat.totalAnswered}｜答對率 ${accuracyPercent}%`;
        }),
    ];

    let output = lines.join('\n');

    if (output.length > 1900) {
        const safeLines: string[] = [];
        for (const line of lines) {
            const nextOutput = [...safeLines, line, '', '排行榜過長，已截斷以符合 Discord 訊息限制。'].join('\n');
            if (nextOutput.length > 1900) break;
            safeLines.push(line);
        }
        output = [...safeLines, '', '排行榜過長，已截斷以符合 Discord 訊息限制。'].join('\n');
    }

    return output;
};

const formatGradingQueueResult = async () => {
    const pendingResponses = await getPendingQuizResponses();

    if (pendingResponses.length === 0) {
        return '目前沒有待批改的簡答題。';
    }

    const questionIds = [...new Set(pendingResponses.map((response) => response.question_id))];
    const questions = await Promise.all(questionIds.map((id) => getQuestionById(id)));
    const shortAnswerQuestions = new Map(
        questions
            .filter((question): question is Exclude<Awaited<ReturnType<typeof getQuestionById>>, null> => question !== null && question.question_type === 'short_answer')
            .map((question) => [question.id, question]),
    );

    const grouped = questionIds
        .map((questionId) => {
            const question = shortAnswerQuestions.get(questionId);
            if (!question) return null;

            return {
                question,
                count: pendingResponses.filter((response) => response.question_id === questionId).length,
            };
        })
        .filter((item): item is { question: NonNullable<Awaited<ReturnType<typeof getQuestionById>>>; count: number } => Boolean(item))
        .sort((a, b) => b.count - a.count || b.question.id - a.question.id);

    if (grouped.length === 0) {
        return '目前沒有待批改的簡答題。';
    }

    return [
        '📝 簡答待批改清單',
        `待批改總份數：${pendingResponses.length}`,
        '',
        ...grouped.map(({ question, count }, index) => {
            const link = buildGradingLink({ questionId: question.id, status: 'pending' });
            return `${index + 1}. 題號 #${question.id}｜${count} 份待批改\n${truncateContent(question.content, 60)}\n${link}`;
        }),
    ].join('\n\n');
};

const handleAnswerButton = async (interaction: ButtonInteraction) => {
    const parsedCustomId = parseAnswerCustomId(interaction.customId);

    if (!parsedCustomId) {
        await safeReply(interaction, '答題按鈕格式錯誤。', true);
        return;
    }

    const user = await getUserByDiscordId(interaction.user.id);

    if (!user) {
        await safeReply(interaction, '請先使用 /link 綁定學號後再答題。', true);
        return;
    }

    const question = await getQuestionById(parsedCustomId.questionId);

    if (!question) {
        await safeReply(interaction, '找不到這個題目。', true);
        return;
    }

    if (question.question_type !== 'multiple_choice') {
        await safeReply(interaction, '目前按鈕答題只支援選擇題。', true);
        return;
    }

    const parsedMetadata = parseQuestionMetadata(question.metadata);

    if (!parsedMetadata.ok) {
        await safeReply(interaction, parsedMetadata.error, true);
        return;
    }

    const correctAnswer = getStringMetadata(parsedMetadata.metadata, 'correct_answer');

    if (!correctAnswer) {
        await safeReply(interaction, '題目缺少正確答案', true);
        return;
    }

    const selectedOption = parsedCustomId.selectedOption;
    const isCorrect = selectedOption === correctAnswer;
    const groupId = await resolveChannelGroupId(interaction.channelId, interaction.channel);
    if (groupId) {
        await ensureGroupMember(groupId, interaction.user.id);
    }
    const { updated } = await upsertQuizResponse({
        user_id: interaction.user.id,
        question_id: question.id,
        group_id: groupId,
        selected_option: selectedOption,
        is_correct: isCorrect,
    });
    const stats = await getUserQuizStats(interaction.user.id);
    const explanation = getQuestionExplanation(question.metadata);
    const updatedMessage = updated ? '\n你先前的答案已更新。' : '';
    const explanationLine = explanation ? `\n解析：${explanation}` : '';
    const statsLines = `\n目前累積：答對 ${stats.correctCount} / 作答 ${stats.totalAnswered} / 答對率 ${stats.accuracyPercent}%`;
    const replyContent = isCorrect
        ? `✅ 答對了！\n你的答案：${selectedOption}${updatedMessage}${explanationLine}${statsLines}`
        : `❌ 答錯了。\n你的答案：${selectedOption}\n正確答案：${correctAnswer}${updatedMessage}${explanationLine}${statsLines}`;

    await safeReply(interaction, replyContent, true);
};

const handleShortAnswerButton = async (interaction: ButtonInteraction) => {
    const match = /^short:qid=(\d+)$/.exec(interaction.customId);
    if (!match) {
        await safeReply(interaction, '短答按鈕格式錯誤。', true);
        return;
    }

    const questionId = Number(match[1]);
    const question = await getQuestionById(questionId);
    if (!question || question.question_type !== 'short_answer') {
        await safeReply(interaction, '找不到這個短答題。', true);
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`short_modal:qid=${questionId}`)
        .setTitle(`第 ${questionId} 題短答提交`);

    const input = new TextInputBuilder()
        .setCustomId('answer_text')
        .setLabel('請輸入你的答案')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
        .setPlaceholder('輸入你的短答內容');

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
};

const handleDraftButton = async (interaction: ButtonInteraction) => {
    const [action, draftId] = interaction.customId.split(':');

    if (!draftId) {
        await safeReply(interaction, '題目草稿按鈕格式錯誤。', true);
        return;
    }

    if (action === 'approve_draft') {
        try {
            const question = await approveQuestionDraft(draftId, interaction.user.id);
            await clearRevisionTarget(buildAgentSessionId(interaction.user.id, interaction.channelId));
            await safeReply(
                interaction,
                `✅ 題目已建立。\nID：${question.id}\n題目：${question.content ?? '（無題目內容）'}\n接著可用 /open id:${question.id} 發題。`,
                true,
            );
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    if (action === 'revise_draft') {
        try {
            const draft = await getDraftById(draftId);

            if (!draft || draft.userId !== interaction.user.id) {
                await safeReply(interaction, '這份題目草稿已失效、已建立或已被清除。請重新生成。', true);
                return;
            }

            await setRevisionTarget(
                buildAgentSessionId(interaction.user.id, interaction.channelId),
                interaction.user.id,
                draftId,
            );

            await safeReply(
                interaction,
                `已鎖定這份草稿供下一次修改。\n請直接再用 /ask 補充修改要求，例如：\n/ask prompt:把這題改難一點，保留資料庫正規化主題\n\n目前草稿題目：${draft.payload.content}`,
                true,
            );
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    await safeReply(interaction, '未知的題目草稿操作。', true);
};

const handleBatchDraftButton = async (interaction: ButtonInteraction) => {
    const [action, batchId] = interaction.customId.split(':');

    if (!batchId) {
        await safeReply(interaction, '批次草稿按鈕格式錯誤。', true);
        return;
    }

    if (action === 'approve_batch') {
        try {
            const questions = await approveQuestionBatchDraft(batchId, interaction.user.id);
            const lines = [
                '✅ 批次題目已建立。',
                ...questions.map((question, index) => `第 ${index + 1} 題：ID ${question.id}｜${question.content ?? '（無題目內容）'}`),
            ];
            await safeReply(interaction, lines.join('\n'), true);
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    if (action === 'discard_batch') {
        try {
            await discardQuestionBatchDraft(batchId, interaction.user.id);
            await safeReply(interaction, '✅ 這批題目草稿已作廢。', true);
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    await safeReply(interaction, '未知的批次草稿操作。', true);
};

// 當機器人準備就緒時觸發
client.once('clientReady', async () => {
    console.log(`✅ 機器人已上線！登入身分：${client.user?.tag}`);

    // 向 Discord 註冊 Slash Commands
    const rest = new REST({ version: '10' }).setToken(token);
    try {
        console.log('⏳ 正在註冊 Slash Commands...');
        await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commands }
        );
        console.log('✅ Slash Commands 註冊成功！');
    } catch (error) {
        console.error('❌ 註冊指令失敗：', formatError(error));
    }
});

// 監聽使用者發送的互動指令
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith('answer:')) {
        try {
            await handleAnswerButton(interaction);
        } catch (error) {
            console.error('❌ 按鈕答題失敗：', formatError(error));
            await safeReply(interaction, '❌ 答題失敗，請稍後再試。', true);
        }
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('short:')) {
        try {
            await handleShortAnswerButton(interaction);
        } catch (error) {
            console.error('❌ 短答按鈕處理失敗：', formatError(error));
            await safeReply(interaction, '❌ 短答提交視窗開啟失敗，請稍後再試。', true);
        }
        return;
    }

    if (
        interaction.isButton()
        && (interaction.customId.startsWith('approve_draft:') || interaction.customId.startsWith('revise_draft:'))
    ) {
        try {
            await handleDraftButton(interaction);
        } catch (error) {
            console.error('❌ 題目草稿處理失敗：', formatError(error));
            await safeReply(interaction, '❌ 題目草稿處理失敗，請稍後再試。', true);
        }
        return;
    }

    if (
        interaction.isButton()
        && (interaction.customId.startsWith('approve_batch:') || interaction.customId.startsWith('discard_batch:'))
    ) {
        try {
            await handleBatchDraftButton(interaction);
        } catch (error) {
            console.error('❌ 批次草稿處理失敗：', formatError(error));
            await safeReply(interaction, '❌ 批次草稿處理失敗，請稍後再試。', true);
        }
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('short_modal:qid=')) {
        try {
            const match = /^short_modal:qid=(\d+)$/.exec(interaction.customId);
            if (!match) {
                await safeReply(interaction, '短答提交格式錯誤。', true);
                return;
            }

            const questionId = Number(match[1]);
            const user = await getUserByDiscordId(interaction.user.id);
            if (!user) {
                await safeReply(interaction, '請先使用 /link 綁定學號後再作答。', true);
                return;
            }

            const answerText = interaction.fields.getTextInputValue('answer_text').trim();
            if (!answerText) {
                await safeReply(interaction, '短答內容不可空白。', true);
                return;
            }

            const groupId = await resolveChannelGroupId(interaction.channelId, interaction.channel);
            if (groupId) {
                await ensureGroupMember(groupId, interaction.user.id);
            }

            await upsertQuizResponse({
                user_id: interaction.user.id,
                question_id: questionId,
                group_id: groupId,
                selected_option: null,
                is_correct: false,
                answer_text: answerText,
                status: 'pending',
            });

            await safeReply(interaction, '✅ 短答已提交。老師之後可以查看你的內容。若再次提交，系統會更新為最新版本。', true);
        } catch (error) {
            console.error('❌ 短答提交失敗：', formatError(error));
            await safeReply(interaction, '❌ 短答提交失敗，請稍後再試。', true);
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const chatInteraction = interaction as ChatInputCommandInteraction;

    try {
        // 處理 /help 指令
        if (chatInteraction.commandName === 'help') {
            const teacher = await isTeacher(chatInteraction);
            const studentCommands = [
                '`/help` - 顯示此訊息',
                '`/link student_id name` - 綁定學號',
                '`/me` - 查詢自己的綁定資料',
                '`/rank limit` - 顯示排行榜',
                '`/ask prompt` - 向助教提問或查詢自己的成績',
                '`/clear_memory` - 清除目前頻道中的 Agent 記憶與未確認題目草稿',
            ];
            const teacherCommands = [
                '`/list` - 顯示最近 10 筆題庫',
                '`/question id` - 查看題目詳情',
                '`/add content` - 老師新增選擇題',
                '`/add_short content rubric` - 老師新增短答題',
                '`/open id` - 老師開放題目',
                '`/check id` - 老師查看答題統計',
                '`/grading_queue` - 老師查看待批改簡答清單',
                '`/grade_link id` - 老師取得指定短答題批改連結',
                '`/batch_generate prompt count` - 老師批次產生 2 到 5 題草稿',
            ];

            await chatInteraction.reply({
                content: [
                    '✅ **VTA Discord Bot 已成功切換為 Node.js 程式碼模式！**',
                    '',
                    '可用指令：',
                    ...studentCommands,
                    ...(teacher ? teacherCommands : []),
                ].join('\n'),
                ephemeral: false // 設為 true 則只有指令發送者看得到
            });
            return;
        }

        // 處理 /link 指令
        if (chatInteraction.commandName === 'link') {
            const studentId = chatInteraction.options.getString('student_id', true);
            const name = chatInteraction.options.getString('name', true);

            await linkStudent(chatInteraction.user.id, name, studentId);

            await safeReply(
                chatInteraction,
                `✅ 綁定成功！\n姓名：${name}\n學號：${studentId}`,
                true,
            );
            return;
        }

        // 處理 /me 指令
        if (chatInteraction.commandName === 'me') {
            const user = await getUserByDiscordId(chatInteraction.user.id);

            if (!user) {
                await safeReply(
                    chatInteraction,
                    '你尚未綁定學號，請先使用 /link student_id:你的學號 name:你的姓名',
                    true,
                );
                return;
            }

            await safeReply(
                chatInteraction,
                `👤 我的資料\n姓名：${user.display_name ?? '未設定'}\n學號：${user.student_id ?? '未設定'}\n身分：${user.role ?? '未設定'}`,
                true,
            );
            return;
        }

        // 處理 /list 指令
        if (chatInteraction.commandName === 'list') {
            if (!(await requireTeacher(chatInteraction))) return;

            const questions = await getRecentQuestions(10);

            if (questions.length === 0) {
                await safeReply(chatInteraction, '目前題庫沒有資料', true);
                return;
            }

            const questionLines = questions
                .slice()
                .reverse()
                .map((question) => {
                    const topic = getQuestionTopic(question.metadata, question.category);
                    return `🆔 ${question.id} [${topic}]\n${truncateContent(question.content)}`;
                })
                .join('\n\n');

            await safeReply(
                chatInteraction,
                `📂 題庫總覽（最近 10 筆）\n------------------\n${questionLines}\n\n💡 使用 /question id:12 查看詳情`,
                true,
            );
            return;
        }

        // 處理 /question 指令
        if (chatInteraction.commandName === 'question') {
            if (!(await requireTeacher(chatInteraction))) return;

            const id = chatInteraction.options.getInteger('id', true);
            const question = await getQuestionById(id);

            await safeReply(
                chatInteraction,
                formatQuestionDetail(question),
                true,
            );
            return;
        }

        // 處理 /add 指令
        if (chatInteraction.commandName === 'add') {
            if (!(await requireTeacher(chatInteraction))) return;

            const content = chatInteraction.options.getString('content', true);
            const question = await addMultipleChoiceQuestion(content);

            await safeReply(
                chatInteraction,
                `✅ 題目新增成功！\nID：${question.id}\n題目：${question.content ?? content}`,
                true,
            );
            return;
        }

        if (chatInteraction.commandName === 'add_short') {
            if (!(await requireTeacher(chatInteraction))) return;

            const content = chatInteraction.options.getString('content', true);
            const rubric = chatInteraction.options.getString('rubric', true);
            const question = await createShortAnswerQuestion({
                content,
                rubric,
                category: '一般',
            });

            await safeReply(
                chatInteraction,
                `✅ 短答題新增成功！\nID：${question.id}\n題目：${question.content ?? content}`,
                true,
            );
            return;
        }

        // 處理 /open 指令
        if (chatInteraction.commandName === 'open') {
            if (!(await requireTeacher(chatInteraction))) return;

            const id = chatInteraction.options.getInteger('id', true);
            const question = await getQuestionById(id);

            if (!question) {
                await safeReply(chatInteraction, '找不到這個題目', true);
                return;
            }

            if (!chatInteraction.channel || !('send' in chatInteraction.channel)) {
                await safeReply(chatInteraction, '無法取得目前頻道，請在伺服器文字頻道中使用 /open。', true);
                return;
            }

            const groupId = await resolveChannelGroupId(chatInteraction.channelId, chatInteraction.channel);
            if (groupId) {
                await setCurrentQuestionForGroup(groupId, question.id);
            }

            if (question.question_type === 'multiple_choice') {
                const options = getMultipleChoiceOptions(question.metadata);

                if (options.length < 4) {
                    await safeReply(chatInteraction, '這題的選項資料不完整，無法開放。', true);
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor(0x2f80ed)
                    .setTitle(`第 ${question.id} 題`)
                    .setDescription(question.content ?? '（無題目內容）')
                    .addFields(buildQuestionOpenFields(
                        options,
                        getQuestionTopic(question.metadata, question.category),
                    ))
                    .setFooter({ text: '請在題目開放期間內作答。若重新選擇，系統會更新你的答案。' })
                    .setTimestamp(new Date());

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`answer:qid=${question.id}:opt=A`)
                        .setLabel('A')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`answer:qid=${question.id}:opt=B`)
                        .setLabel('B')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`answer:qid=${question.id}:opt=C`)
                        .setLabel('C')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`answer:qid=${question.id}:opt=D`)
                        .setLabel('D')
                        .setStyle(ButtonStyle.Primary),
                );

                await chatInteraction.channel.send({
                    embeds: [embed],
                    components: [row],
                });
            } else if (question.question_type === 'short_answer') {
                const parsedMetadata = parseQuestionMetadata(question.metadata);
                const rubric = parsedMetadata.ok
                    ? getStringMetadata(parsedMetadata.metadata, 'rubric') ?? question.rubric ?? null
                    : question.rubric ?? null;

                const embed = new EmbedBuilder()
                    .setColor(0x16a34a)
                    .setTitle(`第 ${question.id} 題`)
                    .setDescription(question.content ?? '（無題目內容）')
                    .addFields(buildShortAnswerOpenFields(
                        getQuestionTopic(question.metadata, question.category),
                        rubric,
                    ))
                    .setFooter({ text: '可重複提交，系統會保留你最後一次的短答內容。' })
                    .setTimestamp(new Date());

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`short:qid=${question.id}`)
                        .setLabel('提交短答')
                        .setStyle(ButtonStyle.Success),
                );

                await chatInteraction.channel.send({
                    embeds: [embed],
                    components: [row],
                });
            } else {
                await safeReply(chatInteraction, '目前 /open 只支援選擇題與短答題', true);
                return;
            }

            await safeReply(chatInteraction, `✅ 已開放第 ${question.id} 題`, true);
            return;
        }

        // 處理 /check 指令
        if (chatInteraction.commandName === 'check') {
            if (!(await requireTeacher(chatInteraction))) return;

            const id = chatInteraction.options.getInteger('id', true);
            await safeReply(chatInteraction, await formatCheckResult(id), true);
            return;
        }

        if (chatInteraction.commandName === 'grading_queue') {
            if (!(await requireTeacher(chatInteraction))) return;

            await safeReply(chatInteraction, await formatGradingQueueResult(), true);
            return;
        }

        if (chatInteraction.commandName === 'grade_link') {
            if (!(await requireTeacher(chatInteraction))) return;

            const id = chatInteraction.options.getInteger('id', true);
            const question = await getQuestionById(id);

            if (!question) {
                await safeReply(chatInteraction, '找不到這個題目。', true);
                return;
            }

            if (question.question_type !== 'short_answer') {
                await safeReply(chatInteraction, '這不是短答題，沒有簡答批改頁連結。', true);
                return;
            }

            const link = buildGradingLink({ questionId: id, status: 'pending' });
            await safeReply(
                chatInteraction,
                `🔗 第 ${id} 題批改連結\n${truncateContent(question.content, 80)}\n${link}`,
                true,
            );
            return;
        }

        // 處理 /rank 指令
        if (chatInteraction.commandName === 'rank') {
            const limit = getLimitedRankCount(chatInteraction.options.getInteger('limit'));
            await safeReply(chatInteraction, await formatRankResult(limit), false);
            return;
        }

        if (chatInteraction.commandName === 'clear_memory') {
            const sessionId = buildAgentSessionId(chatInteraction.user.id, chatInteraction.channelId);
            await clearAgentMessages(sessionId);
            await clearRevisionTarget(sessionId);
            await clearDraftsByUser(chatInteraction.user.id);
            await clearBatchDraftsByUser(chatInteraction.user.id);
            await safeReply(chatInteraction, '✅ 已清除你在目前頻道的 Agent 記憶與未確認題目草稿。', true);
            return;
        }

        if (chatInteraction.commandName === 'batch_generate') {
            if (!(await requireTeacher(chatInteraction))) return;

            const prompt = chatInteraction.options.getString('prompt', true).trim();
            const count = chatInteraction.options.getInteger('count', true);

            await chatInteraction.deferReply({ ephemeral: true });
            const batchDraft = await generateQuestionBatchDraft(chatInteraction.user.id, prompt, count);
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`approve_batch:${batchDraft.batchId}`)
                    .setLabel('全部建立')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`discard_batch:${batchDraft.batchId}`)
                    .setLabel('全部作廢')
                    .setStyle(ButtonStyle.Danger),
            );

            await chatInteraction.followUp({
                content: getBatchPreviewText(batchDraft.questions),
                components: [row],
                ephemeral: true,
            });
            return;
        }

        if (chatInteraction.commandName === 'ask') {
            const prompt = chatInteraction.options.getString('prompt', true).trim();

            if (!prompt) {
                await safeReply(chatInteraction, '請輸入問題內容。', true);
                return;
            }

            await chatInteraction.deferReply({ ephemeral: true });
            const result = await askAgent({
                userId: chatInteraction.user.id,
                question: prompt,
                sessionId: buildAgentSessionId(chatInteraction.user.id, chatInteraction.channelId),
            });

            if (result.draftPreview) {
                if (!hasValidDraftPreview(result.draftPreview)) {
                    await safeReply(chatInteraction, '❌ 題目草稿格式不完整，這次不會建立。請重新描述需求再試一次。', true);
                    return;
                }

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`approve_draft:${result.draftPreview.draftId}`)
                        .setLabel('同意建立')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`revise_draft:${result.draftPreview.draftId}`)
                        .setLabel('我要修改')
                        .setStyle(ButtonStyle.Secondary),
                );

                await chatInteraction.followUp({
                    content: `${result.answer}\n\n${getDraftPreviewText(result.draftPreview)}`,
                    components: [row],
                    ephemeral: true,
                });
                return;
            }

            await safeReply(chatInteraction, result.answer, true);
            return;
        }
    } catch (error) {
        console.error('❌ 指令處理失敗：', formatError(error));

        const failureMessage = chatInteraction.commandName === 'link'
            ? '❌ 綁定失敗，請稍後再試。'
            : chatInteraction.commandName === 'add'
                ? '❌ 題目新增失敗，請稍後再試。'
                : chatInteraction.commandName === 'ask'
                    ? '❌ Agent 暫時無法回覆，請稍後再試。'
                : '❌ 指令執行失敗，請稍後再試。';

        await safeReply(chatInteraction, failureMessage, true);
    }
});

// 啟動機器人
client.login(token);
