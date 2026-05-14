import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { generateModelText, type GenerateModelPart } from './llmService';

type PdfParseModule = typeof import('pdf-parse');
type MammothModule = typeof import('mammoth');
type ResvgConstructor = typeof import('@resvg/resvg-js').Resvg;

const loadPdfParseModule = (): PdfParseModule => require('pdf-parse') as PdfParseModule;
const loadMammoth = (): MammothModule => require('mammoth') as MammothModule;
const loadResvg = (): ResvgConstructor => require('@resvg/resvg-js').Resvg as ResvgConstructor;

const extractPdfTextFromBuffer = async (buffer: Buffer) => {
    const { PDFParse } = loadPdfParseModule();
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
        const parsed = await parser.getText();
        return normalizeWhitespace(parsed.text ?? '');
    } finally {
        await parser.destroy();
    }
};

export type AttachmentInput = {
    name: string;
    url: string;
    contentType?: string | null;
    size?: number;
};

export type SupportedAttachmentType = 'txt' | 'md' | 'pdf' | 'pptx' | 'docx';

export type AttachmentAnalysis = {
    filename: string;
    fileType: SupportedAttachmentType | 'unsupported';
    status: 'ok' | 'skipped' | 'failed';
    rawText: string;
    structuredSummary: string;
    warnings: string[];
    editable: boolean;
};

type ExtractedDocument = {
    fileType: SupportedAttachmentType;
    rawText: string;
    summarySeed?: string;
    warnings: string[];
};

type PptxShape = {
    kind: 'text' | 'image' | 'chart' | 'table' | 'shape';
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
};

type PptxSlide = {
    index: number;
    text: string;
    notes: string;
    shapes: PptxShape[];
    summary: string;
};

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: false,
    parseTagValue: false,
});

const EMU_PER_PX = 9525;
const DEFAULT_AGENT_MODEL = () => process.env.GEMINI_MODEL || process.env.QUESTION_MODEL || 'gemini-3.1-flash-lite-preview';
const ATTACHMENT_MAX_FILES = Math.max(1, Number(process.env.ATTACHMENT_MAX_FILES || 5));
const ATTACHMENT_MAX_BYTES = Math.max(1024, Number(process.env.ATTACHMENT_MAX_BYTES || 20 * 1024 * 1024));
const ATTACHMENT_CHUNK_SIZE = Math.max(1500, Number(process.env.ATTACHMENT_CHUNK_SIZE || 6000));
const ATTACHMENT_SUMMARY_TOKENS = Math.max(256, Number(process.env.ATTACHMENT_MAX_SUMMARY_TOKENS || 1400));
const ATTACHMENT_CONTEXT_EXCERPT_CHARS = Math.max(1000, Number(process.env.ATTACHMENT_CONTEXT_EXCERPT_CHARS || 20000));
const ATTACHMENT_PPTX_MAX_SLIDES = Math.max(1, Math.min(20, Number(process.env.ATTACHMENT_PPTX_MAX_SLIDES || 12)));
const DOC_EDIT_MAX_FILES = Math.max(1, Number(process.env.DOC_EDIT_MAX_FILES || 3));
const DOC_EDIT_MAX_CHARS = Math.max(2000, Number(process.env.DOC_EDIT_MAX_CHARS || 12000));
const SUPPORTED_READ_TYPES = new Set<SupportedAttachmentType>(['txt', 'md', 'pdf', 'pptx', 'docx']);
const SUPPORTED_EDIT_TYPES = new Set<SupportedAttachmentType>(['txt', 'md', 'docx']);
const isSupportedReadType = (value: string): value is SupportedAttachmentType => SUPPORTED_READ_TYPES.has(value as SupportedAttachmentType);

const asArray = <T>(value: T | T[] | undefined | null): T[] => {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
};

