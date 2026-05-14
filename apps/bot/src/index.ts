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
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    REST,
    Routes,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    type APIEmbedField,
    type Message,
    type MessageReaction,
    type StringSelectMenuInteraction,
} from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { approveQuestionDraft, clearDraftsByUser, getDraftById } from './services/aiQuestionService';
import { askAgent, buildAgentSessionId } from './services/agentService';
import { clearAgentMessages } from './services/agentMemoryService';
import { appendChatMessage } from './services/chatMemoryService';
import { clearRevisionTarget, setRevisionTarget } from './services/agentRevisionStateService';
import {
    approveQuestionBatchDraft,
    clearBatchDraftsByUser,
    createSingleQuestionFromBatchDraft,
    deleteSingleQuestionFromBatchDraft,
    discardQuestionBatchDraft,
    generateQuestionBatchDraft,
    getBatchDraftById,
    QuestionBatchDraftRecord,
    reviseSingleQuestionFromBatchDraft,
} from './services/batchQuestionService';
import { getCommandAuditChannelIdForGuild, getTeacherLogChannelIdForGuild, upsertGuildSettingsFromRuntime } from './services/guildSettingsService';
import { ensureDiscordChannelGroup, ensureGroupMember, setCurrentQuestionForGroup } from './services/groupService';
import { generateImageFromPrompt } from './services/imageService';
import { generateModelText } from './services/llmService';
import { createMultipleChoiceQuestion, createShortAnswerQuestion, createSurveyQuestion, getQuestionById, getRecentQuestions } from './services/questionService';
import { runStudioTask } from './services/studioService';
import {
    getExistingResponse,
    getAllQuizResponses,
    getPendingQuizResponses,
    getQuizResponsesByGroupId,
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

const ensureVertexCredentialsFromEnv = () => {
    const provider = (process.env.GEMINI_PROVIDER || 'gemini').toLowerCase();
    if (provider !== 'vertex') {
        return;
    }

    const rawJson = process.env.GCP_SERVICE_ACCOUNT_JSON?.trim();
    if (!rawJson && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return;
    }
    if (!rawJson) {
        return;
    }

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
        throw new Error('GCP_SERVICE_ACCOUNT_JSON 不是合法 JSON，請檢查 Render 環境變數內容。');
    }

    if (typeof parsed.private_key === 'string') {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }

    const credentialPath = path.join(os.tmpdir(), `dc-vta-gcp-${process.pid}.json`);
    fs.writeFileSync(credentialPath, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8' });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
};

ensureVertexCredentialsFromEnv();

const requiredEnvVars = [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
] as const;

const provider = (process.env.GEMINI_PROVIDER || 'gemini').toLowerCase();
const providerRequiredEnvVars =
    provider === 'vertex'
        ? ['GCP_PROJECT_ID']
        : ['GEMINI_API_KEY'];
const missingEnvVars = [
    ...requiredEnvVars.filter((key) => !process.env[key]),
    ...providerRequiredEnvVars.filter((key) => !process.env[key]),
];

if (provider === 'vertex') {
    const hasCredentialPath = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const hasCredentialJson = Boolean(process.env.GCP_SERVICE_ACCOUNT_JSON);
    if (!hasCredentialPath && !hasCredentialJson) {
        missingEnvVars.push('GOOGLE_APPLICATION_CREDENTIALS 或 GCP_SERVICE_ACCOUNT_JSON');
    }
}

if (missingEnvVars.length > 0) {
    throw new Error(`缺少必要環境變數：${missingEnvVars.join(', ')}`);
}

const token = process.env.DISCORD_TOKEN!;
const clientId = process.env.DISCORD_CLIENT_ID!;
const frontendBaseUrl = (process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const DEFAULT_OPEN_DURATION_MINUTES = 3;
const MAX_REACTION_TIME_SECONDS = 3600;
const DEFAULT_POLL_DURATION_HOURS = 24;
const MAX_POLL_OPTIONS = 10;
const TEACHER_COMMAND_DEFAULT_PERMISSIONS = PermissionFlagsBits.ManageGuild.toString();
const ENV_FILE_PATH = path.resolve(process.cwd(), '.env');
const SUPPORTED_MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.1-pro-preview',
] as const;
type SupportedModel = typeof SUPPORTED_MODELS[number];
const DEFAULT_LOCATION_BY_MODEL: Record<SupportedModel, string> = {
    'gemini-2.5-flash-lite': 'us-central1',
    'gemini-2.5-flash': 'us-central1',
    'gemini-2.5-pro': 'us-central1',
    'gemini-3.1-flash-lite-preview': 'global',
    'gemini-3.1-pro-preview': 'global',
};

// 初始化機器人客戶端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
});

const readEnvFileLines = () => {
    if (!fs.existsSync(ENV_FILE_PATH)) {
        return [] as string[];
    }
    return fs.readFileSync(ENV_FILE_PATH, 'utf8').split(/\r?\n/);
};

const upsertEnvValue = (lines: string[], key: string, value: string) => {
    const nextLine = `${key}=${value}`;
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) {
        lines[index] = nextLine;
        return;
    }
    lines.push(nextLine);
};

const applyModelRuntimeConfig = (model: SupportedModel, location: string) => {
    process.env.GEMINI_MODEL = model;
    process.env.QUESTION_MODEL = model;
    process.env.GCP_LOCATION = location;
};

const saveModelConfigToEnv = (model: SupportedModel, location: string) => {
    const lines = readEnvFileLines();
    upsertEnvValue(lines, 'GEMINI_MODEL', model);
    upsertEnvValue(lines, 'QUESTION_MODEL', model);
    upsertEnvValue(lines, 'GCP_LOCATION', location);
    fs.writeFileSync(ENV_FILE_PATH, `${lines.join('\n').replace(/\n*$/, '\n')}`, 'utf8');
};

const findAnnouncementChannel = (interaction: ChatInputCommandInteraction) => {
    const guild = interaction.guild;
    if (!guild) return null;
    const channel = guild.channels.cache.find(
        (item) => item.isTextBased() && item.name === '公告',
    );
    return channel && 'send' in channel ? channel : null;
};

const rememberChannelEvent = async (channelId: string, userId: string, content: string, role: 'user' | 'assistant' = 'user') => {
    const sessionId = buildAgentSessionId(userId, channelId);
    await appendChatMessage({
        session_id: sessionId,
        user_id: userId,
        role,
        content,
    });
};

const MAX_LIVE_CONTEXT_MESSAGES = Math.max(3, Math.min(20, Number(process.env.MENTION_CONTEXT_LIMIT || 20)));

const buildLiveChannelContext = async (message: Message): Promise<string> => {
    try {
        const recent = await message.channel.messages.fetch({
            before: message.id,
            limit: MAX_LIVE_CONTEXT_MESSAGES,
        });

        const lines = [...recent.values()]
            .filter((item) => !item.author.bot && !item.system)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((item) => {
                const content = item.content.trim().replace(/\s+/g, ' ').slice(0, 240);
                if (!content) {
                    return '';
                }
                return `${item.author.username}: ${content}`;
            })
            .filter((line) => line.length > 0);

        return lines.join('\n');
    } catch (error) {
        console.warn('⚠️ 無法讀取近期聊天室內容：', formatError(error));
        return '';
    }
};

