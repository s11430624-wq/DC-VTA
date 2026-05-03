export type AnswerCustomId = {
    questionId: number;
    selectedOption: string;
};

export function parseAnswerCustomId(customId: string): AnswerCustomId | null {
    const match = /^answer:qid=(\d+):opt=([A-D])$/.exec(customId);

    if (!match) {
        return null;
    }

    return {
        questionId: Number(match[1]!),
        selectedOption: match[2]!,
    };
}
