import * as CFB from 'cfb';
import { inflateRawSync } from 'node:zlib';
import { fromBuffer, type Entry } from 'yauzl';
import { SaxesParser } from 'saxes';
const MAX_EXPANDED = 20 * 1024 * 1024;

/** HWP 5.0 BodyText records, following Hancom's published file-format specification. */
export function hwpText(data: Buffer): string {
  if (!data.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw new Error('HWP 5.x 문서가 아닙니다. 오래된 HWP는 HWPX 또는 PDF로 저장해주세요.');
  const container = CFB.read(data, { type: 'buffer' });
  const headerEntry = CFB.find(container, '/FileHeader');
  const header = headerEntry?.content ? Buffer.from(headerEntry.content) : Buffer.alloc(0);
  if (header.length < 40 || !header.subarray(0, 17).toString('ascii').startsWith('HWP Document File')) throw new Error('한글 문서의 파일 정보를 읽지 못했습니다.');
  const flags = header.readUInt32LE(36);
  if (flags & (2 | 4 | 16 | 256 | 512)) throw new Error('암호·배포용·보호 설정이 있는 한글 문서는 읽을 수 없습니다. 보호를 해제한 사본이나 PDF로 연결해주세요.');
  const sections = container.FullPaths.map((name, i) => ({ name, entry: container.FileIndex[i] })).filter(item => /\/BodyText\/Section\d+$/.test(item.name)).sort((a, b) => Number(a.name.match(/\d+$/)![0]) - Number(b.name.match(/\d+$/)![0]));
  if (!sections.length) throw new Error('한글 문서의 본문을 찾지 못했습니다. HWPX 또는 PDF로 다시 저장해주세요.');
  const paragraphs: string[] = []; let expanded = 0;
  for (const { entry } of sections) {
    const raw = Buffer.from(entry.content);
    const body = flags & 1 ? inflateRawSync(raw, { maxOutputLength: MAX_EXPANDED - expanded }) : raw;
    expanded += body.length; if (expanded > MAX_EXPANDED) throw new Error('한글 문서 본문이 너무 큽니다. 필요한 부분만 분리해주세요.');
    let offset = 0;
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('한글 본문 레코드가 손상됐습니다.');
      const record = body.readUInt32LE(offset); offset += 4;
      const tag = record & 0x3ff; let size = record >>> 20;
      if (size === 0xfff) { if (offset + 4 > body.length) throw new Error('한글 본문 길이를 확인하지 못했습니다.'); size = body.readUInt32LE(offset); offset += 4; }
      if (offset + size > body.length) throw new Error('한글 본문이 중간에 끊겼습니다.');
      if (tag === 67) {
        const text = body.subarray(offset, offset + size);
        let result = '';
        for (let i = 0; i + 1 < text.length; i += 2) {
          const code = text.readUInt16LE(i);
          if (code >= 32) result += String.fromCharCode(code);
          else if (code === 10 || code === 13) result += '\n';
          else if (code === 24) result += '-';
          else if (code === 30 || code === 31) result += ' ';
          else if (code >= 1 && code <= 23) { if (i + 16 > text.length) throw new Error('한글 제어 문자가 손상됐습니다.'); if (code === 9) result += '\t'; i += 14; }
        }
        paragraphs.push(result);
      }
      offset += size;
    }
  }
  return paragraphs.join('\n');
}

/** Read only section XML entries; never extract arbitrary ZIP paths to disk. */
export function hwpxText(data: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    fromBuffer(data, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new Error('HWPX 문서를 열지 못했습니다. 파일 손상 또는 암호 설정을 확인해주세요.')); return; }
      const sections: { number: number; text: string }[] = []; let total = 0; let entries = 0;
      const fail = (error: Error) => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', () => sections.length ? resolve(sections.sort((a, b) => a.number - b.number).map(s => s.text).join('\n')) : reject(new Error('HWPX 본문을 찾지 못했습니다. 보호 설정을 확인하거나 PDF로 연결해주세요.')));
      zip.on('entry', (entry: Entry) => {
        entries++; if (entries > 10000) { fail(new Error('HWPX 문서 항목이 너무 많습니다.')); return; }
        const match = /^Contents\/section(\d+)\.xml$/i.exec(entry.fileName);
        if (!match) { zip.readEntry(); return; }
        if (entry.generalPurposeBitFlag & 1 || entry.uncompressedSize > MAX_EXPANDED - total) { fail(new Error('암호가 있거나 본문이 너무 큰 HWPX 문서입니다.')); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail(new Error('HWPX 본문을 읽지 못했습니다.')); return; }
          const chunks: Buffer[] = [];
          stream.on('data', chunk => { total += chunk.length; if (total > MAX_EXPANDED) { stream.destroy(); fail(new Error('HWPX 본문이 너무 큽니다.')); } else chunks.push(chunk); });
          stream.on('error', fail);
          stream.on('end', () => {
            try {
              const parser = new SaxesParser({ xmlns: true }); let text = ''; let capture = 0;
              parser.on('doctype', () => { throw new Error('외부 정의가 있는 HWPX 문서는 지원하지 않습니다.'); });
              parser.on('opentag', tag => { if (tag.local === 't') capture++; else if (capture && tag.local === 'tab') text += '\t'; else if (capture && tag.local === 'lineBreak') text += '\n'; });
              parser.on('text', value => { if (capture) text += value; });
              parser.on('cdata', value => { if (capture) text += value; });
              parser.on('closetag', tag => { if (tag.local === 't') capture--; if (['p', 'tc'].includes(tag.local)) text += '\n'; });
              parser.write(Buffer.concat(chunks).toString('utf8')).close();
              sections.push({ number: Number(match[1]), text }); zip.readEntry();
            } catch { fail(new Error('HWPX XML 본문을 해석하지 못했습니다. PDF로 다시 저장해주세요.')); }
          });
        });
      });
      zip.readEntry();
    });
  });
}
