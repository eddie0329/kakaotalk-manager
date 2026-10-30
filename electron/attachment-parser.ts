import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { hwpText, hwpxText } from './hangul-text';

export interface ParsedAttachment { kind: 'image' | 'pdf' | 'document' | 'text'; text: string; images: Buffer[]; warning?: string; }
export const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'doc', 'docx', 'hwp', 'hwpx', 'txt', 'md', 'csv'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TEXT_LIMIT = 40_000;
function finish(kind: ParsedAttachment['kind'], text: string, images: Buffer[], warning?: string): ParsedAttachment {
  text = text.replace(/\0/g, '').trim();
  if (text.length > TEXT_LIMIT) { text = text.slice(0, TEXT_LIMIT); warning = [warning, '본문이 길어 앞 40,000자만 사용합니다.'].filter(Boolean).join(' '); }
  if (!text && !images.length) throw new Error('읽을 수 있는 내용이 없습니다. 사진 파일로 연결하거나 원문을 직접 입력해주세요.');
  return { kind, text, images, warning };
}
export async function parseAttachment(data: Buffer, extension: string): Promise<ParsedAttachment> {
  if (!SUPPORTED_EXTENSIONS.includes(extension)) throw new Error('PNG·JPG·WebP, PDF, DOC·DOCX, HWP·HWPX, TXT·MD·CSV 파일을 지원합니다.');
  if (!data.length || data.length > MAX_FILE_BYTES) throw new Error('파일은 비어 있지 않은 10MB 이하로 선택해주세요.');
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
    const png = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const webp = data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
    if (!(['png'].includes(extension) ? png : ['jpg', 'jpeg'].includes(extension) ? jpeg : webp)) throw new Error('이미지 내용과 확장자가 일치하지 않습니다. PNG·JPG·WebP로 다시 저장해주세요.');
    const image = await loadImage(data);
    if (image.width * image.height > 40_000_000) throw new Error('사진이 너무 큽니다. 크기를 줄여 다시 연결해주세요.');
    const scale = Math.min(1, 2000 / Math.max(image.width, image.height));
    const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return finish('image', '', [canvas.toBuffer('image/png')]);
  }
  if (extension === 'pdf') {
    // Keep native ESM import intact in the CommonJS Electron main build.
    const pdfjs = await require('./pdf-loader.cjs')(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const loading = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true,
      cMapUrl: path.join(root, 'cmaps') + path.sep, cMapPacked: true, standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep, wasmUrl: path.join(root, 'wasm') + path.sep, verbosity: 0 });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > 5) throw new Error('PDF는 한 파일당 5쪽까지 지원합니다. 필요한 쪽만 분리해서 연결해주세요.');
      const pages: string[] = []; const images: Buffer[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        pages.push(`[${n}쪽]\n` + content.items.map((item: { str?: string; hasEOL?: boolean }) => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join(''));
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(original.width, original.height)) });
        const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
        images.push(canvas.toBuffer('image/png')); page.cleanup();
      }
      return finish('pdf', pages.join('\n\n'), images);
    } finally { await loading.destroy(); }
  }
  if (extension === 'hwp' || extension === 'hwpx') {
    return finish('document', extension === 'hwp' ? hwpText(data) : await hwpxText(data), [], '한글 문서는 본문·표의 텍스트만 참고합니다. 수식·삽입 그림·배치는 누락될 수 있으므로 필요한 부분은 PDF 또는 사진으로 연결해주세요.');
  }
  if (extension === 'doc') {
    const document = await new WordExtractor().extract(data);
    return finish('document', document.getBody(), [], 'DOC는 본문 텍스트만 참고합니다. 수식·사진·도형은 PDF 또는 이미지로 연결해주세요.');
  }
  if (extension === 'docx') {
    const result = await mammoth.extractRawText({ buffer: data });
    return finish('document', result.value, [], 'DOCX는 본문 텍스트만 참고합니다. 수식·삽입된 사진·도형은 별도 이미지로 연결해주세요.');
  }
  let text: string;
  try { text = new TextDecoder(data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : 'utf-8', { fatal: true }).decode(data); }
  catch { try { text = new TextDecoder('euc-kr', { fatal: true }).decode(data); } catch { throw new Error('문자 인코딩을 읽지 못했습니다. UTF-8 텍스트로 저장해주세요.'); } }
  if (text.includes('\0')) throw new Error('텍스트 파일로 읽을 수 없습니다. 지원되는 파일을 선택해주세요.');
  return finish('text', text, []);
}
