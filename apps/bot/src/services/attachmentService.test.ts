import test from 'node:test';
import assert from 'node:assert/strict';

import { __attachmentServiceForTests } from './attachmentService';

const buildTinyPdf = (text: string) => {
    const escapePdfText = (value: string) => value
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');

    const objects = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
        '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    ];
    const stream = `BT /F1 24 Tf 100 700 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(`5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream\nendobj\n`);

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const object of objects) {
        offsets.push(Buffer.byteLength(pdf, 'ascii'));
        pdf += object;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'ascii');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    for (const offset of offsets.slice(1)) {
        pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(pdf, 'ascii');
};

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

test('extractPdfTextFromBuffer reads text with current pdf-parse API', async () => {
    const text = await __attachmentServiceForTests.extractPdfTextFromBuffer(buildTinyPdf('Hello PDF'));

    assert.match(text, /Hello PDF/);
});
