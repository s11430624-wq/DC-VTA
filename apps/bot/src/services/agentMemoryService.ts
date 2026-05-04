import { supabase } from './supabase';

type AgentRole = 'user' | 'assistant';

export type AgentMemoryMessage = {
    role: AgentRole;
    content: string;
};

type AgentMessageRow = {
    session_id: string;
    user_id: string;
    role: AgentRole;
    content: string;
    created_at?: string;
};

const AGENT_TABLE = 'agent_messages';
const LEGACY_TABLE = 'n8n_chat_histories';

const isMissingTableError = (error: { code?: string; message?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST205' || message.includes('agent_messages') || message.includes('relation');
};

export async function getRecentAgentMessages(
    sessionId: string,
    limit = 12,
): Promise<AgentMemoryMessage[]> {
    const { data, error } = await supabase
        .from(AGENT_TABLE)
        .select('role, content, created_at')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (!error) {
        return ((data ?? []) as AgentMessageRow[])
            .slice()
            .reverse()
            .map((message) => ({
                role: message.role,
                content: message.content,
            }));
    }

    if (!isMissingTableError(error)) {
        throw new Error(`讀取 Agent 記憶失敗：${error.message}`);
    }

    const legacyResult = await supabase
        .from(LEGACY_TABLE)
        .select('message, id')
        .eq('session_id', sessionId)
        .order('id', { ascending: false })
        .limit(limit);

    if (legacyResult.error) {
        throw new Error(`讀取舊記憶表失敗：${legacyResult.error.message}`);
    }

    return (legacyResult.data ?? [])
        .slice()
        .reverse()
        .map<AgentMemoryMessage>((row) => {
            const payload = row.message as { role?: unknown; content?: unknown } | null;
            return {
                role: payload?.role === 'assistant' ? 'assistant' : 'user',
                content: typeof payload?.content === 'string' ? payload.content : '',
            };
        })
        .filter((message) => message.content.length > 0);
}

export async function saveAgentMessage(
    sessionId: string,
    userId: string,
    role: AgentRole,
    content: string,
): Promise<void> {
    const payload = {
        session_id: sessionId,
        user_id: userId,
        role,
        content,
    };

    const result = await supabase
        .from(AGENT_TABLE)
        .insert(payload);

    if (!result.error) {
        return;
    }

    if (!isMissingTableError(result.error)) {
        throw new Error(`寫入 Agent 記憶失敗：${result.error.message}`);
    }

    const legacyResult = await supabase
        .from(LEGACY_TABLE)
        .insert({
            session_id: sessionId,
            message: {
                role,
                content,
                user_id: userId,
            },
        });

    if (legacyResult.error) {
        throw new Error(`寫入舊記憶表失敗：${legacyResult.error.message}`);
    }
}

export async function clearAgentMessages(sessionId: string): Promise<void> {
    const result = await supabase
        .from(AGENT_TABLE)
        .delete()
        .eq('session_id', sessionId);

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`清除 Agent 記憶失敗：${result.error.message}`);
    }

    const legacyResult = await supabase
        .from(LEGACY_TABLE)
        .delete()
        .eq('session_id', sessionId);

    if (legacyResult.error) {
        throw new Error(`清除舊記憶表失敗：${legacyResult.error.message}`);
    }
}