const normalizeWhitespace = (text: string) => text
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const escapeXml = (text: string) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const chunkText = (text: string, maxChars = ATTACHMENT_CHUNK_SIZE) => {
    const normalized = normalizeWhitespace(text);
    if (normalized.length <= maxChars) {
        return [normalized];
    }

    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < normalized.length) {
        let next = Math.min(normalized.length, cursor + maxChars);
        if (next < normalized.length) {
            const lastBreak = Math.max(
                normalized.lastIndexOf('\n\n', next),
                normalized.lastIndexOf('\n', next),
                normalized.lastIndexOf('。', next),
                normalized.lastIndexOf(' ', next),
            );
            if (lastBreak > cursor + Math.floor(maxChars * 0.5)) {
                next = lastBreak + 1;
            }
        }

        const piece = normalized.slice(cursor, next).trim();
        if (piece) {
            chunks.push(piece);
        }
        cursor = next;
    }

    return chunks;
};

const wrapSvgText = (text: string, maxChars: number) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return [] as string[];

    const words = normalized.split(' ');
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxChars) {
            current = candidate;
            continue;
        }
        if (current) {
            lines.push(current);
        }
        current = word;
    }

    if (current) {
        lines.push(current);
    }
    return lines.slice(0, 6);
};

const getAttachmentType = (attachment: AttachmentInput): SupportedAttachmentType | 'unsupported' => {
    const extension = attachment.name.toLowerCase().split('.').pop() ?? '';
    if (extension === 'txt') return 'txt';
    if (extension === 'md' || extension === 'markdown') return 'md';
    if (extension === 'pdf') return 'pdf';
    if (extension === 'pptx') return 'pptx';
    if (extension === 'docx') return 'docx';
    return 'unsupported';
};

const buildFocusTerms = (prompt = '') => {
    const terms = new Set<string>();
    const normalized = prompt.trim();
    if (!normalized) {
        return [] as string[];
    }

    for (const match of normalized.matchAll(/(?:table|表格|表)\s*\.?\s*(\d+)/gi)) {
        const tableNumber = match[1];
        if (!tableNumber) continue;
        terms.add(`table ${tableNumber}`);
        terms.add(`table${tableNumber}`);
        terms.add(`表 ${tableNumber}`);
        terms.add(`表格 ${tableNumber}`);
        terms.add(`表${tableNumber}`);
        terms.add(`表格${tableNumber}`);
    }

    for (const match of normalized.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g)) {
        const term = match[0]?.trim();
        if (term && !/^(幫我|請問|解釋|整理|說明|一下|這個|那個)$/.test(term)) {
            terms.add(term);
        }
    }

    return [...terms].sort((left, right) => right.length - left.length);
};

const buildFocusedExcerpt = (text: string, prompt = '', maxChars = ATTACHMENT_CONTEXT_EXCERPT_CHARS) => {
    const normalized = normalizeWhitespace(text);
    if (normalized.length <= maxChars) {
        return normalized;
    }

    const lowerText = normalized.toLowerCase();
    const matchedIndex = buildFocusTerms(prompt)
        .map((term) => lowerText.indexOf(term.toLowerCase()))
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];

    const start = matchedIndex == null
        ? 0
        : Math.max(0, matchedIndex - Math.floor(maxChars * 0.25));
    const end = Math.min(normalized.length, start + maxChars);
    const prefix = start > 0 ? '...（前文略）\n' : '';
    const suffix = end < normalized.length ? '\n...（後文略）' : '';
    return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
};

export const isEditInstruction = (prompt: string) => /(修文|修改|改寫|改成|正式一點|報告口吻|潤稿|修正文法|重寫|精簡|順一下|rewrite|edit)/i.test(prompt);

