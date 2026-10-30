import { it, expect } from 'vitest';
import { mkdtemp, writeFile, symlink, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireAttachment } from './attachment-acquisition';
import type { AttachmentSource } from '../shared/types';
import type { Reader } from './reader';
import { QuestionContexts } from './question-context';
const source: AttachmentSource = { message: { id: 'row', text: '', direction: 'outgoing', sender: '나', time: '', attachments: [{ id: 'media-0', kind: 'file', name: '문제.txt' }] }, attachmentId: 'media-0' };
async function fixture(run: (f: { root: string; contexts: QuestionContexts; reader: Reader }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'acquisition-test-'));
  const contexts = new QuestionContexts(root, async () => ({ kind: 'text', text: '문제 본문', images: [] }));
  const reader: Reader = { read: async room => ({ room, status: 'ready', capturedAt: 1, messages: [source.message] }), list: async () => { throw Error('unused'); }, close() {}, exportAttachment: async (_room, _source, dir) => { await writeFile(path.join(dir, '문제.txt'), '문제 본문'); return '문제.txt'; } };
  try { await run({ root, contexts, reader }); } finally { await rm(root, { recursive: true, force: true }); }
}
it('binds a self-chat original to the exact message and cleans its private capture directory', async () => fixture(async f => {
  await acquireAttachment({ ...f, source, room: '나와의 채팅', valid: () => true });
  expect(f.contexts.views('나와의 채팅')[0].attachments[0].source).toEqual(source);
  expect(await readdir(path.join(f.root, 'attachment-captures'))).toEqual([]);
}));
for (const failure of ['traversal', 'symlink', 'multiple', 'wrong-name', 'changed-message', 'removed-room', 'parse-failure']) {
  it(`does not publish material for ${failure}`, async () => fixture(async f => {
    let valid = true;
    f.reader.exportAttachment = async (_room, _source, dir) => {
      if (failure === 'traversal') return '../outside.txt';
      if (failure === 'symlink') { const outside = path.join(f.root, 'outside.txt'); await writeFile(outside, 'private'); await symlink(outside, path.join(dir, '문제.txt')); return '문제.txt'; }
      await writeFile(path.join(dir, failure === 'wrong-name' ? '다른문제.txt' : '문제.txt'), '문제 본문');
      if (failure === 'multiple') await writeFile(path.join(dir, 'extra.txt'), 'extra');
      if (failure === 'removed-room') valid = false;
      return failure === 'wrong-name' ? '다른문제.txt' : '문제.txt';
    };
    if (failure === 'changed-message') f.reader.read = async room => ({ room, status: 'ready', capturedAt: 1, messages: [{ ...source.message, text: 'changed' }] });
    if (failure === 'parse-failure') f.contexts = new QuestionContexts(f.root, async () => { throw Error('parse failed'); });
    await expect(acquireAttachment({ ...f, source, room: 'self', valid: () => valid })).rejects.toThrow();
    expect(f.contexts.views('self').flatMap(c => c.attachments)).toEqual([]);
    expect(await readdir(path.join(f.root, 'attachment-captures'))).toEqual([]);
  }));
}
it('invalidates an import if the room is removed while parsing', async () => fixture(async f => {
  let valid = true;
  f.contexts = new QuestionContexts(f.root, async () => { valid = false; return { kind: 'text', text: '본문', images: [] }; });
  await expect(acquireAttachment({ ...f, source, room: 'self', valid: () => valid })).rejects.toThrow();
  expect(f.contexts.views('self').flatMap(c => c.attachments)).toEqual([]);
}));
