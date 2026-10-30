import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QuestionContexts, publicContext } from './question-context';
import type { ChatMessage } from '../shared/types';
const directories: string[] = [];
const temp = () => { const p = mkdtempSync(path.join(os.tmpdir(), 'reply-note-material-test-')); directories.push(p); return p; };
const question = (id: string, sender = '민수'): ChatMessage => ({ id, sender, direction: 'incoming', text: '위 사진 설명해주세요', time: '' });
afterEach(() => { for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
describe('question-scoped materials', () => {
  it('persists original references and links files only to their exact room and question, never the sender’s next question', async () => {
    const root = temp(), input = path.join(root, '문제.txt'); writeFileSync(input, '문제 원문');
    const parse = vi.fn(async () => ({ kind: 'text' as const, text: '파일 본문', images: [] }));
    const store = new QuestionContexts(root, parse); const q = question('q1'), ref = question('old', '선생님');
    store.save('A', q, [ref], '보충 설명'); await store.attach('A', q, [input]);
    expect(store.prepare('A', [question('next')])).toEqual([]); expect(store.prepare('B', [q])).toEqual([]);
    const prepared = store.prepare('A', [q]); expect(prepared[0].documents).toEqual([{ name: '문제.txt', text: '파일 본문' }]);
    expect(publicContext(prepared[0])).not.toHaveProperty('documents'); expect(publicContext(prepared[0])).not.toHaveProperty('images');
    expect(new QuestionContexts(root, parse).views('A')[0]).toMatchObject({ note: '보충 설명', references: [ref] });
    store.remove('A', q.id, prepared[0].attachments[0].id); expect(store.views('A')[0].attachments).toEqual([]);
    expect(existsSync(input)).toBe(true);
  });
  it('stages actual image resources under random managed paths and removes only app copies on room removal', async () => {
    const root = temp(), input = path.join(root, '이미지.png'); writeFileSync(input, 'fixture');
    const store = new QuestionContexts(root, async () => ({ kind: 'image', text: '', images: [Buffer.from('image')] }));
    const q = question('q'); await store.attach('A', q, [input]);
    const prepared = store.prepare('A', [q])[0]; expect(existsSync(prepared.images[0].path)).toBe(true);
    expect(prepared.images[0].path).not.toBe(input); expect(store.views('A')[0]).not.toHaveProperty('images');
    store.removeRoom('A'); expect(existsSync(prepared.images[0].path)).toBe(false); expect(existsSync(input)).toBe(true);
  });
  it('rejects unsupported files and parser failures without retaining partial imported material', async () => {
    const root = temp(), input = path.join(root, 'broken.pdf'); writeFileSync(input, 'broken');
    const store = new QuestionContexts(root, async () => { throw new Error('손상된 파일'); });
    await expect(store.attach('A', question('q'), [input])).rejects.toThrow('손상');
    expect(store.views('A')[0].attachments).toEqual([]);
    expect(readdirSync(store.directory).filter(name => /^[a-f0-9-]{36}$/.test(name))).toEqual([]);
    await expect(store.attach('A', question('q'), [input + '.exe'])).rejects.toThrow('지원');
  });
  it('does not resurrect a room or cleared question while an import is processing', async () => {
    const root = temp(), input = path.join(root, 'a.txt'); writeFileSync(input, 'text');
    let finish!: (value: { kind: 'text'; text: string; images: Buffer[] }) => void;
    let started!: () => void; const processing = new Promise<void>(r => { started = r; });
    const store = new QuestionContexts(root, async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = store.attach('A', question('q'), [input]); await processing;
    store.clear(); finish({ kind: 'text', text: '본문', images: [] });
    await expect(pending).rejects.toThrow('변경'); expect(store.views('A')).toEqual([]);
    expect(readdirSync(store.directory).filter(name => /^[a-f0-9-]{36}$/.test(name))).toEqual([]);
  });
  it('retains in-flight imports when another question saves or removes material', async () => {
    const root = temp(), input = path.join(root, 'a.txt'); writeFileSync(input, 'text');
    let finish!: (value: { kind: 'text'; text: string; images: Buffer[] }) => void;
    let started!: () => void; const processing = new Promise<void>(r => { started = r; });
    const store = new QuestionContexts(root, async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = store.attach('A', question('q'), [input]); await processing;
    store.save('A', question('other'), [], '다른 설명');
    expect(readdirSync(store.directory).filter(name => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(1);
    finish({ kind: 'text', text: '본문', images: [] }); await pending;
    expect(store.prepare('A', [question('q')])[0].documents[0].text).toBe('본문');
  });
});

it('rolls back source notes and imported file metadata when durable storage fails', async () => {
  const root = temp(), input = path.join(root, 'a.txt'); writeFileSync(input, 'text');
  const store = new QuestionContexts(root, async () => ({ kind: 'text', text: '본문', images: [] }));
  const q = question('q'); store.save('A', q, [], '기존 설명');
  const file = path.join(store.directory, 'contexts.json'); rmSync(file); mkdirSync(file);
  expect(() => store.save('A', q, [], '실패한 설명')).toThrow();
  expect(store.views('A')[0].note).toBe('기존 설명');
  await expect(store.attach('A', q, [input])).rejects.toThrow();
  expect(store.views('A')[0].attachments).toEqual([]); expect(store.prepare('A', [q])[0].documents).toEqual([]);
  expect(readdirSync(store.directory).filter(name => /^[a-f0-9-]{36}$/.test(name))).toEqual([]);
});

it('shares only explicitly matched attachment content across questions, excluding the other question’s notes and unrelated documents', async () => {
  const root = temp(), image = path.join(root, '문제.png'), note = path.join(root, '개인.txt'); writeFileSync(image, 'fixture'); writeFileSync(note, 'fixture');
  const photo: ChatMessage = { ...question('photo'), text: '', attachments: [{ id: 'media-0', kind: 'image' }] };
  const first = question('first'), second = question('second', '지우');
  const store = new QuestionContexts(root, async (_path, extension) => ({ kind: extension === 'png' ? 'image' : 'text', text: extension === 'png' ? '' : '다른 질문의 비공개 설명', images: extension === 'png' ? [Buffer.from('image')] : [] }));
  store.save('A', first, [], '첫 질문에만 적용하는 설명');
  await store.attach('A', first, [image], { message: photo, attachmentId: 'media-0' }); await store.attach('A', first, [note]);
  const prepared = store.prepare('A', [second], [photo, second]);
  expect(prepared).toHaveLength(1); expect(prepared[0].images).toHaveLength(1); expect(prepared[0].note).toBe(''); expect(prepared[0].documents).toHaveLength(0);
  expect(prepared[0].attachments[0].source?.message.id).toBe('photo'); expect(store.prepare('B', [second], [photo])).toHaveLength(0);
  const linked = prepared[0].attachments[0]; store.link('A', first.id, linked.id);
  expect(store.prepare('A', [second], [photo])).toHaveLength(0);
  store.link('A', first.id, linked.id, { message: photo, attachmentId: 'media-0' });
  expect(new QuestionContexts(root).prepare('A', [second], [photo])[0].images).toHaveLength(1);
});
