import test from 'node:test';
import assert from 'node:assert/strict';

import { __attachmentServiceForTests } from './attachmentService';

test('attachment type detection recognizes supported formats', () => {
    assert.equal(__attachmentServiceForTests.getAttachmentType({ name: 'notes.md', url: 'https://example.com/notes.md' }), 'md');
    assert.equal(__attachmentServiceForTests.getAttachmentType({ name: 'slides.pptx', url: 'https://example.com/slides.pptx' }), 'pptx');
    assert.equal(__attachmentServiceForTests.getAttachmentType({ name: 'report.pdf', url: 'https://example.com/report.pdf' }), 'pdf');
    assert.equal(__attachmentServiceForTests.getAttachmentType({ name: 'archive.zip', url: 'https://example.com/archive.zip' }), 'unsupported');
});

test('edit instruction detection catches rewrite prompts', () => {
    assert.equal(__attachmentServiceForTests.isEditInstruction('幫我改成比較正式的報告口吻'), true);
    assert.equal(__attachmentServiceForTests.isEditInstruction('請整理這份文件的三個重點'), false);
});

test('chunkText keeps content intact while splitting long text', () => {
    const source = '第一段內容。'.repeat(900);
    const chunks = __attachmentServiceForTests.chunkText(source, 1500);

    assert.ok(chunks.length > 1);
    assert.equal(chunks.join('').replace(/\s+/g, ''), source.replace(/\s+/g, ''));
});