const buildTextOnlySummary = async (filename: string, text: string) => {
    const chunks = chunkText(text);
    if (chunks.length === 0) {
        return '文件沒有可整理的文字內容。';
    }

    if (chunks.length === 1) {
        return generateModelText({
            model: DEFAULT_AGENT_MODEL(),
            temperature: 0.2,
            maxOutputTokens: ATTACHMENT_SUMMARY_TOKENS,
            prompt: [
                '你是文件整理助理，請用繁體中文整理這份文件的重點。',
                '輸出格式：',
                '1. 文件主題',
                '2. 三到五點重點',
                '3. 若適合，補一句建議用途或下一步',
                '',
                `檔名：${filename}`,
                '',
                `文件內容：\n${chunks[0]}`,
            ].join('\n'),
        });
    }

    const partialSummaries: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (!chunk) continue;
        const summary = await generateModelText({
            model: DEFAULT_AGENT_MODEL(),
            temperature: 0.2,
            maxOutputTokens: 500,
            prompt: [
                '你是文件整理助理，請用繁體中文整理這段文件內容。',
                '請輸出 3 到 5 條條列。',
                `檔名：${filename}`,
                `分段：${index + 1}/${chunks.length}`,
                '',
                chunk,
            ].join('\n'),
        });
        partialSummaries.push(`第 ${index + 1} 段摘要：\n${summary.trim()}`);
    }

    return generateModelText({
        model: DEFAULT_AGENT_MODEL(),
        temperature: 0.2,
        maxOutputTokens: ATTACHMENT_SUMMARY_TOKENS,
        prompt: [
            '你是文件整理助理，請把多段摘要整合成一份完整摘要。',
            '輸出格式：',
            '1. 文件主題',
            '2. 四到六點重點',
            '3. 若有必要，補一句注意事項',
            '',
            `檔名：${filename}`,
            '',
            partialSummaries.join('\n\n'),
        ].join('\n'),
    });
};

const localName = (key: string) => {
    const parts = key.split(':');
    return parts[parts.length - 1] ?? key;
};

const findFirstNode = (node: unknown, targetName: string): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object') {
        return null;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findFirstNode(item, targetName);
            if (found) return found;
        }
        return null;
    }

    const entries = Object.entries(node as Record<string, unknown>);
    for (const [key, value] of entries) {
        if (localName(key) === targetName && value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        const found = findFirstNode(value, targetName);
        if (found) return found;
    }
    return null;
};

const collectTextNodes = (node: unknown): string[] => {
    if (node == null) return [];
    if (typeof node === 'string') return [node];
    if (Array.isArray(node)) return node.flatMap((item) => collectTextNodes(item));
    if (typeof node !== 'object') return [];

    const texts: string[] = [];
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (localName(key) === 't' && typeof value === 'string') {
            texts.push(value);
            continue;
        }
        texts.push(...collectTextNodes(value));
    }
    return texts;
};

const collectNodesByLocalName = (node: unknown, targetName: string): Record<string, unknown>[] => {
    if (!node || typeof node !== 'object') {
        return [];
    }

    if (Array.isArray(node)) {
        return node.flatMap((item) => collectNodesByLocalName(item, targetName));
    }

    const matches: Record<string, unknown>[] = [];
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (localName(key) === targetName && value && typeof value === 'object' && !Array.isArray(value)) {
            matches.push(value as Record<string, unknown>);
        }
        matches.push(...collectNodesByLocalName(value, targetName));
    }
    return matches;
};

const readTransform = (node: Record<string, unknown>) => {
    const xfrm = findFirstNode(node, 'xfrm');
    const off = xfrm ? findFirstNode(xfrm, 'off') : null;
    const ext = xfrm ? findFirstNode(xfrm, 'ext') : null;
    const x = Number(off?.['@_x'] ?? 0) / EMU_PER_PX;
    const y = Number(off?.['@_y'] ?? 0) / EMU_PER_PX;
    const w = Math.max(80, Number(ext?.['@_cx'] ?? 800000) / EMU_PER_PX);
    const h = Math.max(40, Number(ext?.['@_cy'] ?? 400000) / EMU_PER_PX);
    return { x, y, w, h };
};

const extractPptxShapes = (slideDoc: Record<string, unknown>) => {
    const shapes: PptxShape[] = [];

    for (const shape of collectNodesByLocalName(slideDoc, 'sp')) {
        const text = normalizeWhitespace(collectTextNodes(shape).join(' '));
        const transform = readTransform(shape);
        shapes.push({
            kind: 'text',
            text,
            ...transform,
        });
    }

    for (const picture of collectNodesByLocalName(slideDoc, 'pic')) {
        shapes.push({
            kind: 'image',
            text: '圖片區塊',
            ...readTransform(picture),
        });
    }

    for (const frame of collectNodesByLocalName(slideDoc, 'graphicFrame')) {
        const serialized = JSON.stringify(frame);
        const kind = serialized.includes('tbl') ? 'table' : serialized.includes('chart') ? 'chart' : 'shape';
        shapes.push({
            kind,
            text: kind === 'table' ? '表格區塊' : kind === 'chart' ? '圖表區塊' : '圖形區塊',
            ...readTransform(frame),
        });
    }

    return shapes
        .filter((shape) => shape.w > 0 && shape.h > 0)
        .sort((a, b) => a.y - b.y || a.x - b.x);
};