type MentionIntentResult = {
    intent: 'image' | 'chat';
    prompt: string;
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

const VISUAL_CUES = [
    'hyper-realistic', 'cinematic', '8k', 'masterpiece', 'photorealistic', 'highly detailed',
    'lighting', 'composition', 'shot', 'render', 'pixel art', 'anime style', 'oil painting',
    'surreal', 'wide angle', 'depth of field', 'ultra detailed', 'concept art',
    '寫實', '電影感', '高細節', '構圖', '光線', '像素風', '插畫風', '油畫風', '超現實', '景深',
];

const looksLikeImagePrompt = (text: string) => {
    const input = text.trim();
    if (input.length < 24) return false;

    const lower = input.toLowerCase();
    const cueHits = VISUAL_CUES.reduce((count, cue) => count + (lower.includes(cue.toLowerCase()) ? 1 : 0), 0);
    const commaCount = (input.match(/[,，]/g) ?? []).length;
    const hasResolution = /\b(?:4k|8k|16k|1080p|4:3|16:9|9:16)\b/i.test(input);
    const longEnglishRun = /[a-zA-Z]/.test(input) && input.length > 120;

    return cueHits >= 2 || (cueHits >= 1 && commaCount >= 3) || hasResolution || longEnglishRun;
};

const buildImageReplyText = async (prompt: string) => {
    try {
        const answer = await generateModelText({
            model: process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview',
            prompt: [
                '你是 Discord 助手，剛完成一張圖片生成。',
                '請用繁體中文輸出 1 句自然、簡短、有人味的回覆。',
                '不要重複完整 prompt，不要使用引號，不要加條列。',
                `圖片需求大意：${prompt}`,
            ].join('\n'),
            temperature: 0.7,
            maxOutputTokens: 80,
        });
        const text = answer.trim();
        if (text.length > 0) return text;
    } catch {
        // Fallback below.
    }

    return '好，這張幫你生好了，看看這個版本合不合你想像。';
};

const THINKING_REACTION = process.env.THINKING_REACTION?.trim() || '🤓';

const addThinkingReaction = async (message: Message): Promise<MessageReaction | null> => {
    try {
        return await message.react(THINKING_REACTION);
    } catch (error) {
        console.warn('⚠️ 無法加入思考表情：', formatError(error));
        return null;
    }
};

const clearThinkingReaction = async (reaction: MessageReaction | null) => {
    if (!reaction) return;

    try {
        const botUserId = reaction.client.user?.id;
        if (!botUserId) return;
        await reaction.users.remove(botUserId);
    } catch (error) {
        console.warn('⚠️ 無法移除思考表情：', formatError(error));
    }
};

const detectMentionIntent = async (rawPrompt: string): Promise<MentionIntentResult> => {
    const classifierPrompt = [
        '你是意圖分類器。',
        '請判斷使用者是否在要求「生成圖片」。',
        '只輸出 JSON，不要輸出其他文字。',
        '格式：{"intent":"image|chat","prompt":"..."}',
        '規則：',
        '- 若使用者想要你畫圖、做圖、生成圖片、輸出圖像，intent=image',
        '- 其他一般問答或聊天 intent=chat',
        '- prompt 請回傳去掉命令語氣後的核心內容；若 intent=chat 則可原樣回傳',
        `使用者輸入：${rawPrompt}`,
    ].join('\n');

    const answer = await generateModelText({
        model: process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview',
        prompt: classifierPrompt,
        temperature: 0,
        maxOutputTokens: 120,
        responseMimeType: 'application/json',
    });

    const parsed = JSON.parse(extractFirstJsonObject(answer)) as Partial<MentionIntentResult>;
    const intent = parsed.intent === 'image' ? 'image' : 'chat';
    const prompt = (parsed.prompt ?? rawPrompt).trim() || rawPrompt;
    return { intent, prompt };
};

// 定義 Slash Commands
const commands = [
    {
        name: 'poll_create',
        description: '建立 Discord 原生投票',
        options: [
            {
                name: 'question',
                description: '投票問題',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'options',
                description: '選項，請用 | 分隔，例如：西式|中式|不吃早餐',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'duration_hours',
                description: '投票時長（小時，預設 24）',
                type: ApplicationCommandOptionType.Integer,
                required: false,
                min_value: 1,
                max_value: 168,
            },
            {
                name: 'multi_select',
                description: '是否允許複選（預設 否）',
                type: ApplicationCommandOptionType.Boolean,
                required: false,
            },
        ],
    },
    {
        name: 'help',
        description: '顯示 VTA Bot 的可用指令清單',
    },
    {
        name: 'image',
        description: '生成一張圖片',
        options: [
            {
                name: 'prompt',
                description: '圖片描述，例如：賽博龐克台北夜景',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: 'model',
        description: '查看或切換目前使用的模型',
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
        dm_permission: false,
        options: [
            {
                name: 'name',
                description: '要切換的模型名稱（不填則只顯示目前設定）',
                type: ApplicationCommandOptionType.String,
                required: false,
                choices: SUPPORTED_MODELS.map((model) => ({ name: model, value: model })),
            },
        ],
    },
    {
        name: 'agent',
        description: '執行工作室任務（摘要/研究）',
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
        dm_permission: false,
        options: [
            {
                name: 'action',
                description: '要執行的任務',
                type: ApplicationCommandOptionType.String,
                required: true,
                choices: [
                    { name: 'summarize_channel', value: 'summarize_channel' },
                    { name: 'research', value: 'research' },
                ],
            },
            {
                name: 'prompt',
                description: 'research 任務的查詢主題',
                type: ApplicationCommandOptionType.String,
                required: false,
            },
        ],
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
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
    },
    {
        name: 'question',
        description: '查看指定題目詳情',
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
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
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
        options: [
            {
                name: 'content',
                description: '題目內容（例如：今晚吃什麼最均衡？）',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'option_a',
                description: '選項 A',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'option_b',
                description: '選項 B',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'option_c',
                description: '選項 C',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'option_d',
                description: '選項 D',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'correct',
                description: '正確答案（A/B/C/D）',
                type: ApplicationCommandOptionType.String,
                required: true,
                choices: [
                    { name: 'A', value: 'A' },
                    { name: 'B', value: 'B' },
                    { name: 'C', value: 'C' },
                    { name: 'D', value: 'D' },
                ],
            },
            {
                name: 'explanation',
                description: '解析（選填）',
                type: ApplicationCommandOptionType.String,
                required: false,
            },
        ],
    },
    {
        name: 'add_short',
        description: '老師新增一題短答題',
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
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
        description: '老師開放一題題目',
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
        options: [
            {
                name: 'id',
                description: '題目 ID',
                type: ApplicationCommandOptionType.Integer,
                required: true,
            },
            {
                name: 'duration_minutes',
                description: '開放作答時間（分鐘，預設 3 分鐘，最多 1440 分鐘）',
                type: ApplicationCommandOptionType.Integer,
                required: false,
                min_value: 1,
                max_value: 1440,
            },
        ],
    },
    {
        name: 'add_survey',
        description: '老師新增一題問卷題（不需 rubric）',
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
        options: [
            {
                name: 'content',
                description: '問卷題目內容',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: 'allow_repeat_answer',
                description: '是否允許同一位學生重複提交（預設：否）',
                type: ApplicationCommandOptionType.Boolean,
                required: false,
            },
        ],
    },
    {
        name: 'check',
        description: '老師查看指定題目的答題統計',
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
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
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
    },
    {
        name: 'grade_link',
        description: '老師取得簡答題批改頁連結',
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
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
        description: '向課堂助教 Agent 發問或要求資料分析',
        options: [
            {
                name: 'prompt',
                description: '你想問 Agent 的問題，例如班級分析、個人診斷、出題需求',
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
        default_member_permissions: TEACHER_COMMAND_DEFAULT_PERMISSIONS,
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

const getBooleanMetadata = (metadata: QuestionMetadata | null, key: string, fallback = false) => {
    const value = metadata?.[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') return true;
        if (normalized === 'false' || normalized === '0') return false;
    }
    return fallback;
};

const isSurveyRepeatAllowed = (question: Awaited<ReturnType<typeof getQuestionById>>): boolean => {
    if (!question || question.question_type !== 'survey') return false;
    const parsed = parseQuestionMetadata(question.metadata);
    if (!parsed.ok) return false;
    return getBooleanMetadata(parsed.metadata, 'allow_repeat_answer', false);
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

    if (questionType === 'survey') {
        lines.push(
            '🧾 題型說明：問卷題（無評分規準）',
            `🔁 重複作答：${getBooleanMetadata(parsedMetadata.metadata, 'allow_repeat_answer', false) ? '允許' : '不允許'}`,
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

    if (question.question_type === 'short_answer' || question.question_type === 'survey') {
        const gradingLink = buildGradingLink({ questionId, status: 'pending' });

        if (responses.length === 0) {
            if (question.question_type === 'survey') {
                return `📊 第 ${questionId} 題目前還沒有問卷提交。`;
            }
            return `📊 第 ${questionId} 題目前還沒有短答提交。\n\n🔗 批改頁面：\n${gradingLink}`;
        }

        const users = await getUsersByIds([...new Set(responses.map((response) => response.user_id))]);
        const usersById = new Map(users.map((user) => [user.user_id, user]));
        const lines = [
            question.question_type === 'survey' ? `📊 第 ${questionId} 題問卷提交` : `📊 第 ${questionId} 題短答提交`,
            '',
            '📝 題目：',
            truncateContent(question.content, 80),
            '',
            `👥 已提交人數：${responses.length} 人`,
            ...(question.question_type === 'short_answer' ? [`🔗 批改頁面：${gradingLink}`, ''] : []),
            ...responses.slice(0, 60).map((response, index) => {
                const user = usersById.get(response.user_id);
                const displayName = user?.display_name || '未知使用者';
                const studentId = user?.student_id || '無學號';
                const answerText = response.answer_text?.trim() || '（未填寫內容）';
                return `${index + 1}. ${displayName} (${studentId})\n${answerText}`;
            }),
        ];

        if (responses.length > 60) {
            lines.push('', '提交內容過長，僅顯示前 60 筆。');
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

const getGuildGroupName = (
    guild: unknown,
    guildId: string | null,
) => {
    const guildName = (
        guild
        && typeof guild === 'object'
        && 'name' in guild
        && typeof (guild as { name?: unknown }).name === 'string'
    )
        ? (guild as { name: string }).name.trim()
        : null;
    return guildName && guildName.length > 0
        ? guildName
        : (guildId ? `discord-guild-${guildId}` : null);
};

const parsePollOptions = (raw: string): string[] => raw
    .split('|')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_POLL_OPTIONS);

const autoAssignRoleAfterLink = async (
    interaction: ChatInputCommandInteraction,
): Promise<{ assigned: boolean; message: string | null }> => {
    if (!interaction.guild || !interaction.guildId) {
        return { assigned: false, message: '⚠️ 目前不在伺服器情境，無法自動發放身分組。' };
    }

    const studentRoleId = process.env.STUDENT_ROLE_ID ?? null;
    const targetRoleId = studentRoleId;

    if (!targetRoleId) {
        return { assigned: false, message: '⚠️ 尚未設定可自動發放的身分組 ID（請設定 `STUDENT_ROLE_ID`）。' };
    }

    try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(targetRoleId)) {
            const roleName = interaction.guild.roles.cache.get(targetRoleId)?.name ?? '學生身分組';
            return { assigned: false, message: `ℹ️ 你已經有身分組：${roleName}` };
        }

        await member.roles.add(targetRoleId, 'Auto assigned after /link');
        const roleName = interaction.guild.roles.cache.get(targetRoleId)?.name ?? '學生身分組';
        return { assigned: true, message: `🎖️ 已自動發放身分組：${roleName}` };
    } catch (error) {
        return { assigned: false, message: `⚠️ 綁定成功，但自動發放身分組失敗：${formatError(error)}` };
    }
};

const resolveGuildGroupId = async (
    guildId: string | null,
    guild: unknown,
) => {
    if (!guildId) {
        return null;
    }

    const group = await ensureDiscordChannelGroup(guildId, getGuildGroupName(guild, guildId));
    return group?.group_id ?? null;
};

const getGuildCategoryName = (guild: unknown, guildId: string | null) =>
    getGuildGroupName(guild, guildId) ?? '一般';

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

type RuntimeGuildLike = {
    id?: string;
    name?: string;
    channels?: { cache?: Map<string, unknown> | { values: () => Iterable<unknown> } };
};

const resolveGuildTextChannelById = async (channelId: string | null, warningTitle: string) => {
    if (!channelId) {
        return null;
    }

    try {
        const fetched = await client.channels.fetch(channelId);
        if (fetched && 'send' in fetched && typeof fetched.send === 'function') {
            return fetched;
        }
    } catch (error) {
        console.warn(`⚠️ ${warningTitle}：`, formatError(error));
    }

    return null;
};

const resolveTeacherLogChannel = async (guild: unknown) => {
    if (!guild || typeof guild !== 'object' || !('channels' in guild)) {
        return null;
    }

    const runtimeGuild = guild as RuntimeGuildLike;
    const configuredTeacherLogChannelId = runtimeGuild.id
        ? await getTeacherLogChannelIdForGuild(runtimeGuild.id)
        : null;

    const configuredChannel = await resolveGuildTextChannelById(
        configuredTeacherLogChannelId,
        '無法取得 TEACHER_LOG_CHANNEL_ID 指定的頻道',
    );
    if (configuredChannel) {
        return configuredChannel;
    }

    const channels = runtimeGuild.channels?.cache;
    if (!channels || typeof channels.values !== 'function') {
        return null;
    }

    for (const channel of channels.values()) {
        if (
            channel
            && typeof channel === 'object'
            && 'name' in channel
            && (channel as { name?: unknown }).name === 'teacher'
            && 'send' in channel
            && typeof (channel as { send?: unknown }).send === 'function'
        ) {
            // If we discovered the teacher channel by convention, persist it into guild_settings
            // so operators can see it in dashboard and avoid repeated fallback lookups.
            if (!configuredTeacherLogChannelId && runtimeGuild.id && 'id' in channel) {
                const discoveredChannelId = typeof (channel as { id?: unknown }).id === 'string'
                    ? (channel as { id: string }).id
                    : null;

                if (discoveredChannelId) {
                    try {
                        await upsertGuildSettingsFromRuntime({
                            guildId: runtimeGuild.id,
                            guildName: typeof runtimeGuild.name === 'string' ? runtimeGuild.name : null,
                            teacherLogChannelId: discoveredChannelId,
                        });
                    } catch (error) {
                        console.warn('⚠️ 自動回寫 teacher_log_channel_id 失敗：', formatError(error));
                    }
                }
            }

            return channel as { send: (payload: { embeds: EmbedBuilder[] }) => Promise<unknown> };
        }
    }

    return null;
};

const resolveCommandAuditChannel = async (guild: unknown) => {
    if (!guild || typeof guild !== 'object' || !('channels' in guild)) {
        return null;
    }

    const runtimeGuild = guild as RuntimeGuildLike;
    const configuredCommandAuditChannelId = runtimeGuild.id
        ? await getCommandAuditChannelIdForGuild(runtimeGuild.id)
        : null;

    const configuredChannel = await resolveGuildTextChannelById(
        configuredCommandAuditChannelId,
        '無法取得 COMMAND_AUDIT_CHANNEL_ID 指定的頻道',
    );
    if (configuredChannel) {
        return configuredChannel;
    }

    const channels = runtimeGuild.channels?.cache;
    if (!channels || typeof channels.values !== 'function') {
        return null;
    }

    const fallbackNames = new Set(['command-log', 'bot-log', '指令紀錄', '指令日誌']);
    for (const channel of channels.values()) {
        if (
            channel
            && typeof channel === 'object'
            && 'name' in channel
            && typeof (channel as { name?: unknown }).name === 'string'
            && fallbackNames.has((channel as { name: string }).name)
            && 'send' in channel
            && typeof (channel as { send?: unknown }).send === 'function'
        ) {
            if (!configuredCommandAuditChannelId && runtimeGuild.id && 'id' in channel) {
                const discoveredChannelId = typeof (channel as { id?: unknown }).id === 'string'
                    ? (channel as { id: string }).id
                    : null;
                if (discoveredChannelId) {
                    try {
                        await upsertGuildSettingsFromRuntime({
                            guildId: runtimeGuild.id,
                            guildName: typeof runtimeGuild.name === 'string' ? runtimeGuild.name : null,
                            commandAuditChannelId: discoveredChannelId,
                        });
                    } catch (error) {
                        console.warn('⚠️ 自動回寫 command_audit_channel_id 失敗：', formatError(error));
                    }
                }
            }

            return channel as { send: (payload: { embeds: EmbedBuilder[] }) => Promise<unknown> };
        }
    }

    return null;
};

const formatCommandOptions = (interaction: ChatInputCommandInteraction) => {
    if (!interaction.options.data || interaction.options.data.length === 0) {
        return '（無參數）';
    }

    return interaction.options.data
        .map((option) => `${option.name}=${option.value ?? 'null'}`)
        .join(', ');
};

const buildCommandResultSummary = (status: 'success' | 'error', errorText: string | null) => {
    if (status === 'success') {
        return '成功';
    }

    return `失敗：${(errorText ?? '未知錯誤').slice(0, 200)}`;
};

const notifyCommandUsage = async (params: {
    interaction: ChatInputCommandInteraction;
    status: 'success' | 'error';
    errorText: string | null;
}) => {
    const channel = await resolveCommandAuditChannel(params.interaction.guild);
    if (!channel) {
        return;
    }

    const sourceChannelName = (
        params.interaction.channel
        && typeof params.interaction.channel === 'object'
        && 'name' in params.interaction.channel
        && typeof (params.interaction.channel as { name?: unknown }).name === 'string'
    )
        ? (params.interaction.channel as { name: string }).name
        : '未知頻道';

    const memberRoleNames = (
        params.interaction.member
        && typeof params.interaction.member === 'object'
        && 'roles' in params.interaction.member
        && params.interaction.member.roles
        && typeof params.interaction.member.roles === 'object'
        && 'cache' in params.interaction.member.roles
        && (params.interaction.member.roles as { cache?: { values?: () => Iterable<unknown> } }).cache
        && typeof (params.interaction.member.roles as { cache?: { values?: () => Iterable<unknown> } }).cache?.values === 'function'
    )
        ? [...(params.interaction.member.roles as { cache: { values: () => Iterable<unknown> } }).cache.values()]
            .map((role) => (
                role
                && typeof role === 'object'
                && 'name' in role
                && typeof (role as { name?: unknown }).name === 'string'
            )
                ? (role as { name: string }).name
                : null)
            .filter((name): name is string => Boolean(name))
            .slice(0, 8)
            .join(', ')
        : '';

    const embed = new EmbedBuilder()
        .setColor(params.status === 'success' ? 0x16a34a : 0xdc2626)
        .setTitle(`指令紀錄：/${params.interaction.commandName}`)
        .addFields(
            { name: '執行者', value: `${params.interaction.user.tag}\n<@${params.interaction.user.id}>`, inline: false },
            { name: 'Discord ID', value: params.interaction.user.id, inline: true },
            { name: '角色', value: memberRoleNames || '無角色資訊', inline: true },
            { name: '來源頻道', value: sourceChannelName, inline: true },
            { name: '伺服器', value: params.interaction.guild?.name ?? '未知伺服器', inline: true },
            { name: '參數', value: formatCommandOptions(params.interaction), inline: false },
            { name: '結果', value: buildCommandResultSummary(params.status, params.errorText), inline: false },
        )
        .setTimestamp(new Date());

    await channel.send({ embeds: [embed] });
};

const notifyTeacherLinkSuccess = async (params: {
    guild: unknown;
    sourceChannelName: string | null;
    discordUserId: string;
    discordTag: string;
    studentName: string;
    studentId: string;
}) => {
    const channel = await resolveTeacherLogChannel(params.guild);
    if (!channel) {
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0x16a34a)
        .setTitle('新學生完成綁定')
        .addFields(
            { name: '姓名', value: params.studentName, inline: true },
            { name: '學號', value: params.studentId, inline: true },
            { name: 'Discord', value: `${params.discordTag}\n<@${params.discordUserId}>`, inline: false },
            { name: 'Discord ID', value: params.discordUserId, inline: false },
            { name: '來源頻道', value: params.sourceChannelName ?? '未知頻道', inline: true },
        )
        .setTimestamp(new Date());

    await channel.send({ embeds: [embed] });
};

const buildQuestionOpenFields = (options: string[], category: string, closeAtMs: number) => {
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
        {
            name: '作答期限',
            value: `<t:${Math.floor(closeAtMs / 1000)}:R>`,
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

const buildShortAnswerOpenFields = (closeAtMs: number): APIEmbedField[] => [
    {
        name: '作答期限',
        value: `<t:${Math.floor(closeAtMs / 1000)}:R>`,
        inline: true,
    },
];

const getDraftPreviewText = (draft: {
    category: string;
    content: string;
    options: string[];
    correctAnswer: 'A' | 'B' | 'C' | 'D';
    explanation: string;
}, categoryOverride?: string) => {
    const normalizedOptions = draft.options.map((option) => option.replace(/^\s*[A-DＡ-Ｄ][\.\、\)\:：]\s*/i, '').trim());
    return [
    '以下是題目草稿，請確認：',
    '',
    `分類：${categoryOverride ?? draft.category}`,
    `題目：${draft.content}`,
    '',
    `A. ${normalizedOptions[0] ?? ''}`,
    `B. ${normalizedOptions[1] ?? ''}`,
    `C. ${normalizedOptions[2] ?? ''}`,
    `D. ${normalizedOptions[3] ?? ''}`,
    '',
    `答案：${draft.correctAnswer}`,
    `解析：${draft.explanation || '無'}`,
    '',
    '如果可以，按「同意建立」。如果要改，按「我要修改」後再用 /ask 補充修改要求。',
].join('\n');
};

const normalizePreviewOption = (option: string) => option.replace(/^\s*[A-DＡ-Ｄ][\.\、\)\:：]\s*/i, '').trim();

const buildBatchActionCustomId = (action: 'create_batch_item' | 'delete_batch_item' | 'revise_batch_item', batchId: string, itemId: string) =>
    `${action}:${batchId}:${itemId}`;

const buildBatchRevisionModalCustomId = (batchId: string, itemId: string) => `revise_batch_modal:${batchId}:${itemId}`;

const parseBatchItemCustomId = (customId: string) => {
    const match = /^(create_batch_item|delete_batch_item|revise_batch_item|revise_batch_modal):([^:]+):([^:]+)$/.exec(customId);
    if (!match) {
        return null;
    }

    return {
        action: match[1],
        batchId: match[2],
        itemId: match[3],
    };
};

const parseBatchSelectionCustomId = (customId: string) => {
    const match = /^select_batch_item:([^:]+)$/.exec(customId);
    if (!match) {
        return null;
    }

    return {
        batchId: match[1],
    };
};

const resolveBatchSelection = (draft: QuestionBatchDraftRecord, selectedItemId?: string | null) => {
    const visibleQuestions = draft.questions.filter((question) => question.status !== 'deleted');
    const selectedQuestion = visibleQuestions.find((question) => question.itemId === selectedItemId)
        ?? visibleQuestions.find((question) => question.status === 'active')
        ?? visibleQuestions[0]
        ?? null;
    const selectedIndex = selectedQuestion
        ? visibleQuestions.findIndex((question) => question.itemId === selectedQuestion.itemId)
        : -1;

    return {
        visibleQuestions,
        selectedQuestion,
        selectedIndex,
    };
};

const getBatchPreviewText = (draft: QuestionBatchDraftRecord, categoryOverride?: string, selectedItemId?: string | null) => {
    const visibleQuestions = draft.questions.filter((question) => question.status !== 'deleted');
    const pendingQuestions = draft.questions.filter((question) => question.status === 'active');
    const { selectedQuestion, selectedIndex } = resolveBatchSelection(draft, selectedItemId);
    const lines = [
        '以下是批次題目草稿，請確認：',
        '',
    ];

    if (visibleQuestions.length === 0) {
        lines.push('目前沒有可顯示的題目。');
    } else {
        visibleQuestions.forEach((question, index) => {
            const titleSuffix = question.status === 'created'
                ? `｜已建立${question.createdQuestionId ? `（ID ${question.createdQuestionId}）` : ''}`
                : '';

            lines.push(`第 ${index + 1} 題｜分類：${categoryOverride ?? question.payload.category}${titleSuffix}`);
            lines.push(`題目：${question.payload.content}`);
            lines.push(`A. ${normalizePreviewOption(question.payload.options[0] ?? '')}`);
            lines.push(`B. ${normalizePreviewOption(question.payload.options[1] ?? '')}`);
            lines.push(`C. ${normalizePreviewOption(question.payload.options[2] ?? '')}`);
            lines.push(`D. ${normalizePreviewOption(question.payload.options[3] ?? '')}`);
            lines.push(`答案：${question.payload.correct_answer}`);
            lines.push(`解析：${question.payload.explanation || '無'}`);
            lines.push('');
        });
    }

    if (selectedQuestion && selectedIndex >= 0) {
        const selectedStatus = selectedQuestion.status === 'created'
            ? `已建立${selectedQuestion.createdQuestionId ? `（ID ${selectedQuestion.createdQuestionId}）` : ''}`
            : '可操作';
        lines.push(`目前選取：第 ${selectedIndex + 1} 題｜${selectedStatus}`);
        lines.push('');
    }

    if (pendingQuestions.length > 0) {
        lines.push('請先用下拉選單選題，再按下方按鈕操作；也可以按「全部建立」一次建立剩餘題目。');
    } else {
        lines.push('目前沒有剩餘可建立的題目。若不要保留這份草稿，可按「全部作廢」。');
    }

    return lines.join('\n');
};

const buildBatchDraftComponents = (draft: QuestionBatchDraftRecord, selectedItemId?: string | null) => {
    const hasPendingQuestions = draft.questions.some((question) => question.status === 'active');
    const { visibleQuestions, selectedQuestion, selectedIndex } = resolveBatchSelection(draft, selectedItemId);
    const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

    if (visibleQuestions.length > 0) {
        rows.push(
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`select_batch_item:${draft.batchId}`)
                    .setPlaceholder('選擇要操作的題目')
                    .addOptions(
                        visibleQuestions.map((question, index) => {
                            const statusLabel = question.status === 'created'
                                ? `已建立${question.createdQuestionId ? ` #${question.createdQuestionId}` : ''}`
                                : '可操作';
                            return {
                                label: `第 ${index + 1} 題`,
                                value: question.itemId,
                                description: `${statusLabel}｜${question.payload.content.slice(0, 70)}`,
                                default: question.itemId === selectedQuestion?.itemId,
                            };
                        }),
                    ),
            ),
        );
    }

    if (selectedQuestion && selectedIndex >= 0) {
        const isCreated = selectedQuestion.status === 'created';
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(buildBatchActionCustomId('create_batch_item', draft.batchId, selectedQuestion.itemId))
                .setLabel(isCreated ? `已建立${selectedQuestion.createdQuestionId ? ` #${selectedQuestion.createdQuestionId}` : ''}` : '建立這題')
                .setStyle(ButtonStyle.Success)
                .setDisabled(isCreated),
            new ButtonBuilder()
                .setCustomId(buildBatchActionCustomId('revise_batch_item', draft.batchId, selectedQuestion.itemId))
                .setLabel('重生這題')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(isCreated),
            new ButtonBuilder()
                .setCustomId(buildBatchActionCustomId('delete_batch_item', draft.batchId, selectedQuestion.itemId))
                .setLabel('刪掉這題')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(isCreated),
        ));
    }

    const globalButtons = [
        new ButtonBuilder()
            .setCustomId(`approve_batch:${draft.batchId}`)
            .setLabel('全部建立')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!hasPendingQuestions),
        new ButtonBuilder()
            .setCustomId(`discard_batch:${draft.batchId}`)
            .setLabel('全部作廢')
            .setStyle(ButtonStyle.Danger),
    ];

    return [
        ...rows,
        new ActionRowBuilder<ButtonBuilder>().addComponents(...globalButtons),
    ];
};

const buildBatchDraftMessage = (draft: QuestionBatchDraftRecord, categoryOverride?: string, selectedItemId?: string | null) => ({
    content: getBatchPreviewText(draft, categoryOverride, selectedItemId),
    components: buildBatchDraftComponents(draft, selectedItemId),
});

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

const hasValidShortAnswerDraftPreview = (draft: {
    category: string;
    content: string;
    rubric: string;
}) => (
    draft.category.trim().length > 0
    && draft.content.trim().length > 0
    && draft.rubric.trim().length > 0
);

type PendingShortAnswerDraft = {
    category: string;
    content: string;
    rubric: string;
};

type PendingPollDraft = {
    question: string;
    options: string[];
    durationHours: number;
    allowMultiselect: boolean;
};

const pendingShortAnswerDrafts = new Map<string, PendingShortAnswerDraft>();
const pendingPollDrafts = new Map<string, PendingPollDraft>();

const buildShortDraftSessionKey = (userId: string, channelId: string | null) => `${userId}:${channelId ?? 'dm'}`;
const isShortDraftRevisionPrompt = (prompt: string) => /(修改|調整|改成|改為|重寫|優化|rubric|評分|難度|語氣|精簡|補充)/i.test(prompt);
const isPollDraftRevisionPrompt = (prompt: string) => /(修改|調整|改成|改為|重寫|選項|複選|期限|時長|小時|精簡|補充)/i.test(prompt);

const buildAnswerCustomId = (questionId: number, option: 'A' | 'B' | 'C' | 'D', openedAtMs: number, durationSeconds: number) =>
    `answer:qid=${questionId}:opt=${option}:open=${openedAtMs}:dur=${durationSeconds}`;

const buildShortAnswerButtonCustomId = (questionId: number, openedAtMs: number, durationSeconds: number) =>
    `short:qid=${questionId}:open=${openedAtMs}:dur=${durationSeconds}`;

const buildShortAnswerModalCustomId = (questionId: number, openedAtMs: number, durationSeconds: number) =>
    `short_modal:qid=${questionId}:open=${openedAtMs}:dur=${durationSeconds}`;

const parseShortAnswerCustomId = (customId: string) => {
    const match = /^short:qid=(\d+)(?::open=(\d{13}))?(?::dur=(\d+))?$/.exec(customId);
    if (!match) {
        return null;
    }

    return {
        questionId: Number(match[1]),
        openedAtMs: match[2] ? Number(match[2]) : null,
        durationSeconds: match[3] ? Number(match[3]) : null,
    };
};

const parseShortAnswerModalCustomId = (customId: string) => {
    const match = /^short_modal:qid=(\d+)(?::open=(\d{13}))?(?::dur=(\d+))?$/.exec(customId);
    if (!match) {
        return null;
    }

    return {
        questionId: Number(match[1]),
        openedAtMs: match[2] ? Number(match[2]) : null,
        durationSeconds: match[3] ? Number(match[3]) : null,
    };
};

const hasAnswerWindowExpired = (openedAtMs: number | null, durationSeconds: number | null) => {
    if (!openedAtMs || !durationSeconds) {
        return false;
    }

    return Date.now() > openedAtMs + (durationSeconds * 1000);
};

const calculateReactionTimeSeconds = (openedAtMs: number | null) => {
    if (!openedAtMs) {
        return null;
    }

    const diffSeconds = (Date.now() - openedAtMs) / 1000;
    if (diffSeconds <= 0 || diffSeconds >= MAX_REACTION_TIME_SECONDS) {
        return 0;
    }

    return Number(diffSeconds.toFixed(1));
};

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

const formatRankResult = async (guildId: string | null, guild: unknown, limit: number) => {
    const groupId = await resolveGuildGroupId(guildId, guild);
    if (!groupId) {
        return '目前無法判定這個 Discord 伺服器所屬班級，請在班級伺服器中使用 /rank。';
    }

    const responses = await getQuizResponsesByGroupId(groupId);
    if (responses.length === 0) {
        const groupName = getGuildGroupName(guild, guildId);
        return `${groupName ?? '目前班級'}還沒有排行榜資料。`;
    }

    const rankingStats = buildRankingStats(responses).slice(0, limit);
    if (rankingStats.length === 0) {
        const groupName = getGuildGroupName(guild, guildId);
        return `${groupName ?? '目前班級'}還沒有可列入排行榜的作答紀錄。`;
    }

    const users = await getUsersByIds(rankingStats.map((stat) => stat.userId));
    const usersById = new Map(users.map((user) => [user.user_id, user]));
    const groupName = getGuildGroupName(guild, guildId) ?? '目前班級';
    const lines = [
        `🏆 ${groupName} 排行榜 Top ${limit}`,
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

    if (hasAnswerWindowExpired(parsedCustomId.openedAtMs, parsedCustomId.durationSeconds)) {
        await safeReply(interaction, '⏰ 這題的作答時間已截止。', true);
        return;
    }

    const existingResponse = await getExistingResponse(interaction.user.id, question.id);
    if (existingResponse) {
        await safeReply(interaction, '⛔ 這一題你已經作答過了，每人只能提交一次。', true);
        return;
    }

    const selectedOption = parsedCustomId.selectedOption;
    const isCorrect = selectedOption === correctAnswer;
    const groupId = await resolveGuildGroupId(interaction.guildId, interaction.guild);
    if (groupId) {
        await ensureGroupMember(groupId, interaction.user.id);
    }
    await upsertQuizResponse({
        user_id: interaction.user.id,
        question_id: question.id,
        group_id: groupId,
        selected_option: selectedOption,
        is_correct: isCorrect,
        reaction_time: calculateReactionTimeSeconds(parsedCustomId.openedAtMs),
    });
    const stats = await getUserQuizStats(interaction.user.id);
    const explanation = getQuestionExplanation(question.metadata);
    const explanationLine = explanation ? `\n解析：${explanation}` : '';
    const statsLines = `\n你的目前累積：答對 ${stats.correctCount} / 作答 ${stats.totalAnswered} / 個人答對率 ${stats.accuracyPercent}%`;
    const replyContent = isCorrect
        ? `✅ 答對了！\n你的答案：${selectedOption}${explanationLine}${statsLines}`
        : `❌ 答錯了。\n你的答案：${selectedOption}${explanationLine}${statsLines}`;

    await safeReply(interaction, replyContent, true);
};

const handleShortAnswerButton = async (interaction: ButtonInteraction) => {
    const parsedCustomId = parseShortAnswerCustomId(interaction.customId);
    if (!parsedCustomId) {
        await safeReply(interaction, '短答按鈕格式錯誤。', true);
        return;
    }

    if (hasAnswerWindowExpired(parsedCustomId.openedAtMs, parsedCustomId.durationSeconds)) {
        await safeReply(interaction, '⏰ 這題的作答時間已截止。', true);
        return;
    }

    const questionId = parsedCustomId.questionId;
    const question = await getQuestionById(questionId);
    if (!question || (question.question_type !== 'short_answer' && question.question_type !== 'survey')) {
        await safeReply(interaction, '找不到這個可文字作答的題目。', true);
        return;
    }

    const allowRepeatAnswer = isSurveyRepeatAllowed(question);
    const existingResponse = await getExistingResponse(interaction.user.id, parsedCustomId.questionId);
    if (existingResponse && !(question.question_type === 'survey' && allowRepeatAnswer)) {
        await safeReply(interaction, '⛔ 這一題你已經作答過了，每人只能提交一次。', true);
        return;
    }

    const modalCustomId = parsedCustomId.openedAtMs && parsedCustomId.durationSeconds
        ? buildShortAnswerModalCustomId(questionId, parsedCustomId.openedAtMs, parsedCustomId.durationSeconds)
        : `short_modal:qid=${questionId}`;

    const modal = new ModalBuilder()
        .setCustomId(modalCustomId)
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
            const question = await approveQuestionDraft(
                draftId,
                interaction.user.id,
                getGuildCategoryName(interaction.guild, interaction.guildId),
            );
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

const handleShortDraftButton = async (interaction: ButtonInteraction) => {
    const [action] = interaction.customId.split(':');
    const sessionKey = buildShortDraftSessionKey(interaction.user.id, interaction.channelId);
    const draft = pendingShortAnswerDrafts.get(sessionKey);

    if (!draft) {
        await safeReply(interaction, '這份簡答題草稿已失效或不存在，請重新用 /ask 產生。', true);
        return;
    }

    if (action === 'approve_short_draft') {
        try {
            const question = await createShortAnswerQuestion({
                content: draft.content,
                rubric: draft.rubric,
                category: getGuildCategoryName(interaction.guild, interaction.guildId),
            });
            pendingShortAnswerDrafts.delete(sessionKey);
            await safeReply(
                interaction,
                `✅ 簡答題已建立。\nID：${question.id}\n題目：${question.content ?? '（無題目內容）'}\n可用指令：/open id:${question.id}`,
                true,
            );
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    if (action === 'revise_short_draft') {
        await safeReply(
            interaction,
            [
                '已保留這份簡答題草稿。',
                '請再用 /ask 補充你要修改的內容（題目或 rubric 都可）。',
                '例如：/ask prompt:把這題改成國中程度，rubric 改成內容40% 結構30% 用詞30%',
            ].join('\n'),
            true,
        );
        return;
    }

    await safeReply(interaction, '未知的簡答題草稿操作。', true);
};

const handlePollDraftButton = async (interaction: ButtonInteraction) => {
    const [action] = interaction.customId.split(':');
    const sessionKey = buildShortDraftSessionKey(interaction.user.id, interaction.channelId);
    const draft = pendingPollDrafts.get(sessionKey);

    if (!draft) {
        await safeReply(interaction, '這份投票草稿已失效或不存在，請重新用 /ask 產生。', true);
        return;
    }

    if (action === 'approve_poll_draft') {
        try {
            if (!interaction.channel || !('send' in interaction.channel)) {
                await safeReply(interaction, '無法取得目前頻道，請在伺服器文字頻道中操作。', true);
                return;
            }

            await interaction.channel.send({
                poll: {
                    question: { text: draft.question },
                    answers: draft.options.map((text) => ({ text })),
                    duration: draft.durationHours,
                    allowMultiselect: draft.allowMultiselect,
                },
            });
            pendingPollDrafts.delete(sessionKey);
            await safeReply(interaction, '✅ 已依草稿建立 Discord 原生投票。', true);
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    if (action === 'revise_poll_draft') {
        await safeReply(
            interaction,
            [
                '已保留這份投票草稿。',
                '請再用 /ask 補充你要修改的內容（題目、選項、時長、複選）。',
                '例如：/ask prompt:把選項改成 4 個，並允許複選，期限 12 小時',
            ].join('\n'),
            true,
        );
        return;
    }

    await safeReply(interaction, '未知的投票草稿操作。', true);
};

const handleBatchDraftButton = async (interaction: ButtonInteraction) => {
    const parsed = parseBatchItemCustomId(interaction.customId)
        ?? (() => {
            const [action, batchId] = interaction.customId.split(':');
            return action && batchId ? { action, batchId, itemId: null } : null;
        })();

    if (!parsed?.batchId) {
        await safeReply(interaction, '批次草稿按鈕格式錯誤。', true);
        return;
    }

    const categoryOverride = getGuildCategoryName(interaction.guild, interaction.guildId);

    if (parsed.action === 'create_batch_item') {
        try {
            if (!parsed.itemId) {
                await safeReply(interaction, '批次單題按鈕格式錯誤。', true);
                return;
            }

            const result = await createSingleQuestionFromBatchDraft(
                parsed.batchId,
                interaction.user.id,
                parsed.itemId,
                categoryOverride,
            );
            await interaction.update(buildBatchDraftMessage(result.draft, categoryOverride, parsed.itemId));
            await interaction.followUp({
                content: `✅ 已建立這題。\nID：${result.question.id}\n題目：${result.question.content ?? '（無題目內容）'}`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    if (parsed.action === 'delete_batch_item') {
        try {
            if (!parsed.itemId) {
                await safeReply(interaction, '批次單題按鈕格式錯誤。', true);
                return;
            }

            const draft = await deleteSingleQuestionFromBatchDraft(parsed.batchId, interaction.user.id, parsed.itemId);
            await interaction.update(buildBatchDraftMessage(draft, categoryOverride, parsed.itemId));
            await interaction.followUp({
                content: '✅ 這題已從批次草稿移除。',
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    if (parsed.action === 'revise_batch_item') {
        if (!parsed.itemId) {
            await safeReply(interaction, '批次單題按鈕格式錯誤。', true);
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(buildBatchRevisionModalCustomId(parsed.batchId, parsed.itemId))
            .setTitle('重生這一題');

        const input = new TextInputBuilder()
            .setCustomId('revision_prompt')
            .setLabel('你想怎麼修改這題')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500)
            .setPlaceholder('例如：改難一點，改成生活情境題，保留指標概念');

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        await interaction.showModal(modal);
        return;
    }

    if (parsed.action === 'approve_batch') {
        try {
            const questions = await approveQuestionBatchDraft(
                parsed.batchId,
                interaction.user.id,
                categoryOverride,
            );
            const refreshedDraft = await getBatchDraftById(parsed.batchId);
            const lines = [
                '✅ 批次題目已建立。',
                ...questions.map((question, index) => `第 ${index + 1} 題：ID ${question.id}｜${question.content ?? '（無題目內容）'}`),
            ];

            if (refreshedDraft) {
                await interaction.update(buildBatchDraftMessage(refreshedDraft, categoryOverride));
                await interaction.followUp({
                    content: lines.join('\n'),
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                await safeReply(interaction, lines.join('\n'), true);
            }
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    if (parsed.action === 'discard_batch') {
        try {
            await discardQuestionBatchDraft(parsed.batchId, interaction.user.id);
            await interaction.update({
                content: '✅ 這批題目草稿已作廢。',
                components: [],
            });
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    await safeReply(interaction, '未知的批次草稿操作。', true);
};

const handleBatchDraftSelection = async (interaction: StringSelectMenuInteraction) => {
    const parsed = parseBatchSelectionCustomId(interaction.customId);
    if (!parsed) {
        await safeReply(interaction, '批次題號選單格式錯誤。', true);
        return;
    }

    const selectedItemId = interaction.values[0];
    if (!selectedItemId) {
        await safeReply(interaction, '請先選擇要操作的題目。', true);
        return;
    }

    const draft = await getBatchDraftById(parsed.batchId!);
    if (!draft || draft.userId !== interaction.user.id) {
        await safeReply(interaction, '這份批次草稿已失效、已建立或已被清除。請重新生成。', true);
        return;
    }

    const categoryOverride = getGuildCategoryName(interaction.guild, interaction.guildId);
    await interaction.update(buildBatchDraftMessage(draft, categoryOverride, selectedItemId));
};

// 當機器人準備就緒時觸發
client.once('clientReady', async () => {
    console.log(`✅ 機器人已上線！登入身分：${client.user?.tag}`);

    const rest = new REST({ version: '10' }).setToken(token);

    for (const [, guild] of client.guilds.cache) {
        try {
            console.log(`⏳ 正在註冊 Slash Commands 到 guild ${guild.id} (${guild.name})...`);
            await rest.put(
                Routes.applicationGuildCommands(clientId, guild.id),
                { body: commands },
            );

            await upsertGuildSettingsFromRuntime({
                guildId: guild.id,
                guildName: guild.name,
            });

            console.log(`✅ Guild ${guild.name} Slash Commands 註冊成功！`);
        } catch (error) {
            console.error(`❌ Guild ${guild.id} 註冊指令失敗：`, formatError(error));
        }
    }
});

client.on('guildCreate', async (guild) => {
    const rest = new REST({ version: '10' }).setToken(token);

    try {
        console.log(`⏳ 偵測到新 guild，正在註冊 Slash Commands 到 ${guild.id} (${guild.name})...`);
        await rest.put(
            Routes.applicationGuildCommands(clientId, guild.id),
            { body: commands },
        );

        await upsertGuildSettingsFromRuntime({
            guildId: guild.id,
            guildName: guild.name,
        });

        console.log(`✅ 新 guild ${guild.name} 註冊完成！`);
    } catch (error) {
        console.error(`❌ 新 guild ${guild.id} 註冊失敗：`, formatError(error));
    }
});

// 監聽使用者發送的互動指令
client.on('interactionCreate', async (interaction) => {
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_batch_item:')) {
        try {
            await handleBatchDraftSelection(interaction);
        } catch (error) {
            console.error('❌ 批次題號選單處理失敗：', formatError(error));
            await safeReply(interaction, '❌ 批次題號選單處理失敗，請稍後再試。', true);
        }
        return;
    }

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
        && (interaction.customId.startsWith('approve_short_draft:') || interaction.customId.startsWith('revise_short_draft:'))
    ) {
        try {
            await handleShortDraftButton(interaction);
        } catch (error) {
            console.error('❌ 簡答題草稿處理失敗：', formatError(error));
            await safeReply(interaction, '❌ 簡答題草稿處理失敗，請稍後再試。', true);
        }
        return;
    }

    if (
        interaction.isButton()
        && (interaction.customId.startsWith('approve_poll_draft:') || interaction.customId.startsWith('revise_poll_draft:'))
    ) {
        try {
            await handlePollDraftButton(interaction);
        } catch (error) {
            console.error('❌ 投票草稿處理失敗：', formatError(error));
            await safeReply(interaction, '❌ 投票草稿處理失敗，請稍後再試。', true);
        }
        return;
    }

    if (
        interaction.isButton()
        && (
            interaction.customId.startsWith('approve_batch:')
            || interaction.customId.startsWith('discard_batch:')
            || interaction.customId.startsWith('create_batch_item:')
            || interaction.customId.startsWith('delete_batch_item:')
            || interaction.customId.startsWith('revise_batch_item:')
        )
    ) {
        try {
            await handleBatchDraftButton(interaction);
        } catch (error) {
            console.error('❌ 批次草稿處理失敗：', formatError(error));
            await safeReply(interaction, '❌ 批次草稿處理失敗，請稍後再試。', true);
        }
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('revise_batch_modal:')) {
        try {
            const parsedCustomId = parseBatchItemCustomId(interaction.customId);
            if (!parsedCustomId || !parsedCustomId.itemId) {
                await safeReply(interaction, '批次重生視窗格式錯誤。', true);
                return;
            }

            const revisionPrompt = interaction.fields.getTextInputValue('revision_prompt').trim();
            const categoryOverride = getGuildCategoryName(interaction.guild, interaction.guildId);
            const draft = await reviseSingleQuestionFromBatchDraft(
                parsedCustomId.batchId!,
                interaction.user.id,
                parsedCustomId.itemId!,
                revisionPrompt,
            );

            if (interaction.isFromMessage()) {
                await interaction.update(buildBatchDraftMessage(draft, categoryOverride, parsedCustomId.itemId));
                await interaction.followUp({
                    content: '✅ 這題已依照你的要求重生。',
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                await safeReply(interaction, '✅ 這題已依照你的要求重生。請回到原本的批次草稿訊息查看更新。', true);
            }
        } catch (error) {
            await safeReply(interaction, `❌ ${formatError(error)}`, true);
        }
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('short_modal:qid=')) {
        try {
            const parsedCustomId = parseShortAnswerModalCustomId(interaction.customId);
            if (!parsedCustomId) {
                await safeReply(interaction, '短答提交格式錯誤。', true);
                return;
            }

            if (hasAnswerWindowExpired(parsedCustomId.openedAtMs, parsedCustomId.durationSeconds)) {
                await safeReply(interaction, '⏰ 這題的作答時間已截止。', true);
                return;
            }

            const questionId = parsedCustomId.questionId;
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

            const targetQuestion = await getQuestionById(questionId);
            if (!targetQuestion || (targetQuestion.question_type !== 'short_answer' && targetQuestion.question_type !== 'survey')) {
                await safeReply(interaction, '找不到這個可文字作答的題目。', true);
                return;
            }

            const allowRepeatAnswer = isSurveyRepeatAllowed(targetQuestion);
            const existingResponse = await getExistingResponse(interaction.user.id, questionId);
            if (existingResponse && !(targetQuestion.question_type === 'survey' && allowRepeatAnswer)) {
                await safeReply(interaction, '⛔ 這一題你已經作答過了，每人只能提交一次。', true);
                return;
            }

            const groupId = await resolveGuildGroupId(interaction.guildId, interaction.guild);
            if (groupId) {
                await ensureGroupMember(groupId, interaction.user.id);
            }

            const responsePayload = {
                user_id: interaction.user.id,
                question_id: questionId,
                group_id: groupId,
                selected_option: null,
                is_correct: false,
                reaction_time: calculateReactionTimeSeconds(parsedCustomId.openedAtMs),
                answer_text: answerText,
                status: 'pending',
            };

            await upsertQuizResponse(responsePayload);

            await safeReply(
                interaction,
                targetQuestion.question_type === 'survey'
                    ? '✅ 問卷已提交，感謝你的回覆。'
                    : '✅ 短答已提交。老師之後可以查看你的內容。',
                true,
            );
        } catch (error) {
            console.error('❌ 短答提交失敗：', formatError(error));
            await safeReply(interaction, '❌ 短答提交失敗，請稍後再試。', true);
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const chatInteraction = interaction as ChatInputCommandInteraction;
    let commandAuditStatus: 'success' | 'error' = 'success';
    let commandAuditErrorText: string | null = null;

    try {
        // 處理 /help 指令
        if (chatInteraction.commandName === 'help') {
            const teacher = await isTeacher(chatInteraction);
            const studentCommands = [
                '`/help` - 顯示此訊息',
                '`/image prompt` - 生成圖片',
                '`/link student_id name` - 綁定學號',
                '`/me` - 查詢自己的綁定資料',
                '`/rank limit` - 顯示目前班級伺服器的排行榜',
                '`/poll_create question options [duration_hours] [multi_select]` - 建立原生投票（options 用 | 分隔）',
                '`/ask prompt` - 向助教提問；可做個人診斷、弱點整理、複習建議與一般問答',
                '`/clear_memory` - 清除目前頻道中的 Agent 記憶與未確認題目草稿',
            ];
            const teacherCommands = [
                '`/model [name]` - 查看或切換 Bot 使用模型',
                '`/agent action [prompt]` - 執行工作室任務（摘要/研究）',
                '`/list` - 顯示最近 10 筆題庫',
                '`/question id` - 查看題目詳情',
                '`/add content option_a option_b option_c option_d correct [explanation]` - 老師新增選擇題',
                '`/add_short content rubric` - 老師新增短答題',
                '`/add_survey content [allow_repeat_answer]` - 老師新增問卷題（可設定是否允許重複作答）',
                '`/open id [duration_minutes]` - 老師開放題目',
                '`/check id` - 老師查看答題統計',
                '`/grading_queue` - 老師查看待批改簡答清單',
                '`/grade_link id` - 老師取得指定短答題批改連結',
                '`/batch_generate prompt count` - 老師批次產生 2 到 5 題草稿',
                '`/ask prompt` - 可做班級分析、錯題熱點、學生觀察，也可產生題目或投票草稿',
            ];

            await chatInteraction.reply({
                content: [
                    '✅ **VTA Discord Bot 指令清單**',
                    '',
                    '可用指令：',
                    ...studentCommands,
                    ...(teacher ? teacherCommands : []),
                ].join('\n'),
                ephemeral: false // 設為 true 則只有指令發送者看得到
            });
            return;
        }

        if (chatInteraction.commandName === 'model') {
            if (!(await requireTeacher(chatInteraction))) return;

            const selectedModel = chatInteraction.options.getString('name') as SupportedModel | null;

            if (!selectedModel) {
                const currentModel = process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || '未設定';
                const currentQuestionModel = process.env.QUESTION_MODEL || '未設定';
                const currentLocation = process.env.GCP_LOCATION || '未設定';
                await safeReply(
                    chatInteraction,
                    [
                        '🤖 目前模型設定',
                        `GEMINI_MODEL: ${currentModel}`,
                        `QUESTION_MODEL: ${currentQuestionModel}`,
                        `GCP_LOCATION: ${currentLocation}`,
                        `可選模型: ${SUPPORTED_MODELS.join(' | ')}`,
                    ].join('\n'),
                    true,
                );
                return;
            }

            const nextLocation = DEFAULT_LOCATION_BY_MODEL[selectedModel];
            saveModelConfigToEnv(selectedModel, nextLocation);
            applyModelRuntimeConfig(selectedModel, nextLocation);

            const announcementChannel = findAnnouncementChannel(chatInteraction);
            if (announcementChannel) {
                await announcementChannel.send([
                    '📢 模型已切換',
                    `操作者：<@${chatInteraction.user.id}>`,
                    `目前模型：\`${selectedModel}\``,
                ].join('\n'));
            }

            await safeReply(
                chatInteraction,
                [
                    '✅ 已更新模型設定',
                    `GEMINI_MODEL: ${selectedModel}`,
                    `QUESTION_MODEL: ${selectedModel}`,
                    '設定已寫入 .env，並已套用到目前執行程序。',
                    announcementChannel ? '已同步公告到 #公告 頻道。' : '找不到 #公告 頻道，未發送公告。',
                ].join('\n'),
                true,
            );
            return;
        }

        if (chatInteraction.commandName === 'agent') {
            if (!(await requireTeacher(chatInteraction))) return;

            const action = chatInteraction.options.getString('action', true) as 'summarize_channel' | 'research';
            const prompt = chatInteraction.options.getString('prompt')?.trim();
            const channelSessionId = buildAgentSessionId(chatInteraction.user.id, chatInteraction.channelId);

            await chatInteraction.deferReply({ ephemeral: true });
            const output = await runStudioTask({
                action,
                channelSessionId,
                ...(prompt ? { prompt } : {}),
            });
            await chatInteraction.editReply(output);
            return;
        }

        if (chatInteraction.commandName === 'poll_create') {
            const question = chatInteraction.options.getString('question', true).trim();
            const rawOptions = chatInteraction.options.getString('options', true);
            const durationHours = chatInteraction.options.getInteger('duration_hours') ?? DEFAULT_POLL_DURATION_HOURS;
            const allowMultiselect = chatInteraction.options.getBoolean('multi_select') ?? false;
            const options = parsePollOptions(rawOptions);

            if (question.length === 0) {
                await safeReply(chatInteraction, '投票問題不能空白。', true);
                return;
            }

            if (options.length < 2) {
                await safeReply(chatInteraction, '至少要 2 個選項，請用 `|` 分隔，例如：`西式|中式|不吃早餐`。', true);
                return;
            }

            if (!chatInteraction.channel || !('send' in chatInteraction.channel)) {
                await safeReply(chatInteraction, '無法取得目前頻道，請在伺服器文字頻道中使用 /poll_create。', true);
                return;
            }

            await chatInteraction.channel.send({
                poll: {
                    question: { text: question },
                    answers: options.map((text) => ({ text })),
                    duration: durationHours,
                    allowMultiselect,
                },
            });

            await safeReply(
                chatInteraction,
                [
                    '✅ 已建立投票。',
                    `問題：${question}`,
                    `選項數：${options.length}`,
                    `時長：${durationHours} 小時`,
                    `複選：${allowMultiselect ? '是' : '否'}`,
                ].join('\n'),
                true,
            );
            return;
        }

        if (chatInteraction.commandName === 'image') {
            const prompt = chatInteraction.options.getString('prompt', true).trim();
            if (!prompt) {
                await safeReply(chatInteraction, '請提供圖片描述。', true);
                return;
            }

            await chatInteraction.deferReply({ ephemeral: false });
            const image = await generateImageFromPrompt(prompt);
            const replyText = await buildImageReplyText(prompt);
            const sent = await chatInteraction.editReply({
                content: replyText,
                files: [
                    {
                        attachment: image.bytes,
                        name: `generated-${Date.now()}.png`,
                    },
                ],
            });
            const url = sent.attachments.first()?.url;
            await rememberChannelEvent(
                chatInteraction.channelId,
                chatInteraction.user.id,
                `【圖片生成】使用者請求生成圖片。Prompt: ${prompt}${url ? `\n圖片URL: ${url}` : ''}`,
                'assistant',
            );
            return;
        }

        // 處理 /link 指令
        if (chatInteraction.commandName === 'link') {
            const studentId = chatInteraction.options.getString('student_id', true);
            const name = chatInteraction.options.getString('name', true);
            const user = await linkStudent(chatInteraction.user.id, name, studentId);
            const roleAssignResult = await autoAssignRoleAfterLink(chatInteraction);

            try {
                const sourceChannelName = (
                    chatInteraction.channel
                    && typeof chatInteraction.channel === 'object'
                    && 'name' in chatInteraction.channel
                    && typeof (chatInteraction.channel as { name?: unknown }).name === 'string'
                )
                    ? (chatInteraction.channel as { name: string }).name
                    : null;

                await notifyTeacherLinkSuccess({
                    guild: chatInteraction.guild,
                    sourceChannelName,
                    discordUserId: chatInteraction.user.id,
                    discordTag: chatInteraction.user.tag,
                    studentName: user.display_name ?? name,
                    studentId: user.student_id ?? studentId,
                });
            } catch (error) {
                console.warn('⚠️ 發送老師綁定通知失敗：', formatError(error));
            }

            await safeReply(
                chatInteraction,
                [
                    '✅ 綁定成功！',
                    `姓名：${user.display_name ?? name}`,
                    `學號：${user.student_id ?? studentId}`,
                    ...(roleAssignResult.message ? [roleAssignResult.message] : []),
                ].join('\n'),
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
                `👤 我的資料\n姓名：${user.display_name ?? '未設定'}\n學號：${user.student_id ?? '未設定'}`,
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
                    const questionTypeLabel = question.question_type === 'short_answer'
                        ? '簡答題'
                        : question.question_type === 'survey'
                            ? '問卷題'
                            : '選擇題';
                    return `🆔 ${question.id} [${topic}] [${questionTypeLabel}]\n${truncateContent(question.content)}`;
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
            const optionA = chatInteraction.options.getString('option_a', true);
            const optionB = chatInteraction.options.getString('option_b', true);
            const optionC = chatInteraction.options.getString('option_c', true);
            const optionD = chatInteraction.options.getString('option_d', true);
            const correct = chatInteraction.options.getString('correct', true).toUpperCase() as 'A' | 'B' | 'C' | 'D';
            const explanation = chatInteraction.options.getString('explanation') ?? '';

            const question = await createMultipleChoiceQuestion({
                content,
                category: getGuildCategoryName(chatInteraction.guild, chatInteraction.guildId),
                options: [optionA, optionB, optionC, optionD],
                correctAnswer: correct,
                explanation,
            });

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
                category: getGuildCategoryName(chatInteraction.guild, chatInteraction.guildId),
            });

            await safeReply(
                chatInteraction,
                `✅ 短答題新增成功！\nID：${question.id}\n題目：${question.content ?? content}`,
                true,
            );
            return;
        }

        if (chatInteraction.commandName === 'add_survey') {
            if (!(await requireTeacher(chatInteraction))) return;

            const content = chatInteraction.options.getString('content', true);
            const allowRepeatAnswer = chatInteraction.options.getBoolean('allow_repeat_answer') ?? false;
            const question = await createSurveyQuestion({
                content,
                category: getGuildCategoryName(chatInteraction.guild, chatInteraction.guildId),
                allowRepeatAnswer,
            });

            await safeReply(
                chatInteraction,
                `✅ 問卷題新增成功！\nID：${question.id}\n題目：${question.content ?? content}\n重複作答：${allowRepeatAnswer ? '允許' : '不允許'}`,
                true,
            );
            return;
        }

        // 處理 /open 指令
        if (chatInteraction.commandName === 'open') {
            if (!(await requireTeacher(chatInteraction))) return;

            await chatInteraction.deferReply({ flags: MessageFlags.Ephemeral });

            const id = chatInteraction.options.getInteger('id', true);
            const durationMinutes = chatInteraction.options.getInteger('duration_minutes') ?? DEFAULT_OPEN_DURATION_MINUTES;
            const durationSeconds = durationMinutes * 60;
            const openedAtMs = Date.now();
            const closeAtMs = openedAtMs + (durationSeconds * 1000);
            const question = await getQuestionById(id);

            if (!question) {
                await safeReply(chatInteraction, '找不到這個題目', true);
                return;
            }

            if (!chatInteraction.channel || !('send' in chatInteraction.channel)) {
                await safeReply(chatInteraction, '無法取得目前頻道，請在伺服器文字頻道中使用 /open。', true);
                return;
            }

            const groupId = await resolveGuildGroupId(chatInteraction.guildId, chatInteraction.guild);
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
                        closeAtMs,
                    ))
                    .setFooter({ text: '每人只能作答一次，逾時後系統將拒絕作答。' })
                    .setTimestamp(new Date());

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(buildAnswerCustomId(question.id, 'A', openedAtMs, durationSeconds))
                        .setLabel('A')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(buildAnswerCustomId(question.id, 'B', openedAtMs, durationSeconds))
                        .setLabel('B')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(buildAnswerCustomId(question.id, 'C', openedAtMs, durationSeconds))
                        .setLabel('C')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(buildAnswerCustomId(question.id, 'D', openedAtMs, durationSeconds))
                        .setLabel('D')
                        .setStyle(ButtonStyle.Primary),
                );

                await chatInteraction.channel.send({
                    embeds: [embed],
                    components: [row],
                });
            } else if (question.question_type === 'short_answer' || question.question_type === 'survey') {
                const embed = new EmbedBuilder()
                    .setColor(0x16a34a)
                    .setTitle(`第 ${question.id} 題`)
                    .setDescription(question.content ?? '（無題目內容）')
                    .addFields(buildShortAnswerOpenFields(closeAtMs))
                    .setFooter({ text: '每人只能作答一次，逾時後系統將拒絕作答。' })
                    .setTimestamp(new Date());

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(buildShortAnswerButtonCustomId(question.id, openedAtMs, durationSeconds))
                        .setLabel(question.question_type === 'survey' ? '提交問卷' : '提交短答')
                        .setStyle(ButtonStyle.Success),
                );

                await chatInteraction.channel.send({
                    embeds: [embed],
                    components: [row],
                });
            } else {
                await safeReply(chatInteraction, '目前 /open 只支援選擇題、短答題與問卷題', true);
                return;
            }

            await safeReply(chatInteraction, `✅ 已開放第 ${question.id} 題，作答時間 ${durationMinutes} 分鐘。`, true);
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
            await safeReply(chatInteraction, await formatRankResult(chatInteraction.guildId, chatInteraction.guild, limit), false);
            return;
        }

        if (chatInteraction.commandName === 'clear_memory') {
            const sessionId = buildAgentSessionId(chatInteraction.user.id, chatInteraction.channelId);
            await clearAgentMessages(sessionId);
            await clearRevisionTarget(sessionId);
            await clearDraftsByUser(chatInteraction.user.id);
            await clearBatchDraftsByUser(chatInteraction.user.id);
            pendingShortAnswerDrafts.delete(buildShortDraftSessionKey(chatInteraction.user.id, chatInteraction.channelId));
            pendingPollDrafts.delete(buildShortDraftSessionKey(chatInteraction.user.id, chatInteraction.channelId));
            await safeReply(chatInteraction, '✅ 已清除目前頻道的共享 Agent 記憶，以及你個人的未確認題目草稿。', true);
            return;
        }

        if (chatInteraction.commandName === 'batch_generate') {
            if (!(await requireTeacher(chatInteraction))) return;

            const prompt = chatInteraction.options.getString('prompt', true).trim();
            const count = chatInteraction.options.getInteger('count', true);
            const categoryOverride = getGuildCategoryName(chatInteraction.guild, chatInteraction.guildId);

            await chatInteraction.deferReply({ ephemeral: true });
            const batchDraft = await generateQuestionBatchDraft(chatInteraction.user.id, prompt, count);
            await chatInteraction.followUp({
                ...buildBatchDraftMessage(batchDraft, categoryOverride),
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

            const sessionId = buildAgentSessionId(chatInteraction.user.id, chatInteraction.channelId);
            const shortDraftSessionKey = buildShortDraftSessionKey(chatInteraction.user.id, chatInteraction.channelId);
            const pendingShortDraft = pendingShortAnswerDrafts.get(shortDraftSessionKey);
            const pendingPollDraft = pendingPollDrafts.get(shortDraftSessionKey);
            const effectivePrompt = pendingShortDraft && isShortDraftRevisionPrompt(prompt)
                ? [
                    '你正在修改同一份簡答題草稿，請直接輸出「更新後草稿」，不要要求老師重貼原題。',
                    `目前草稿分類：${pendingShortDraft.category}`,
                    `目前草稿題目：${pendingShortDraft.content}`,
                    `目前草稿 rubric：${pendingShortDraft.rubric}`,
                    `老師本次修改要求：${prompt}`,
                ].join('\n')
                : pendingPollDraft && isPollDraftRevisionPrompt(prompt)
                    ? [
                        '你正在修改同一份投票草稿，請直接輸出「更新後投票草稿」。',
                        `目前投票問題：${pendingPollDraft.question}`,
                        `目前投票選項：${pendingPollDraft.options.join(' | ')}`,
                        `目前時長（小時）：${pendingPollDraft.durationHours}`,
                        `目前允許複選：${pendingPollDraft.allowMultiselect ? '是' : '否'}`,
                        `老師本次修改要求：${prompt}`,
                    ].join('\n')
                    : prompt;

            await chatInteraction.deferReply({ ephemeral: true });
            const result = await askAgent({
                userId: chatInteraction.user.id,
                question: effectivePrompt,
                sessionId,
                isTeacher: await isTeacher(chatInteraction),
                channelId: chatInteraction.guildId ?? chatInteraction.channelId,
            });

            if (result.shortAnswerDraftPreview) {
                if (!hasValidShortAnswerDraftPreview(result.shortAnswerDraftPreview)) {
                    await safeReply(chatInteraction, '❌ 簡答題草稿格式不完整，這次不會建立。請重新描述需求再試一次。', true);
                    return;
                }

                const autoCreateDraft = (process.env.ASK_AUTO_CREATE_ON_DRAFT ?? 'false').toLowerCase() === 'true';
                if (autoCreateDraft) {
                    const question = await createShortAnswerQuestion({
                        content: result.shortAnswerDraftPreview.content,
                        rubric: result.shortAnswerDraftPreview.rubric,
                        category: getGuildCategoryName(chatInteraction.guild, chatInteraction.guildId),
                    });

                    await safeReply(
                        chatInteraction,
                        [
                            '✅ 簡答題已建立',
                            `ID：${question.id}`,
                            `題目：${question.content ?? '（無題目內容）'}`,
                            `可用指令：/open id:${question.id}`,
                        ].join('\n'),
                        true,
                    );
                    return;
                }

                await safeReply(
                    chatInteraction,
                    [
                        '已產生簡答題草稿，請先確認老師意見後再建立：',
                        `分類：${getGuildCategoryName(chatInteraction.guild, chatInteraction.guildId)}`,
                        `題目：${result.shortAnswerDraftPreview.content}`,
                        `評分規準（草稿）：${result.shortAnswerDraftPreview.rubric}`,
                        '請確認 rubric 是否要修改；若要改，請再用 /ask 補充你要的評分重點。',
                    ].join('\n'),
                    true,
                );
                const sessionKey = buildShortDraftSessionKey(chatInteraction.user.id, chatInteraction.channelId);
                pendingShortAnswerDrafts.set(sessionKey, {
                    category: result.shortAnswerDraftPreview.category,
                    content: result.shortAnswerDraftPreview.content,
                    rubric: result.shortAnswerDraftPreview.rubric,
                });
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`approve_short_draft:${chatInteraction.user.id}`)
                        .setLabel('同意建立')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`revise_short_draft:${chatInteraction.user.id}`)
                        .setLabel('我要修改')
                        .setStyle(ButtonStyle.Secondary),
                );
                await chatInteraction.followUp({
                    content: '請選擇下一步：',
                    components: [row],
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (result.pollDraftPreview) {
                const poll = result.pollDraftPreview;
                if (poll.question.trim().length === 0 || poll.options.length < 2) {
                    await safeReply(chatInteraction, '❌ 投票草稿格式不完整，請重新描述需求再試一次。', true);
                    return;
                }

                pendingPollDrafts.set(shortDraftSessionKey, {
                    question: poll.question,
                    options: poll.options,
                    durationHours: poll.durationHours,
                    allowMultiselect: poll.allowMultiselect,
                });

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`approve_poll_draft:${chatInteraction.user.id}`)
                        .setLabel('同意建立')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`revise_poll_draft:${chatInteraction.user.id}`)
                        .setLabel('我要修改')
                        .setStyle(ButtonStyle.Secondary),
                );

                await safeReply(
                    chatInteraction,
                    [
                        '已產生投票草稿，請先確認後再建立：',
                        `問題：${poll.question}`,
                        `選項：${poll.options.join('｜')}`,
                        `時長：${poll.durationHours} 小時`,
                        `複選：${poll.allowMultiselect ? '是' : '否'}`,
                        '若要改內容，按「我要修改」後再用 /ask 補充。',
                    ].join('\n'),
                    true,
                );
                await chatInteraction.followUp({
                    content: '請選擇下一步：',
                    components: [row],
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (result.draftPreview) {
                if (!hasValidDraftPreview(result.draftPreview)) {
                    await safeReply(chatInteraction, '❌ 題目草稿格式不完整，這次不會建立。請重新描述需求再試一次。', true);
                    return;
                }

                const autoCreateDraft = (process.env.ASK_AUTO_CREATE_ON_DRAFT ?? 'false').toLowerCase() === 'true';
                if (autoCreateDraft) {
                    const question = await approveQuestionDraft(
                        result.draftPreview.draftId,
                        chatInteraction.user.id,
                        getGuildCategoryName(chatInteraction.guild, chatInteraction.guildId),
                    );
                    await clearRevisionTarget(buildAgentSessionId(chatInteraction.user.id, chatInteraction.channelId));
                    await safeReply(
                        chatInteraction,
                        [
                            '✅ 題目已建立',
                            `ID：${question.id}`,
                            `題目：${question.content ?? '（無題目內容）'}`,
                            `可用指令：/open id:${question.id}`,
                        ].join('\n'),
                        true,
                    );
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
                    content: `${result.answer}\n\n${getDraftPreviewText(
                        result.draftPreview,
                        getGuildCategoryName(chatInteraction.guild, chatInteraction.guildId),
                    )}\n\n請先確認後再建立題目。`,
                    components: [row],
                    ephemeral: true,
                });
                return;
            }

            await safeReply(chatInteraction, result.answer, true);
            return;
        }
    } catch (error) {
        commandAuditStatus = 'error';
        commandAuditErrorText = formatError(error);
        console.error('❌ 指令處理失敗：', formatError(error));

        const failureMessage = chatInteraction.commandName === 'link'
            ? '❌ 綁定失敗，請稍後再試。'
            : chatInteraction.commandName === 'add'
                ? '❌ 題目新增失敗，請稍後再試。'
                : chatInteraction.commandName === 'ask'
                    ? '❌ Agent 暫時無法回覆，請稍後再試。'
                : '❌ 指令執行失敗，請稍後再試。';

        await safeReply(chatInteraction, failureMessage, true);
    } finally {
        try {
            await notifyCommandUsage({
                interaction: chatInteraction,
                status: commandAuditStatus,
                errorText: commandAuditErrorText,
            });
        } catch (error) {
            console.warn('⚠️ 指令紀錄發送失敗：', formatError(error));
        }
    }
});

client.on('messageCreate', async (message) => {
    if (!client.user) return;
    if (message.author.bot) return;
    if (!message.guild) return;
    const botUserId = client.user.id;

    if (message.attachments.size > 0) {
        const imageAttachments = [...message.attachments.values()].filter((item) => item.contentType?.startsWith('image/'));
        if (imageAttachments.length > 0) {
            const attachmentLines = imageAttachments
                .slice(0, 4)
                .map((item, index) => `${index + 1}. ${item.name ?? 'unnamed'} (${item.url})`);
            await rememberChannelEvent(
                message.channelId,
                message.author.id,
                [
                    `【圖片上傳】${message.author.username} 在頻道上傳了圖片。`,
                    ...(message.content.trim().length > 0 ? [`訊息文字: ${message.content.trim()}`] : []),
                    '圖片清單:',
                    ...attachmentLines,
                ].join('\n'),
                'user',
            );
        }
    }

    const isMentioned = message.mentions.users.has(botUserId);
    const isReplyToBot = Boolean(message.reference?.messageId)
        && message.reference?.type === 0
        && (await (async () => {
            try {
                const referenced = await message.fetchReference();
                return referenced.author.id === botUserId;
            } catch {
                return false;
            }
        })());

    if (!isMentioned && !isReplyToBot) return;

    const mentionPattern = new RegExp(`<@!?${botUserId}>`, 'g');
    const prompt = message.content.replace(mentionPattern, '').trim();
    if (!prompt) {
        await message.reply('請輸入要詢問的內容。');
        return;
    }

    const thinkingReaction = await addThinkingReaction(message);

    try {
        if (looksLikeImagePrompt(prompt)) {
            try {
                const image = await generateImageFromPrompt(prompt);
                const replyText = await buildImageReplyText(prompt);
                const sent = await message.reply({
                    content: replyText,
                    files: [
                        {
                            attachment: image.bytes,
                            name: `generated-${Date.now()}.png`,
                        },
                    ],
                });
                const url = sent.attachments.first()?.url;
                await rememberChannelEvent(
                    message.channelId,
                    message.author.id,
                    `【圖片生成】使用者透過視覺描述觸發生成圖片。Prompt: ${prompt}${url ? `\n圖片URL: ${url}` : ''}`,
                    'assistant',
                );
            } catch (error) {
                console.error('❌ @機器人圖片生成失敗：', formatError(error));
                await message.reply('❌ 目前無法生成圖片，請稍後再試。');
            }
            return;
        }

        let detectedIntent: MentionIntentResult = { intent: 'chat', prompt };
        try {
            detectedIntent = await detectMentionIntent(prompt);
        } catch (error) {
            console.warn('⚠️ @機器人意圖判斷失敗，改用關鍵字備援：', formatError(error));
            const fallbackMatch = /^(畫圖|畫|生成圖片|產生圖片|image)\s*(?:[:：]\s*|\s+)(.+)$/i.exec(prompt);
            if (fallbackMatch) {
                detectedIntent = { intent: 'image', prompt: (fallbackMatch[2] ?? '').trim() };
            }
        }

        if (detectedIntent.intent === 'image') {
            const imagePrompt = detectedIntent.prompt.trim();
            if (!imagePrompt) {
                await message.reply('請在 `畫圖:` 後輸入描述，例如：`@VTA 畫圖: 一隻戴眼鏡的柴犬`');
                return;
            }
            try {
                const image = await generateImageFromPrompt(imagePrompt);
                const replyText = await buildImageReplyText(imagePrompt);
                const sent = await message.reply({
                    content: replyText,
                    files: [
                        {
                            attachment: image.bytes,
                            name: `generated-${Date.now()}.png`,
                        },
                    ],
                });
                const url = sent.attachments.first()?.url;
                await rememberChannelEvent(
                    message.channelId,
                    message.author.id,
                    `【圖片生成】使用者透過@機器人請求生成圖片。Prompt: ${imagePrompt}${url ? `\n圖片URL: ${url}` : ''}`,
                    'assistant',
                );
            } catch (error) {
                console.error('❌ @機器人圖片生成失敗：', formatError(error));
                await message.reply('❌ 目前無法生成圖片，請稍後再試。');
            }
            return;
        }

        try {
            const sessionId = buildAgentSessionId(message.author.id, message.channelId);
            const liveChannelContext = await buildLiveChannelContext(message);
            const result = await askAgent({
                userId: message.author.id,
                question: prompt,
                sessionId,
                isTeacher: false,
                channelId: message.guildId ?? message.channelId,
                chatMode: true,
                liveChannelContext,
            });

            let responseText = result.answer;
            if (result.draftPreview) {
                responseText += '\n\n（已產生題目草稿，請使用 `/ask` 觸發按鈕確認建立。）';
            } else if (result.shortAnswerDraftPreview) {
                responseText += '\n\n（已產生簡答題草稿，請使用 `/ask` 進行確認建立。）';
            } else if (result.pollDraftPreview) {
                responseText += '\n\n（已產生投票草稿，請使用 `/ask` 進行確認建立。）';
            }

            await message.reply(responseText);
        } catch (error) {
            console.error('❌ @機器人對話失敗：', formatError(error));
            await message.reply('❌ 目前無法回覆，請稍後再試。');
        }
    } finally {
        await clearThinkingReaction(thinkingReaction);
    }
});

const renderPort = Number(process.env.PORT || 3000);
const healthServer = http.createServer((req, res) => {
    const requestPath = req.url ?? '/';

    if (requestPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dc-vta-bot is running');
});

healthServer.listen(renderPort, () => {
    console.log(`🌐 Health server listening on port ${renderPort}`);
});

// 啟動機器人
client.login(token);
