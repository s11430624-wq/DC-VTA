import { supabase } from './supabase';

export type ChatMessage = {
    session_id: string;
    user_id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at?: string;
};

export const CONTEXT_SUMMARY_PREFIX = '[CONTEXT_SUMMARY]';
const CHAT_TABLE = 'chat_messages';
const LEGACY_TABLE = 'n8n_chat_histories';

const isMissingChatTable = (error: { message?: string; code?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST205' || message.includes(CHAT_TABLE) || message.includes('relation');
};

type LegacyChatRow = {
    id?: number;
    session_id: string;
    message: {
        role?: unknown;
        content?: unknown;
        user_id?: unknown;
        created_at?: unknown;
    } | null;
};

const fromLegacyRow = (row: LegacyChatRow): ChatMessage | null => {
    const content = typeof row.message?.content === 'string' ? row.message.content : '';
    if (!content) return null;

    return {
        session_id: row.session_id,
        user_id: typeof row.message?.user_id === 'string' ? row.message.user_id : '',
        role: row.message?.role === 'assistant' ? 'assistant' : 'user',
        content,
        ...(typeof row.message?.created_at === 'string' ? { created_at: row.message.created_at } : {}),
    };
};

const toLegacyPayload = (message: ChatMessage) => ({
    session_id: message.session_id,
    message: {
        role: message.role,
        content: message.content,
        user_id: message.user_id,
        ...(message.created_at ? { created_at: message.created_at } : {}),
    },
});

export async function getRecentChatMessages(sessionId: string, limit = 8): Promise<ChatMessage[]> {
    const { data, error } = await supabase
        .from(CHAT_TABLE)
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        if (isMissingChatTable(error)) {
            const legacyResult = await supabase
                .from(LEGACY_TABLE)
                .select('id, session_id, message')
                .eq('session_id', sessionId)
                .order('id', { ascending: false })
                .limit(limit);

            if (legacyResult.error) {
                throw new Error(`查詢舊對話紀錄失敗：${legacyResult.error.message}`);
            }

            return ((legacyResult.data ?? []) as LegacyChatRow[])
                .slice()
                .reverse()
                .map(fromLegacyRow)
                .filter((message): message is ChatMessage => message !== null);
        }
        throw new Error(`查詢對話紀錄失敗：${error.message}`);
    }

    return ((data ?? []) as ChatMessage[]).reverse();
}

export async function appendChatMessage(message: ChatMessage): Promise<void> {
    const { error } = await supabase.from(CHAT_TABLE).insert(message);
    if (!error) return;

    if (isMissingChatTable(error)) {
        const legacyResult = await supabase
            .from(LEGACY_TABLE)
            .insert(toLegacyPayload(message));

        if (legacyResult.error) {
            throw new Error(`儲存舊對話紀錄失敗：${legacyResult.error.message}`);
        }
        return;
    }

    if (error) {
        throw new Error(`儲存對話紀錄失敗：${error.message}`);
    }
}

export async function getLatestContextSummary(sessionId: string): Promise<ChatMessage | null> {
    const { data, error } = await supabase
        .from(CHAT_TABLE)
        .select('*')
        .eq('session_id', sessionId)
        .eq('role', 'assistant')
        .like('content', `${CONTEXT_SUMMARY_PREFIX}%`)
        .order('created_at', { ascending: false })
        .limit(1);

    if (error) {
        if (isMissingChatTable(error)) {
            const legacyResult = await supabase
                .from(LEGACY_TABLE)
                .select('id, session_id, message')
                .eq('session_id', sessionId)
                .order('id', { ascending: false })
                .limit(30);

            if (legacyResult.error) {
                throw new Error(`查詢舊上下文摘要失敗：${legacyResult.error.message}`);
            }

            return ((legacyResult.data ?? []) as LegacyChatRow[])
                .map(fromLegacyRow)
                .find((message) => message?.role === 'assistant' && message.content.startsWith(CONTEXT_SUMMARY_PREFIX)) ?? null;
        }
        throw new Error(`查詢上下文摘要失敗：${error.message}`);
    }

    return ((data ?? []) as ChatMessage[])[0] ?? null;
}

export async function appendContextSummary(sessionId: string, userId: string, summary: string): Promise<void> {
    await appendChatMessage({
        session_id: sessionId,
        user_id: userId,
        role: 'assistant',
        content: `${CONTEXT_SUMMARY_PREFIX}\n${summary.trim()}`,
    });
}

export async function clearChatMessages(sessionId: string): Promise<void> {
    const { error } = await supabase
        .from(CHAT_TABLE)
        .delete()
        .eq('session_id', sessionId);

    if (error && !isMissingChatTable(error)) {
        throw new Error(`清除聊天記憶失敗：${error.message}`);
    }

    const legacyResult = await supabase
        .from(LEGACY_TABLE)
        .delete()
        .eq('session_id', sessionId);

    if (legacyResult.error) {
        throw new Error(`清除舊聊天記憶失敗：${legacyResult.error.message}`);
    }
}

export const __chatMemoryServiceForTests = {
    fromLegacyRow,
    toLegacyPayload,
};
