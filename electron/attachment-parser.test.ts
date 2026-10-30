import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import * as CFB from 'cfb';
import { deflateRawSync } from 'node:zlib';
import { parseAttachment } from './attachment-parser';
import { hwpText } from './hangul-text';
function zip(files: Record<string, string>) {
  const archive = CFB.utils.cfb_new();
  for (const [name, content] of Object.entries(files)) CFB.utils.cfb_add(archive, name, Buffer.from(content));
  return Buffer.from(CFB.write(archive, { type: 'buffer', fileType: 'zip' }));
}
export function hwpFixture(text: string, compressed = true, protectedFile = false) {
  const file = CFB.utils.cfb_new(); const header = Buffer.alloc(256);
  header.write('HWP Document File', 'ascii'); header.writeUInt32LE(0x05000300, 32); header.writeUInt32LE((compressed ? 1 : 0) | (protectedFile ? 2 : 0), 36);
  CFB.utils.cfb_add(file, '/FileHeader', header);
  const content = Buffer.from(text + '\r', 'utf16le'), record = Buffer.alloc(4); record.writeUInt32LE((content.length << 20) | (1 << 10) | 67);
  const body = Buffer.concat([record, content]);
  CFB.utils.cfb_add(file, '/BodyText/Section0', compressed ? deflateRawSync(body) : body);
  return Buffer.from(CFB.write(file, { type: 'buffer' }));
}
export function pdfFixture() {
  const stream = 'BT /F1 14 Tf 30 80 Td (Question: 2 + 3 = ?) Tj ET';
  const parts = ['%PDF-1.4\n']; const offsets = [0];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(parts.join(''))); parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`); });
  const start = Buffer.byteLength(parts.join('')); parts.push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
  return Buffer.from(parts.join(''));
}
describe('user-linked attachment parsers', () => {
  it('decodes a real PNG and supplies a bounded model image', async () => {
    const canvas = createCanvas(240, 120); const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 240, 120); ctx.fillStyle = 'black'; ctx.fillText('2 + 3 = ?', 20, 50);
    const result = await parseAttachment(canvas.toBuffer('image/png'), 'png');
    expect(result.kind).toBe('image'); expect(result.images).toHaveLength(1); expect(result.images[0].subarray(1, 4).toString()).toBe('PNG');
  });
  it('extracts PDF text AND renders its page, including scanned/diagram content in the image path', async () => {
    const result = await parseAttachment(pdfFixture(), 'pdf');
    expect(result.text).toContain('2 + 3'); expect(result.images).toHaveLength(1); expect(result.kind).toBe('pdf');
  });
  it('reads Korean UTF-8 and UTF-16 text and reports truncation', async () => {
    expect((await parseAttachment(Buffer.from('수학 문제'), 'txt')).text).toBe('수학 문제');
    expect((await parseAttachment(Buffer.concat([Buffer.from([255,254]), Buffer.from('한글 문제', 'utf16le')]), 'txt')).text).toBe('한글 문제');
    const result = await parseAttachment(Buffer.from('x'.repeat(50000)), 'md'); expect(result.text).toHaveLength(40000); expect(result.warning).toContain('40,000');
  });
  it('reads compressed/uncompressed HWP 5 paragraphs and rejects protected or malformed HWP', async () => {
    for (const compressed of [true, false]) expect((await parseAttachment(hwpFixture('학생 질문과 한글 본문', compressed), 'hwp')).text).toContain('학생 질문과 한글 본문');
    expect(() => hwpText(hwpFixture('비공개', true, true))).toThrow('보호');
    expect(() => hwpText(Buffer.from('not hwp'))).toThrow('HWP 5');
  });
  it('reads HWPX section XML, preserves Korean and escapes, and labels missing drawings', async () => {
    const file = zip({ 'Contents/section0.xml': '<hs:sec xmlns:hs="urn:sec" xmlns:hp="urn:para"><hp:p><hp:run><hp:t>문제 &amp; 풀이</hp:t></hp:run></hp:p></hs:sec>' });
    const result = await parseAttachment(file, 'hwpx'); expect(result.text).toContain('문제 & 풀이'); expect(result.warning).toContain('수식');
  });
  it('reads DOCX body text and labels that embedded images are not analyzed', async () => {
    const file = zip({ '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 한국어 질문</w:t></w:r></w:p></w:body></w:document>' });
    const result = await parseAttachment(file, 'docx'); expect(result.text).toContain('Word 한국어 질문'); expect(result.warning).toContain('사진');
  });
  it('rejects unsupported, empty, oversized, binary text and malformed document inputs', async () => {
    for (const [data, extension] of [[Buffer.from('x'), 'exe'], [Buffer.alloc(0), 'txt'], [Buffer.alloc(10 * 1024 * 1024 + 1), 'txt'], [Buffer.from([0, 0, 0, 0]), 'txt'], [Buffer.from('broken'), 'doc'], [Buffer.from('broken'), 'hwpx']] as const) await expect(parseAttachment(data, extension)).rejects.toThrow();
  });
});
