import { supabase } from './supabase';

export type UserRecord = {
    user_id: string;
    display_name: string | null;
    student_id: string | null;
    class_name?: string | null;
    role: string | null;
    platform?: string | null;
};

const isMissingPlatformColumn = (error: { message?: string; code?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST204' || message.includes('platform');
};

const isMissingClassNameColumn = (error: { message?: string; code?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST204' || message.includes('class_name');
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
    className?: string | null,
): Promise<UserRecord> {
    const existingUser = await getUserByDiscordId(discordUserId);

    const payload = {
        user_id: discordUserId,
        display_name: displayName,
        student_id: studentId,
        class_name: className?.trim() || existingUser?.class_name || null,
        platform: 'discord',
    };

    const saveWithoutOptionalColumns = async (options: { omitPlatform?: boolean; omitClassName?: boolean }) => {
        const payloadWithoutOptionalColumns = { ...payload };
        if (options.omitPlatform) {
            delete (payloadWithoutOptionalColumns as { platform?: string }).platform;
        }
        if (options.omitClassName) {
            delete (payloadWithoutOptionalColumns as { class_name?: string | null }).class_name;
        }

        if (existingUser) {
            return supabase
                .from('users')
                .update(payloadWithoutOptionalColumns)
                .eq('user_id', discordUserId)
                .select('*')
                .single();
        }

        return supabase
            .from('users')
            .insert(payloadWithoutOptionalColumns)
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
        if (isMissingPlatformColumn(result.error) || isMissingClassNameColumn(result.error)) {
            const fallbackResult = await saveWithoutOptionalColumns({
                omitPlatform: isMissingPlatformColumn(result.error),
                omitClassName: isMissingClassNameColumn(result.error),
            });
            if (fallbackResult.error) {
                throw new Error(`綁定使用者失敗：${fallbackResult.error.message}`);
            }

            return fallbackResult.data as UserRecord;
        }

        throw new Error(`綁定使用者失敗：${result.error.message}`);
    }

    return result.data as UserRecord;
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

export async function getUsersByClassName(className: string): Promise<UserRecord[]> {
    const normalizedClassName = className.trim();
    if (!normalizedClassName) {
        return [];
    }

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('class_name', normalizedClassName);

    if (error) {
        throw new Error(`依班級查詢使用者失敗：${error.message}`);
    }

    return (data ?? []) as UserRecord[];
}
