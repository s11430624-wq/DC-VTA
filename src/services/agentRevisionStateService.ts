import { supabase } from './supabase';

type RevisionTargetRecord = {
    sessionId: string;
    userId: string;
    draftId: string;
};

type RevisionTargetRow = {
    session_id: string;
    user_id: string;
    draft_id: string;
};

const REVISION_TARGET_TABLE = 'agent_revision_targets';
const revisionTargetStore = new Map<string, RevisionTargetRecord>();

const isMissingTableError = (error: { code?: string; message?: string }) => {
    const message = error.message?.toLowerCase() ?? '';
    return error.code === 'PGRST205' || message.includes(REVISION_TARGET_TABLE) || message.includes('relation');
};

export async function setRevisionTarget(
    sessionId: string,
    userId: string,
    draftId: string,
): Promise<void> {
    revisionTargetStore.set(sessionId, {
        sessionId,
        userId,
        draftId,
    });

    const result = await supabase
        .from(REVISION_TARGET_TABLE)
        .upsert({
            session_id: sessionId,
            user_id: userId,
            draft_id: draftId,
        });

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`寫入修改目標失敗：${result.error.message}`);
    }
}

export async function getRevisionTarget(sessionId: string): Promise<RevisionTargetRecord | null> {
    const memoryTarget = revisionTargetStore.get(sessionId);
    if (memoryTarget) {
        return memoryTarget;
    }

    const result = await supabase
        .from(REVISION_TARGET_TABLE)
        .select('session_id, user_id, draft_id')
        .eq('session_id', sessionId)
        .maybeSingle();

    if (result.error) {
        if (isMissingTableError(result.error)) {
            return null;
        }

        throw new Error(`讀取修改目標失敗：${result.error.message}`);
    }

    if (!result.data) {
        return null;
    }

    const row = result.data as RevisionTargetRow;
    const target = {
        sessionId: row.session_id,
        userId: row.user_id,
        draftId: row.draft_id,
    };
    revisionTargetStore.set(sessionId, target);
    return target;
}

export async function clearRevisionTarget(sessionId: string): Promise<void> {
    revisionTargetStore.delete(sessionId);

    const result = await supabase
        .from(REVISION_TARGET_TABLE)
        .delete()
        .eq('session_id', sessionId);

    if (result.error && !isMissingTableError(result.error)) {
        throw new Error(`清除修改目標失敗：${result.error.message}`);
    }
}
