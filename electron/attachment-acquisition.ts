import { mkdtemp, mkdir, readdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentSource } from '../shared/types';
import { sameMessage } from '../shared/media';
import type { Reader } from './reader';
import type { QuestionContexts } from './question-context';

// Each native save gets an empty private directory. Never guess from Downloads or a filename search.
export async function acquireAttachment(options: {
  reader: Reader; contexts: QuestionContexts; root: string; room: string; source: AttachmentSource;
  valid: () => boolean;
}) {
  const { reader, contexts, room, source, valid } = options;
  if (!reader.exportAttachment) throw new Error('카톡 원본 가져오기는 현재 macOS에서 지원합니다.');
  const media = source.message.attachments?.find(a => a.id === source.attachmentId);
  if (!media || media.kind === 'unknown' || (media.count ?? 1) !== 1 || source.message.attachments?.length !== 1) throw new Error('한 장의 사진 또는 단일 파일만 가져올 수 있습니다. 묶음 사진은 자료 연결을 이용해주세요.');
  if (!valid()) throw new Error('채팅방이 변경됐습니다. 다시 시도해주세요.');
  const root = path.join(options.root, 'attachment-captures');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(path.join(root, 'capture-'));
  try {
    const name = await reader.exportAttachment(room, source, folder);
    if (!name || name !== path.basename(name) || /[\\/\0]/.test(name) || name.startsWith('.')) throw new Error('원본 파일 경로를 확인하지 못했습니다.');
    const entries = await readdir(folder);
    if (entries.length !== 1 || entries[0] !== name) throw new Error('선택한 원본 파일을 고유하게 확인하지 못했습니다.');
    const file = path.join(folder, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 10 * 1024 * 1024) throw new Error('원본은 비어 있지 않은 10MB 이하 파일이어야 합니다.');
    if (media.kind === 'file' && name.normalize('NFC') !== media.name?.normalize('NFC')) throw new Error('저장된 파일 이름이 선택한 첨부와 다릅니다.');
    if (media.kind === 'image' && !/\.(png|jpe?g|webp)$/i.test(name)) throw new Error('저장된 사진 형식을 확인하지 못했습니다.');
    const current = await reader.read(room);
    if (current.status !== 'ready' || !sameMessage(source.message, current.messages.find(m => m.id === source.message.id)) || !valid()) throw new Error('저장 중 대상 대화가 변경됐습니다. 다시 감지해주세요.');
    await contexts.attach(room, source.message, [file], source, valid);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
