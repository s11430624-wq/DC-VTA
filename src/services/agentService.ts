import { getRecentChatMessages } from './chatMemoryService';
import { getQuestionById, getRecentQuestions } from './questionService';
import { getUserByDiscordId } from './userService';
import { getAllQuizResponses } from './quizService';

type AskAgentInput = {
    userId: string;
    question: string;
    sessionId: string;
};

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const summarizeRanking = async (limit = 5) => {
    const responses = await getAllQuizResponses();
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

    return ranked;
};

const runReadOnlyTools = async (userId: string, question: string) => {
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
        const rank = await summarizeRanking(5);
        outputs.push(
            `排行榜: ${
                rank.map((row, index) => `${index + 1}.${row.userId}(${row.correct}/${row.total},${row.accuracy}%)`).join(' | ') || '無資料'
            }`,
        );
    }

    return outputs;
};

export async function askAgent(input: AskAgentInput): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('缺少 GEMINI_API_KEY');
    }

    const memory = await getRecentChatMessages(input.sessionId, 8);
    const toolOutputs = await runReadOnlyTools(input.userId, input.question);
    const memoryText = memory.map((m) => `${m.role === 'user' ? '使用者' : '助教'}: ${m.content}`).join('\n');

    const prompt = [
        '你是課堂測驗 Discord 助教。',
        '規則: 不可捏造資料。查不到就明說。不要輸出任何金鑰或敏感資訊。',
        '如果工具資訊有提供，優先使用工具資訊回答。',
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
        return '我目前沒有足夠資料回答，請換個問法或指定題號。';
    }

    return answer;
}