const renderPptxSlideSvg = (shapes: PptxShape[], width: number, height: number, slideNumber: number, notes: string) => {
    const content = shapes.map((shape) => {
        const fill = shape.kind === 'text'
            ? '#F8FAFC'
            : shape.kind === 'image'
                ? '#E2E8F0'
                : shape.kind === 'chart'
                    ? '#DBEAFE'
                    : shape.kind === 'table'
                        ? '#DCFCE7'
                        : '#F3F4F6';
        const stroke = shape.kind === 'text' ? '#2563EB' : '#94A3B8';
        const label = shape.kind === 'text'
            ? shape.text || '文字方塊'
            : shape.kind === 'image'
                ? 'IMAGE'
                : shape.kind === 'chart'
                    ? 'CHART'
                    : shape.kind === 'table'
                        ? 'TABLE'
                        : shape.text || 'SHAPE';
        const maxChars = Math.max(10, Math.floor(shape.w / 12));
        const lines = wrapSvgText(label, maxChars);
        const textSvg = lines.map((line, index) => (
            `<text x="${shape.x + 10}" y="${shape.y + 26 + (index * 18)}" font-size="16" font-family="Arial" fill="#0F172A">${escapeXml(line)}</text>`
        )).join('');

        return [
            `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2" />`,
            textSvg,
        ].join('');
    }).join('');

    const noteLines = wrapSvgText(notes || '無備註', 72).slice(0, 4)
        .map((line, index) => `<text x="24" y="${height - 82 + (index * 18)}" font-size="14" font-family="Arial" fill="#475569">${escapeXml(line)}</text>`)
        .join('');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<rect x="0" y="0" width="${width}" height="${height}" fill="#FFFFFF" />`,
        `<text x="24" y="34" font-size="20" font-family="Arial" font-weight="700" fill="#0F172A">Slide ${slideNumber}</text>`,
        content,
        `<rect x="16" y="${height - 110}" width="${Math.max(280, width - 32)}" height="94" rx="10" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1.5" />`,
        `<text x="24" y="${height - 90}" font-size="14" font-family="Arial" font-weight="700" fill="#334155">備註 / Notes</text>`,
        noteLines,
        '</svg>',
    ].join('');
};

const summarizePptxSlide = async (slide: PptxSlide, pngBuffer: Buffer) => {
    const parts: GenerateModelPart[] = [
        {
            text: [
                '你是簡報閱讀助理。請根據這張投影片預覽與抽出的文字，用繁體中文整理這頁重點。',
                '請輸出 4 到 6 行：',
                '1. 這頁主題',
                '2. 主要區塊或版面重心',
                '3. 若像圖表/表格/圖片，請描述可能用途',
                '4. 若有明顯結論句，也請點出',
                '',
                `投影片文字：${slide.text || '（文字很少）'}`,
                slide.notes ? `備註：${slide.notes}` : '備註：（無）',
            ].join('\n'),
        },
        {
            inlineData: {
                mimeType: 'image/png',
                data: pngBuffer.toString('base64'),
            },
        },
    ];

    return generateModelText({
        model: DEFAULT_AGENT_MODEL(),
        parts,
        temperature: 0.2,
        maxOutputTokens: 400,
    });
};

