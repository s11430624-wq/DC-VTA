import type { ChatInputCommandInteraction } from 'discord.js';
import { getUserRole } from '../services/userService';
import { safeReply } from './errorHandler';

const hasDiscordTeacherRole = (interaction: ChatInputCommandInteraction) => {
    const teacherRoleId = process.env.TEACHER_ROLE_ID;
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
    const discordRoleResult = hasDiscordTeacherRole(interaction);

    if (discordRoleResult !== null) {
        return discordRoleResult;
    }

    const userRole = await getUserRole(interaction.user.id);
    return userRole === 'teacher';
}

export async function requireTeacher(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (await isTeacher(interaction)) {
        return true;
    }

    await safeReply(interaction, '⛔ 你沒有權限使用此指令。', true);
    return false;
}
