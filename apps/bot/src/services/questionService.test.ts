import test from 'node:test';
import assert from 'node:assert/strict';

import { __questionServiceForTests } from './questionService';

test('question image metadata stores and reads a valid image url', () => {
    const metadata = __questionServiceForTests.withQuestionImageMetadata(
        { options: ['A', 'B', 'C', 'D'] },
        'https://cdn.discordapp.com/attachments/1/2/example.png',
    );

    assert.equal(
        __questionServiceForTests.getQuestionImageUrl(metadata),
        'https://cdn.discordapp.com/attachments/1/2/example.png',
    );
});

test('question image metadata ignores blank and non-http image values', () => {
    assert.deepEqual(__questionServiceForTests.withQuestionImageMetadata({ rubric: 'x' }, ''), { rubric: 'x' });
    assert.equal(__questionServiceForTests.getQuestionImageUrl({ image_url: 'javascript:alert(1)' }), null);
});
