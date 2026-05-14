import test from 'node:test';
import assert from 'node:assert/strict';

import { __chatMemoryServiceForTests } from './chatMemoryService';

test('chat memory legacy payload matches n8n_chat_histories schema', () => {
    const payload = __chatMemoryServiceForTests.toLegacyPayload({
        session_id: 'channel:123',
        user_id: 'user-1',
        role: 'assistant',
        content: '測試內容',
    });

    assert.equal(payload.session_id, 'channel:123');
    assert.deepEqual(payload.message, {
        role: 'assistant',
        content: '測試內容',
        user_id: 'user-1',
    });
});

test('chat memory can read legacy n8n_chat_histories rows', () => {
    const row = __chatMemoryServiceForTests.fromLegacyRow({
        id: 1,
        session_id: 'channel:123',
        message: {
            role: 'user',
            content: '你好',
            user_id: 'user-1',
        },
    });

    assert.deepEqual(row, {
        session_id: 'channel:123',
        user_id: 'user-1',
        role: 'user',
        content: '你好',
    });
});
