import type { ChatAttachment, ChatMessage, QuestionContext } from './types';
export const attachmentLabel = (a: ChatAttachment) => a.kind === 'image' ? `사진${(a.count ?? 1) > 1 ? ` ${a.count}장` : ''}` : a.kind === 'file' ? a.name || '파일' : '확인되지 않은 첨부';
export const messageLabel = (m: ChatMessage) => [m.text, ...(m.attachments ?? []).map(a => `[${attachmentLabel(a)}]`)].filter(Boolean).join('\n');
export const messageFingerprint = (m: ChatMessage) => JSON.stringify([m.text, m.direction, m.sender, (m.attachments ?? []).map(a => [a.id, a.kind, a.name ?? '', a.count ?? 1])]);
export const sameMessage = (a: ChatMessage, b?: ChatMessage) => !!b && a.id === b.id && messageFingerprint(a) === messageFingerprint(b);
export const attachmentKey = (messageId: string, attachmentId: string) => JSON.stringify([messageId, attachmentId]);
export function attachmentReady(message: ChatMessage, attachment: ChatAttachment, contexts: QuestionContext[]) {
  const files = new Map(contexts.flatMap(c => c.attachments).filter(f => f.source?.message.id === message.id && f.source.attachmentId === attachment.id && sameMessage(f.source.message, message)).map(f => [f.id, f]));
  // A gallery's known count must be fully covered; a single file is never assumed to contain all photos.
  return (attachment.kind === 'image' ? [...files.values()].reduce((n, f) => n + f.imageCount, 0) : files.size) >= Math.max(1, attachment.count ?? 1);
}
export function unresolvedAttachments(messages: ChatMessage[], contexts: QuestionContext[], targets: ChatMessage[] = []) {
  const targetIds = new Set(targets.map(m => m.id));
  const references = contexts.filter(c => targetIds.has(c.question.id)).flatMap(c => c.references);
  const candidates = new Map([...messages, ...references, ...targets].map(m => [m.id, m]));
  return [...candidates.values()].flatMap(message => (message.attachments ?? []).filter(a => !attachmentReady(message, a, contexts)).map(attachment => ({ message, attachment })));
}
export class MaterialRequiredError extends Error {
  constructor(readonly missing: ReturnType<typeof unresolvedAttachments>) {
    super(`사진·파일 ${missing.length}건의 내용 확인이 필요합니다. 대화 속 사진·파일에서 원본을 가져오거나 직접 파일을 선택한 뒤 초안을 만들어주세요.`);
    this.name = 'MaterialRequiredError';
  }
}
export function assertMediaReady(messages: ChatMessage[], contexts: QuestionContext[], targets: ChatMessage[] = []) {
  const missing = unresolvedAttachments(messages, contexts, targets);
  if (missing.length) throw new MaterialRequiredError(missing);
}
