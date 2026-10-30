import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { open, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AttachmentInfo, AttachmentSource, ChatMessage, PreparedContext, QuestionContext } from '../shared/types';
import type { ParsedAttachment } from './attachment-parser';
const MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'doc', 'docx', 'hwp', 'hwpx', 'txt', 'md', 'csv'];
interface FileRecord extends AttachmentInfo { text: string; images: string[]; }
interface RecordContext { room: string; context: QuestionContext; files: FileRecord[]; }
export function publicContext(context: PreparedContext): QuestionContext {
  const { documents: _documents, images: _images, ...value } = context; return structuredClone(value);
}
export class QuestionContexts {
  private records: RecordContext[] = [];
  private pending = new Set<string>();
  readonly directory: string;
  constructor(root: string, private parse = parseFile) {
    this.directory = path.join(root, 'question-materials'); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(readFileSync(path.join(this.directory, 'contexts.json'), 'utf8'));
      if (Array.isArray(stored)) this.records = stored.filter(r => typeof r.room === 'string' && r.context?.question?.id && Array.isArray(r.context.attachments) && Array.isArray(r.files)).slice(-100);
    } catch { /* New profile or unavailable context data; never inspect unrelated paths. */ }
    this.pruneFiles();
  }
  views(room: string) { return this.records.filter(r => r.room === room).map(r => structuredClone(r.context)); }
  private find(room: string, id: string) { return this.records.find(r => r.room === room && r.context.question.id === id); }
  private ensure(room: string, question: ChatMessage) {
    let record = this.find(room, question.id);
    if (!record) {
      record = { room, context: { question: { ...question }, references: [], note: '', attachments: [], updatedAt: Date.now() }, files: [] };
      this.records.push(record);
    }
    return record;
  }
  save(room: string, question: ChatMessage, references: ChatMessage[], note: string) {
    if (typeof note !== 'string' || note.length > 10000 || note.includes('\0') || references.length > 10) throw new Error('원문은 최대 10개, 직접 입력한 내용은 10,000자까지 연결할 수 있습니다.');
    const record = this.ensure(room, question);
    const previous = record.context;
    record.context = { ...record.context, references: references.map(m => ({ ...m })), note, updatedAt: Date.now() };
    try { this.persist(); } catch (error) { record.context = previous; throw error; }
  }
  async attach(room: string, question: ChatMessage, paths: string[], source?: AttachmentSource, valid: () => boolean = () => true) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 4 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('질문 하나에 파일을 최대 4개 연결할 수 있습니다.');
    const record = this.ensure(room, question);
    if (record.files.length + paths.length > 4) throw new Error('질문 하나에 파일을 최대 4개 연결할 수 있습니다.');
    const added: FileRecord[] = [];
    try {
      for (const filePath of paths) {
        const extension = path.extname(filePath).slice(1).toLowerCase();
        if (!EXTENSIONS.includes(extension)) throw new Error('PNG·JPG·WebP, PDF, DOC·DOCX, HWP·HWPX, TXT·MD·CSV 파일을 지원합니다.');
        const file = await open(filePath, 'r');
        let bytes: Buffer;
        try { const stat = await file.stat(); if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error('파일은 비어 있지 않은 10MB 이하로 선택해주세요.'); bytes = Buffer.alloc(stat.size); const read = await file.read(bytes, 0, bytes.length, 0); if (read.bytesRead !== bytes.length) throw new Error('파일이 변경됐습니다. 다시 선택해주세요.'); }
        finally { await file.close(); }
        const id = randomUUID(), folder = path.join(this.directory, id);
        await mkdir(folder, { mode: 0o700 }); this.pending.add(id);
        try {
          const sourceFile = path.join(folder, `source.${extension}`); await writeFile(sourceFile, bytes, { mode: 0o600 });
          const parsed = await this.parse(sourceFile, extension);
          const images: string[] = [];
          for (let i = 0; i < parsed.images.length; i++) { const name = `page-${i + 1}.png`; await writeFile(path.join(folder, name), parsed.images[i], { mode: 0o600 }); images.push(name); }
          added.push({ ...(source ? { source: structuredClone(source) } : {}), id, name: path.basename(filePath).slice(0, 200), kind: parsed.kind, size: bytes.length, imageCount: images.length, excerpt: parsed.text.slice(0, 300), warning: parsed.warning, text: parsed.text, images });
        } catch (error) { this.pending.delete(id); await rm(folder, { recursive: true, force: true }); throw error; }
      }
      // Room removal / clear while a parser is running invalidates the import.
      if (!valid() || this.find(room, question.id) !== record || record.files.length + added.length > 4) throw new Error('질문 또는 자료가 변경됐습니다. 다시 선택해주세요.');
      const previousFiles = record.files.slice(), previousContext = structuredClone(record.context);
      record.files.push(...added); this.sync(record);
      try { this.persist(); } catch (error) { record.files = previousFiles; record.context = previousContext; throw error; }
      for (const f of added) this.pending.delete(f.id);
    } catch (error) { for (const f of added) { this.pending.delete(f.id); await rm(path.join(this.directory, f.id), { recursive: true, force: true }); } throw error; }
  }
  link(room: string, questionId: string, fileId: string, source?: AttachmentSource) {
    const record = this.find(room, questionId), file = record?.files.find(f => f.id === fileId);
    if (!record || !file) throw new Error('연결할 자료 파일을 찾지 못했습니다.');
    const previous = file.source, previousContext = structuredClone(record.context);
    file.source = source ? structuredClone(source) : undefined; this.sync(record);
    try { this.persist(); } catch (error) { file.source = previous; record.context = previousContext; throw error; }
  }
  remove(room: string, questionId: string, attachmentId: string) {
    const record = this.find(room, questionId); if (!record) return;
    const previousFiles = record.files, previousContext = structuredClone(record.context);
    record.files = record.files.filter(f => f.id !== attachmentId); this.sync(record);
    try { this.persist(); } catch (error) { record.files = previousFiles; record.context = previousContext; throw error; }
  }
  removeRoom(room: string) { const previous = this.records; this.records = this.records.filter(r => r.room !== room); try { this.persist(); } catch (error) { this.records = previous; throw error; } }
  clear() { const previous = this.records; this.records = []; try { this.persist(); } catch (error) { this.records = previous; throw error; } }
  private sync(record: RecordContext) {
    record.context.attachments = record.files.map(({ text: _text, images: _images, ...info }) => info); record.context.updatedAt = Date.now();
  }
  prepare(room: string, messages: ChatMessage[], recent: ChatMessage[] = []): PreparedContext[] {
    const ids = new Set(messages.map(m => m.id));
    const selected = this.records.filter(r => r.room === room && ids.has(r.context.question.id));
    const sourceIds = new Set([...recent, ...messages, ...selected.flatMap(r => r.context.references)].map(m => m.id));
    const groups = selected.map(record => ({ context: structuredClone(record.context), files: record.files }));
    const used = new Set(selected.flatMap(r => r.files.map(f => f.id)));
    // Reuse only explicitly mapped attachment data, never another question's notes or unbound files.
    for (const record of this.records.filter(r => r.room === room)) for (const file of record.files) {
      if (used.has(file.id) || !file.source || !sourceIds.has(file.source.message.id)) continue;
      used.add(file.id);
      const { text: _text, images: _images, ...info } = file;
      groups.push({ context: { question: structuredClone(file.source.message), references: [], note: '', attachments: [info], updatedAt: record.context.updatedAt }, files: [file] });
    }
    let imageCount = 0;
    return groups.map(({ context, files }) => {
      const images = files.flatMap(file => {
        if (!/^[a-f0-9-]{36}$/.test(file.id)) throw new Error('자료 식별자를 확인하지 못했습니다. 다시 연결해주세요.');
        return file.images.map(name => {
          if (!/^page-\d+\.png$/.test(name)) throw new Error('자료 파일 이름을 확인하지 못했습니다.');
          imageCount++; if (imageCount > 12) throw new Error('한 초안에 사진·PDF 페이지는 합계 12장까지 사용할 수 있습니다. 자료를 줄여주세요.');
          return { name: file.name, path: path.join(this.directory, file.id, name) };
        });
      });
      return { ...context, documents: files.filter(f => f.text).map(f => ({ name: f.name, text: f.text })), images };
    });
  }
  private persist() {
    const next = this.records.slice(-100);
    const file = path.join(this.directory, 'contexts.json');
    writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 }); renameSync(file + '.tmp', file); this.records = next; this.pruneFiles();
  }
  private pruneFiles() {
    const used = new Set(this.records.flatMap(r => r.files.map(f => f.id)));
    for (const item of readdirSync(this.directory, { withFileTypes: true })) if (item.isDirectory() && /^[a-f0-9-]{36}$/.test(item.name) && !used.has(item.name) && !this.pending.has(item.name)) { try { rmSync(path.join(this.directory, item.name), { recursive: true, force: true }); } catch { /* Retry orphan cleanup on the next save; metadata is already durable. */ } }
  }
}
export function parseFile(filePath: string, extension: string): Promise<ParsedAttachment> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'attachment-worker.js'), { workerData: { path: filePath, extension }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let settled = false;
    const finish = (error?: Error, result?: ParsedAttachment) => {
      if (settled) return; settled = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('자료 읽기에 시간이 오래 걸립니다. 파일을 줄이거나 필요한 쪽을 사진으로 연결해주세요.')), 25000);
    worker.once('message', message => finish(message.error ? new Error(message.error) : undefined, message.result));
    worker.once('error', () => finish(new Error('자료를 읽지 못했습니다. 파일 형식과 손상 여부를 확인해주세요.')));
    worker.once('exit', () => finish(new Error('자료 읽기가 중단됐습니다. 파일을 다시 연결해주세요.')));
  });
}
