import { supabase } from './supabase';

type GroupRecord = {
    id?: number;
    group_id: string;
    group_name?: string | null;
    is_active?: boolean | null;
    last_active_at?: string | null;
    current_question_id: number | null;
    game_mode?: string | null;
};

const isMissingGroupTablesError = (error: { code?: string; message?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST205' || message.includes('groups') || message.includes('group_members') || message.includes('relation');
};

const DISCORD_CHANNEL_ID_PATTERN = /^\d{16,20}$/;

const sanitizeGroupName = (groupName: string | null | undefined, channelId: string) => {
    const trimmed = groupName?.trim();
    if (!trimmed) {
        return `discord-${channelId}`;
    }

    return trimmed.slice(0, 120);
};

export function isDiscordChannelGroupId(groupId: string): boolean {
    return DISCORD_CHANNEL_ID_PATTERN.test(groupId);
}

export async function getGroupById(groupId: string): Promise<GroupRecord | null> {
    const result = await supabase
        .from('groups')
        .select('id, group_id, group_name, is_active, last_active_at, current_question_id, game_mode')
        .eq('group_id', groupId)
        .maybeSingle();

    if (result.error) {
        if (isMissingGroupTablesError(result.error)) {
            return null;
        }

        throw new Error(`查詢群組失敗：${result.error.message}`);
    }

    return result.data as GroupRecord | null;
}

export async function ensureDiscordChannelGroup(channelId: string, groupName?: string | null): Promise<GroupRecord | null> {
    if (!isDiscordChannelGroupId(channelId)) {
        return null;
    }

    const existingGroup = await getGroupById(channelId);
    const now = new Date().toISOString();
    const sanitizedGroupName = sanitizeGroupName(groupName, channelId);

    if (existingGroup) {
        const needsUpdate = existingGroup.group_name !== sanitizedGroupName || existingGroup.is_active !== true;
        const result = await supabase
            .from('groups')
            .update({
                ...(needsUpdate ? { group_name: sanitizedGroupName, is_active: true } : {}),
                last_active_at: now,
            })
            .eq('group_id', channelId)
            .select('id, group_id, group_name, is_active, last_active_at, current_question_id, game_mode')
            .maybeSingle();

        if (result.error) {
            if (isMissingGroupTablesError(result.error)) {
                return null;
            }

            throw new Error(`更新 Discord 群組失敗：${result.error.message}`);
        }

        return (result.data ?? existingGroup) as GroupRecord;
    }

    const result = await supabase
        .from('groups')
        .insert({
            group_id: channelId,
            group_name: sanitizedGroupName,
            is_active: true,
            last_active_at: now,
            current_question_id: null,
            game_mode: 'normal',
        })
        .select('id, group_id, group_name, is_active, last_active_at, current_question_id, game_mode')
        .maybeSingle();

    if (result.error) {
        if (isMissingGroupTablesError(result.error)) {
            return null;
        }

        throw new Error(`建立 Discord 群組失敗：${result.error.message}`);
    }

    return result.data as GroupRecord | null;
}

export async function setCurrentQuestionForGroup(groupId: string, questionId: number): Promise<void> {
    const group = await getGroupById(groupId);
    if (!group) {
        return;
    }

    const result = await supabase
        .from('groups')
        .update({ current_question_id: questionId })
        .eq('group_id', groupId);

    if (result.error) {
        throw new Error(`更新群組目前題目失敗：${result.error.message}`);
    }
}

export async function ensureGroupMember(groupId: string, userId: string): Promise<void> {
    const group = await getGroupById(groupId);
    if (!group) {
        return;
    }

    const existing = await supabase
        .from('group_members')
        .select('id')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .limit(1);

    if (existing.error) {
        if (isMissingGroupTablesError(existing.error)) {
            return;
        }

        throw new Error(`查詢群組成員失敗：${existing.error.message}`);
    }

    if ((existing.data?.length ?? 0) > 0) {
        return;
    }

    const result = await supabase
        .from('group_members')
        .insert({
            group_id: groupId,
            user_id: userId,
        });

    if (result.error && !isMissingGroupTablesError(result.error)) {
        throw new Error(`寫入群組成員失敗：${result.error.message}`);
    }
}
