import { supabase } from './supabase';

export type ChatMessage = {
    session_id: string;
    user_id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at?: string;
};

const isMissingChatTable = (error: { message?: string; code?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST205' || message.includes('chat_messages');
};

export async function getRecentChatMessages(sessionId: string, limit = 8): Promise<ChatMessage[]> {
    const { data, error } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        if (isMissingChatTable(error)) return [];
        throw new Error(`查詢對話紀錄失敗：${error.message}`);
    }

    return ((data ?? []) as ChatMessage[]).reverse();
}

export async function appendChatMessage(message: ChatMessage): Promise<void> {
    const { error } = await supabase.from('chat_messages').insert(message);
    if (error && !isMissingChatTable(error)) {
        throw new Error(`儲存對話紀錄失敗：${error.message}`);
    }
}

