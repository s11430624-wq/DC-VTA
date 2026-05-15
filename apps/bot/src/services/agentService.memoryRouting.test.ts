import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMentionMode, resolveMemoryRouting } from './agentService';

test('detectMentionMode returns true only for real mention flag', () => {
    assert.equal(detectMentionMode(true), true);
    assert.equal(detectMentionMode(false), false);
});

test('resolveMemoryRouting uses PERSONAL key when message is not mention', () => {
    process.env.MEMORY_DEFAULT_SCOPE = 'PERSONAL';
    process.env.MEMORY_MENTION_SCOPE = 'MENTION_PERSONAL';
    const result = resolveMemoryRouting('user-1', 'guild-1', false);
    assert.deepEqual(result, {
        scopeType: 'PERSONAL',
        sessionKey: 'guild-1:user-1',
    });
});

test('resolveMemoryRouting uses MENTION_PERSONAL key when message has mention', () => {
    process.env.MEMORY_DEFAULT_SCOPE = 'PERSONAL';
    process.env.MEMORY_MENTION_SCOPE = 'MENTION_PERSONAL';
    const result = resolveMemoryRouting('user-1', 'guild-1', true);
    assert.deepEqual(result, {
        scopeType: 'MENTION_PERSONAL',
        sessionKey: 'guild-1:user-1:mention',
    });
});

test('resolveMemoryRouting falls back for DM without guild', () => {
    process.env.MEMORY_DEFAULT_SCOPE = 'PERSONAL';
    process.env.MEMORY_MENTION_SCOPE = 'MENTION_PERSONAL';
    assert.deepEqual(resolveMemoryRouting('user-1', null, false), {
        scopeType: 'PERSONAL',
        sessionKey: 'user-1',
    });
    assert.deepEqual(resolveMemoryRouting('user-1', null, true), {
        scopeType: 'MENTION_PERSONAL',
        sessionKey: 'user-1:mention',
    });
});