const extractPptxDocument = async (buffer: Buffer): Promise<ExtractedDocument> => {
    const Resvg = loadResvg();
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = zip.file(/^ppt\/slides\/slide\d+\.xml$/).sort((a, b) => {
        const left = Number(/slide(\d+)\.xml$/i.exec(a.name)?.[1] ?? 0);
        const right = Number(/slide(\d+)\.xml$/i.exec(b.name)?.[1] ?? 0);
        return left - right;
    });

    const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
    const sizeMatch = presentationXml ? /cx="(\d+)".*cy="(\d+)"/i.exec(presentationXml) : null;
    const width = Math.max(960, Math.round(Number(sizeMatch?.[1] ?? 9144000) / EMU_PER_PX));
    const height = Math.max(540, Math.round(Number(sizeMatch?.[2] ?? 5143500) / EMU_PER_PX));
    const warnings: string[] = [];
    const slides: PptxSlide[] = [];

    const limitedSlides = slideFiles.slice(0, ATTACHMENT_PPTX_MAX_SLIDES);
    if (slideFiles.length > limitedSlides.length) {
        warnings.push(`投影片頁數較多，這次先處理前 ${limitedSlides.length} 頁。`);
    }

    for (const slideFile of limitedSlides) {
        const slideIndex = Number(/slide(\d+)\.xml$/i.exec(slideFile.name)?.[1] ?? slides.length + 1);
        const xml = await slideFile.async('string');
        const parsed = xmlParser.parse(xml) as Record<string, unknown>;
        const slideText = normalizeWhitespace(collectTextNodes(parsed).join(' '));
        const noteXml = await zip.file(`ppt/notesSlides/notesSlide${slideIndex}.xml`)?.async('string');
        const noteText = noteXml ? normalizeWhitespace(collectTextNodes(xmlParser.parse(noteXml) as Record<string, unknown>).join(' ')) : '';
        const shapes = extractPptxShapes(parsed);
        const svg = renderPptxSlideSvg(shapes, width, height, slideIndex, noteText);
        const pngBuffer = new Resvg(svg, { fitTo: { mode: 'width', value: 1280 } }).render().asPng();
        const slide: PptxSlide = {
            index: slideIndex,
            text: slideText,
            notes: noteText,
            shapes,
            summary: '',
        };
        slide.summary = await summarizePptxSlide(slide, pngBuffer);
        slides.push(slide);
    }

    const deckSummary = await generateModelText({
        model: DEFAULT_AGENT_MODEL(),
        temperature: 0.2,
        maxOutputTokens: ATTACHMENT_SUMMARY_TOKENS,
        prompt: [
            '你是簡報整理助理。請根據逐頁摘要整理整份簡報的重點。',
            '輸出格式：',
            '1. 簡報主題',
            '2. 三到六點重點',
            '3. 若適合，列出值得追問的頁面編號',
            '',
            slides.map((slide) => `第 ${slide.index} 頁：\n${slide.summary}`).join('\n\n'),
        ].join('\n'),
    });

    const rawText = slides.map((slide) => `第 ${slide.index} 頁\n${slide.text}${slide.notes ? `\n備註：${slide.notes}` : ''}`).join('\n\n');

    return {
        fileType: 'pptx',
        rawText,
        summarySeed: [
            deckSummary.trim(),
            '',
            slides.map((slide) => `第 ${slide.index} 頁摘要：${slide.summary.trim()}`).join('\n'),
        ].join('\n'),
        warnings,
    };
};

const extractDocument = async (attachment: AttachmentInput, buffer: Buffer): Promise<ExtractedDocument> => {
    const detectedType = getAttachmentType(attachment);
    if (!isSupportedReadType(detectedType)) {
        throw new Error('不支援的附件格式');
    }
    const fileType = detectedType;

    if (fileType === 'txt' || fileType === 'md') {
        return {
            fileType,
            rawText: normalizeWhitespace(buffer.toString('utf8')),
            warnings: [],
        };
    }

    if (fileType === 'pdf') {
        return {
            fileType,
            rawText: await extractPdfTextFromBuffer(buffer),
            warnings: [],
        };
    }

    if (fileType === 'docx') {
        const mammoth = loadMammoth();
        const parsed = await mammoth.extractRawText({ buffer });
        return {
            fileType,
            rawText: normalizeWhitespace(parsed.value),
            warnings: parsed.messages.map((message) => message.message).filter((message) => message.length > 0),
        };
    }

    return extractPptxDocument(buffer);
};

