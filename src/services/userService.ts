import { supabase } from './supabase';

export type UserRecord = {
    user_id: string;
    display_name: string | null;
    student_id: string | null;
    role: string | null;
    platform?: string | null;
};

const isMissingPlatformColumn = (error: { message?: string; code?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST204' || message.includes('platform');
};

export async function getUserByDiscordId(discordUserId: string): Promise<UserRecord | null> {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('user_id', discordUserId)
        .maybeSingle();

    if (error) {
        throw new Error(`查詢使用者失敗：${error.message}`);
    }

    return data as UserRecord | null;
}

export async function linkStudent(
    discordUserId: string,
    displayName: string,
    studentId: string,
): Promise<UserRecord> {
    const existingUser = await getUserByDiscordId(discordUserId);
    const role = existingUser?.role ?? 'student';

    const payload = {
        user_id: discordUserId,
        display_name: displayName,
        student_id: studentId,
        role,
        platform: 'discord',
    };

    const saveWithoutPlatform = async () => {
        const { platform, ...payloadWithoutPlatform } = payload;

        if (existingUser) {
            return supabase
                .from('users')
                .update(payloadWithoutPlatform)
                .eq('user_id', discordUserId)
                .select('*')
                .single();
        }

        return supabase
            .from('users')
            .insert(payloadWithoutPlatform)
            .select('*')
            .single();
    };

    const result = existingUser
        ? await supabase
            .from('users')
            .update(payload)
            .eq('user_id', discordUserId)
            .select('*')
            .single()
        : await supabase
            .from('users')
            .insert(payload)
            .select('*')
            .single();

    if (result.error) {
        if (isMissingPlatformColumn(result.error)) {
            const fallbackResult = await saveWithoutPlatform();
            if (fallbackResult.error) {
                throw new Error(`綁定使用者失敗：${fallbackResult.error.message}`);
            }

            return fallbackResult.data as UserRecord;
        }

        throw new Error(`綁定使用者失敗：${result.error.message}`);
    }

    return result.data as UserRecord;
}

export async function getUserRole(discordUserId: string): Promise<string | null> {
    const user = await getUserByDiscordId(discordUserId);
    return user?.role ?? null;
}

export async function getUsersByIds(userIds: string[]): Promise<UserRecord[]> {
    if (userIds.length === 0) {
        return [];
    }

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .in('user_id', userIds);

    if (error) {
        throw new Error(`批次查詢使用者失敗：${error.message}`);
    }

    return (data ?? []) as UserRecord[];
}
