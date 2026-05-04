import {
    DiscordAPIError,
    MessageFlags,
    type InteractionEditReplyOptions,
    type InteractionReplyOptions,
    type RepliableInteraction,
} from 'discord.js';

export function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

const buildReplyOptions = (content: string, ephemeral: boolean): InteractionReplyOptions => ({
    content,
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
});

const buildEditReplyOptions = (content: string): InteractionEditReplyOptions => ({
    content,
});

export async function safeReply(interaction: RepliableInteraction, content: string, ephemeral = true) {
    const replyOptions = buildReplyOptions(content, ephemeral);
    const editReplyOptions = buildEditReplyOptions(content);

    try {
        if (interaction.deferred) {
            return await interaction.editReply(editReplyOptions);
        }

        if (interaction.replied) {
            return await interaction.followUp(replyOptions);
        }

        return await interaction.reply(replyOptions);
    } catch (error) {
        if (error instanceof DiscordAPIError) {
            if (error.code === 40060) {
                if (interaction.deferred) {
                    return interaction.editReply(editReplyOptions);
                }

                return interaction.followUp(replyOptions);
            }

            if (error.code === 10062) {
                return null;
            }
        }

        throw error;
    }
}
