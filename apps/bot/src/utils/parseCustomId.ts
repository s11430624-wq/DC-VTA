export type AnswerCustomId = {
    questionId: number;
    selectedOption: string;
    openedAtMs: number | null;
    durationSeconds: number | null;
};

export function parseAnswerCustomId(customId: string): AnswerCustomId | null {
    const match = /^answer:qid=(\d+):opt=([A-D])(?::open=(\d{13}))?(?::dur=(\d+))?$/.exec(customId);

    if (!match) {
        return null;
    }

    return {
        questionId: Number(match[1]!),
        selectedOption: match[2]!,
        openedAtMs: match[3] ? Number(match[3]) : null,
        durationSeconds: match[4] ? Number(match[4]) : null,
    };
}
