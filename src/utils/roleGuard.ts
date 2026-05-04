import type { ChatInputCommandInteraction } from 'discord.js';
import { getTeacherRoleIdForGuild } from '../services/guildSettingsService';
import { safeReply } from './errorHandler';

const hasDiscordTeacherRole = async (interaction: ChatInputCommandInteraction) => {
    const teacherRoleId = interaction.guildId
        ? await getTeacherRoleIdForGuild(interaction.guildId)
        : process.env.TEACHER_ROLE_ID ?? null;
    const memberRoles = interaction.member?.roles;

    if (!teacherRoleId || !memberRoles || Array.isArray(memberRoles)) {
        return null;
    }

    if ('cache' in memberRoles && typeof memberRoles.cache.has === 'function') {
        return memberRoles.cache.has(teacherRoleId);
    }

    return null;
};

export async function isTeacher(interaction: ChatInputCommandInteraction): Promise<boolean> {
    return (await hasDiscordTeacherRole(interaction)) === true;
}

export async function requireTeacher(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (await isTeacher(interaction)) {
        return true;
    }

    await safeReply(interaction, '⛔ 你沒有權限使用此指令。', true);
    return false;
}
