import * as CFB from 'cfb';
import { deflateRawSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
export function materials() {
  const canvas = createCanvas(500, 200), ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0,0,500,200); ctx.fillStyle = 'black'; ctx.font = '40px sans-serif'; ctx.fillText('2 + 3 = ?', 50, 100);
  const hwp = CFB.utils.cfb_new(), header = Buffer.alloc(256); header.write('HWP Document File'); header.writeUInt32LE(0x05000300,32); header.writeUInt32LE(1,36); CFB.utils.cfb_add(hwp,'/FileHeader',header);
  const text = Buffer.from('한글 문제: 이차방정식의 풀이를 설명해주세요.\r','utf16le'), record = Buffer.alloc(4); record.writeUInt32LE((text.length << 20) | 67); CFB.utils.cfb_add(hwp,'/BodyText/Section0',deflateRawSync(Buffer.concat([record,text])));
  const zip = files => { const file = CFB.utils.cfb_new(); for (const [name,text] of Object.entries(files)) CFB.utils.cfb_add(file,name,Buffer.from(text)); return Buffer.from(CFB.write(file,{type:'buffer',fileType:'zip'})); };
  const stream='BT /F1 14 Tf 30 80 Td (Question: 2 + 3 = ?) Tj ET', objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n'; const offsets=[]; objects.forEach((object,i)=>{ offsets.push(Buffer.byteLength(pdf)); pdf+=`${i+1} 0 obj\n${object}\nendobj\n`; }); const start=Buffer.byteLength(pdf); pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return {
    '문제.png': canvas.toBuffer('image/png'), '문제.hwp': Buffer.from(CFB.write(hwp,{type:'buffer'})), '문제.pdf': Buffer.from(pdf),
    '문제.docx': zip({ '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 문서의 문제 설명입니다.</w:t></w:r></w:p></w:body></w:document>' }),
    '문제.hwpx': zip({ 'Contents/section0.xml':'<hs:sec xmlns:hs="urn:sec" xmlns:hp="urn:para"><hp:p><hp:run><hp:t>HWPX 한글 문제 본문입니다.</hp:t></hp:run></hp:p></hs:sec>' })
  };
}
