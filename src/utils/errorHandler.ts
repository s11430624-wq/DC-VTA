import type { RepliableInteraction } from 'discord.js';

export function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export async function safeReply(interaction: RepliableInteraction, content: string, ephemeral = true) {
    if (interaction.deferred || interaction.replied) {
        return interaction.followUp({ content, ephemeral });
    }

    return interaction.reply({ content, ephemeral });
}
