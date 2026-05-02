import { ApplicationCommandOptionType, ChatInputCommandInteraction, Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import { getQuestionById, getRecentQuestions } from './services/questionService';
import { getUserByDiscordId, linkStudent } from './services/userService';
import { formatError, safeReply } from './utils/errorHandler';

// 載入環境變數
dotenv.config();

const requiredEnvVars = [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
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
];

const getQuestionTopic = (metadata: Record<string, unknown> | null, category: string | null) => {
    const topic = metadata?.topic;
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

const getStringMetadata = (metadata: Record<string, unknown> | null, key: string) => {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

const getOptionsText = (metadata: Record<string, unknown> | null) => {
    const rawOptions = metadata?.options;

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

type QuestionDetail = Awaited<ReturnType<typeof getQuestionById>>;

const formatQuestionDetail = (question: QuestionDetail) => {
    if (!question) return '找不到這個題目';

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
            `🔑 答案：${getStringMetadata(question.metadata, 'correct_answer') ?? '無'}`,
            `💡 解析：${getStringMetadata(question.metadata, 'explanation') ?? '無'}`,
            '',
        );
    }

    if (questionType === 'short_answer') {
        lines.push(
            `🧾 評分規準：${getStringMetadata(question.metadata, 'rubric') ?? '無'}`,
            '',
        );
    }

    lines.push(`Vector：${hasEmbedding(question.embedding) ? '✅ 已生成' : '⬜ NULL'}`);

    return lines.join('\n');
};

// 當機器人準備就緒時觸發
client.once('ready', async () => {
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
    // 確保這是一個 Slash Command
    if (!interaction.isChatInputCommand()) return;

    const chatInteraction = interaction as ChatInputCommandInteraction;

    try {
        // 處理 /help 指令
        if (chatInteraction.commandName === 'help') {
            await chatInteraction.reply({
                content: '✅ **VTA Discord Bot 已成功切換為 Node.js 程式碼模式！**\n\n可用指令：\n`/help` - 顯示此訊息\n`/link student_id name` - 綁定學號\n`/me` - 查詢自己的綁定資料\n`/list` - 顯示最近 10 筆題庫\n`/question id` - 查看題目詳情',
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
            const id = chatInteraction.options.getInteger('id', true);
            const question = await getQuestionById(id);

            await safeReply(
                chatInteraction,
                formatQuestionDetail(question),
                true,
            );
        }
    } catch (error) {
        console.error('❌ 指令處理失敗：', formatError(error));

        const failureMessage = chatInteraction.commandName === 'link'
            ? '❌ 綁定失敗，請稍後再試。'
            : '❌ 指令執行失敗，請稍後再試。';

        await safeReply(chatInteraction, failureMessage, true);
    }
});

// 啟動機器人
client.login(token);