const downloadAttachmentBuffer = async (attachment: AttachmentInput) => {
    const response = await fetch(attachment.url);
    if (!response.ok) {
        throw new Error(`下載附件失敗：HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
};

export async function processAttachmentsForReading(attachments: AttachmentInput[]): Promise<AttachmentAnalysis[]> {
    const results: AttachmentAnalysis[] = [];
    const limited = attachments.slice(0, ATTACHMENT_MAX_FILES);

    for (const attachment of limited) {
        const fileType = getAttachmentType(attachment);
        const warnings: string[] = [];
        if (attachment.size && attachment.size > ATTACHMENT_MAX_BYTES) {
            results.push({
                filename: attachment.name,
                fileType,
                status: 'skipped',
                rawText: '',
                structuredSummary: '',
                warnings: [`檔案超過大小限制（>${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB）。`],
                editable: fileType !== 'unsupported' && SUPPORTED_EDIT_TYPES.has(fileType),
            });
            continue;
        }

        if (fileType === 'unsupported') {
            results.push({
                filename: attachment.name,
                fileType,
                status: 'skipped',
                rawText: '',
                structuredSummary: '',
                warnings: ['目前只支援 .txt、.md、.pdf、.pptx、.docx。'],
                editable: false,
            });
            continue;
        }

        try {
            const buffer = await downloadAttachmentBuffer(attachment);
            const extracted = await extractDocument(attachment, buffer);
            const rawText = normalizeWhitespace(extracted.rawText);
            if (!rawText) {
                results.push({
                    filename: attachment.name,
                    fileType,
                    status: 'failed',
                    rawText: '',
                    structuredSummary: '',
                    warnings: ['附件幾乎沒有可讀文字內容。'],
                    editable: SUPPORTED_EDIT_TYPES.has(fileType),
                });
                continue;
            }

            const truncatedText = rawText.length > DOC_EDIT_MAX_CHARS
                ? rawText.slice(0, DOC_EDIT_MAX_CHARS)
                : rawText;
            if (rawText.length > DOC_EDIT_MAX_CHARS) {
                warnings.push(`抽出的文字較長，原文已超過 ${DOC_EDIT_MAX_CHARS} 字，摘要會走分段整理。`);
            }

            const structuredSummary = extracted.summarySeed?.trim() || await buildTextOnlySummary(attachment.name, truncatedText);
            results.push({
                filename: attachment.name,
                fileType,
                status: 'ok',
                rawText,
                structuredSummary: structuredSummary.trim(),
                warnings: [...warnings, ...extracted.warnings],
                editable: SUPPORTED_EDIT_TYPES.has(fileType),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({
                filename: attachment.name,
                fileType,
                status: 'failed',
                rawText: '',
                structuredSummary: '',
                warnings: [message],
                editable: SUPPORTED_EDIT_TYPES.has(fileType as SupportedAttachmentType),
            });
        }
    }

    if (attachments.length > limited.length) {
        results.push({
            filename: '其他附件',
            fileType: 'unsupported',
            status: 'skipped',
            rawText: '',
            structuredSummary: '',
            warnings: [`附件數量超過上限，已只處理前 ${limited.length} 份。`],
            editable: false,
        });
    }

    return results;
}

export const formatAttachmentReadContext = (results: AttachmentAnalysis[], focusPrompt = '') => {
    const readable = results.filter((item) => item.status === 'ok');
    const others = results.filter((item) => item.status !== 'ok');

    const sections = [
        readable.length > 0
            ? `附件內容摘要：\n${readable.map((item) => [
                `檔名：${item.filename}`,
                `格式：${item.fileType}`,
                `摘要：${item.structuredSummary}`,
                `可查詢原文片段：\n${buildFocusedExcerpt(item.rawText, focusPrompt)}`,
            ].join('\n')).join('\n\n')}`
            : '附件內容摘要：（無）',
    ];

    if (others.length > 0) {
        sections.push(`附件處理提醒：\n${others.map((item) => `- ${item.filename}：${item.warnings.join('；') || '略過'}`).join('\n')}`);
    }

    return sections.join('\n\n');
};

export const formatAttachmentReadReplyHeader = (results: AttachmentAnalysis[]) => {
    if (results.length === 0) {
        return '';
    }

    const okFiles = results.filter((item) => item.status === 'ok').map((item) => item.filename);
    const failedFiles = results.filter((item) => item.status !== 'ok').map((item) => `${item.filename}（${item.warnings[0] ?? '略過'}）`);
    const lines: string[] = [];

    if (okFiles.length > 0) {
        lines.push(`已讀附件：${okFiles.join('、')}`);
    }
    if (failedFiles.length > 0) {
        lines.push(`未完整讀取：${failedFiles.join('、')}`);
    }
    return lines.join('\n');
};

const buildEditChecklist = async (filename: string, text: string, instruction: string) => generateModelText({
    model: DEFAULT_AGENT_MODEL(),
    temperature: 0.2,
    maxOutputTokens: 450,
    prompt: [
        '你是文字編修助理，請根據文件內容與修改要求，產生「修訂清單」。',
        '只輸出條列，每條前面加 - 。',
        '條列請聚焦在語氣、結構、冗詞、銜接與資訊表達。',
        '',
        `檔名：${filename}`,
        `修改要求：${instruction}`,
        '',
        text,
    ].join('\n'),
});

const rewriteEditChunk = async (filename: string, text: string, instruction: string, chunkIndex?: number, chunkCount?: number) => {
    const chunkLabel = chunkIndex != null && chunkCount != null ? `第 ${chunkIndex + 1}/${chunkCount} 段` : '全文';
    return generateModelText({
        model: DEFAULT_AGENT_MODEL(),
        temperature: 0.3,
        maxOutputTokens: Math.min(ATTACHMENT_SUMMARY_TOKENS + 200, 1800),
        prompt: [
            '你是文字編修助理，請直接輸出修正版內容。',
            '不要解釋，不要加前言，不要加條列。',
            '保留原本語言，並依要求修正文法、語氣、冗詞與段落順序。',
            '',
            `檔名：${filename}`,
            `範圍：${chunkLabel}`,
            `修改要求：${instruction}`,
            '',
            text,
        ].join('\n'),
    });
};

export async function editAttachments(attachments: AttachmentInput[], instruction: string): Promise<string> {
    const readResults = await processAttachmentsForReading(attachments.slice(0, DOC_EDIT_MAX_FILES));
    const editable = readResults.filter((item) => item.status === 'ok' && item.fileType !== 'unsupported' && item.editable);

    if (editable.length === 0) {
        return '目前沒有可編修的附件。請附上 `.md`、`.txt` 或 `.docx` 檔案。';
    }

    const sections: string[] = [];
    for (const item of editable) {
        const sourceText = item.rawText.slice(0, DOC_EDIT_MAX_CHARS);
        const chunks = chunkText(sourceText, ATTACHMENT_CHUNK_SIZE);
        const checklist = await buildEditChecklist(item.filename, sourceText, instruction);
        const rewrittenChunks: string[] = [];

        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (!chunk) continue;
            const rewritten = await rewriteEditChunk(item.filename, chunk, instruction, chunks.length > 1 ? index : undefined, chunks.length > 1 ? chunks.length : undefined);
            rewrittenChunks.push(chunks.length > 1 ? `【第 ${index + 1} 段修正版】\n${rewritten.trim()}` : rewritten.trim());
        }

        const warnings = [...item.warnings];
        if (item.rawText.length > DOC_EDIT_MAX_CHARS) {
            warnings.push(`原文超過 ${DOC_EDIT_MAX_CHARS} 字，這次先以前段內容做分段修訂。`);
        }

        sections.push([
            `檔案：${item.filename}`,
            warnings.length > 0 ? `提醒：${warnings.join('；')}` : '',
            '修訂清單',
            checklist.trim(),
            '',
            '建議修正版',
            rewrittenChunks.join('\n\n'),
        ].filter((line) => line.trim().length > 0).join('\n'));
    }

    return sections.join('\n\n---\n\n');
}

export const __attachmentServiceForTests = {
    chunkText,
    buildFocusedExcerpt,
    extractPdfTextFromBuffer,
    getAttachmentType,
    isEditInstruction,
    formatAttachmentReadContext,
};
