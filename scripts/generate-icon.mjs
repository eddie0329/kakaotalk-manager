import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
// The product icon is drawn in code to match the interface's speech-bubble mark.
const size = 512, pixels = Buffer.alloc((size * 4 + 1) * size);
const rounded = (x, y, x0, y0, w, h, r) => {
  const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r));
  const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r));
  return dx * dx + dy * dy <= r * r;
};
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = y * (size * 4 + 1) + 1 + x * 4;
  if (!rounded(x, y, 12, 12, 488, 488, 110)) continue;
  const shade = y / size;
  let color = [44 - shade * 8, 98 - shade * 12, 78 - shade * 5];
  const outer = rounded(x, y, 127, 143, 247, 207, 81);
  const inner = rounded(x, y, 147, 163, 207, 167, 61);
  const tail = y >= 300 && y <= 379 && x >= 132 && x <= 220 && x <= 132 + (379 - y) * 1.1;
  const tailCut = y >= 302 && y <= 346 && x >= 153 && x <= 202 && x <= 153 + (346 - y);
  if ((outer && !inner) || (tail && !tailCut)) color = [244, 248, 237];
  if ((x - 370) ** 2 + (y - 137) ** 2 < 20 ** 2) color = [208, 225, 177];
  pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
}
const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([n, t, data, c]); };
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
