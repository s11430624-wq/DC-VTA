import { supabase } from './supabase';

export type GuildSettingsRecord = {
    guild_id: string;
    guild_name: string | null;
    teacher_role_id: string | null;
    teacher_log_channel_id: string | null;
};

const isMissingGuildSettingsTable = (error: { code?: string; message?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST205' || message.includes('guild_settings') || message.includes('relation');
};

const normalizeOptionalId = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
};

export async function getGuildSettings(guildId: string): Promise<GuildSettingsRecord | null> {
    const result = await supabase
        .from('guild_settings')
        .select('guild_id, guild_name, teacher_role_id, teacher_log_channel_id')
        .eq('guild_id', guildId)
        .maybeSingle();

    if (result.error) {
        if (isMissingGuildSettingsTable(result.error)) {
            return null;
        }

        throw new Error(`讀取 guild_settings 失敗：${result.error.message}`);
    }

    return result.data as GuildSettingsRecord | null;
}

export async function upsertGuildSettingsFromRuntime(input: {
    guildId: string;
    guildName: string | null;
    teacherRoleId?: string | null;
    teacherLogChannelId?: string | null;
}): Promise<void> {
    const existing = await getGuildSettings(input.guildId);
    const payload = {
        guild_id: input.guildId,
        guild_name: input.guildName,
        teacher_role_id: input.teacherRoleId === undefined
            ? existing?.teacher_role_id ?? null
            : normalizeOptionalId(input.teacherRoleId),
        teacher_log_channel_id: input.teacherLogChannelId === undefined
            ? existing?.teacher_log_channel_id ?? null
            : normalizeOptionalId(input.teacherLogChannelId),
    };

    const result = await supabase
        .from('guild_settings')
        .upsert(payload, { onConflict: 'guild_id' });

    if (result.error && !isMissingGuildSettingsTable(result.error)) {
        throw new Error(`寫入 guild_settings 失敗：${result.error.message}`);
    }
}

export async function getTeacherRoleIdForGuild(guildId: string): Promise<string | null> {
    const settings = await getGuildSettings(guildId);
    return normalizeOptionalId(settings?.teacher_role_id) ?? normalizeOptionalId(process.env.TEACHER_ROLE_ID);
}

export async function getTeacherLogChannelIdForGuild(guildId: string): Promise<string | null> {
    const settings = await getGuildSettings(guildId);
    return normalizeOptionalId(settings?.teacher_log_channel_id) ?? normalizeOptionalId(process.env.TEACHER_LOG_CHANNEL_ID);
}
