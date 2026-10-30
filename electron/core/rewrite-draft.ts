import { randomUUID } from 'node:crypto';
import type { Draft, Settings, Snapshot } from '../../shared/types';
import type { MonitorDependencies } from './monitor';
export function validateRewrite(text: unknown, instruction: unknown) {
  if (typeof text !== 'string' || text.length > 20_000 || text.includes('\0')) throw new Error('수정할 초안은 20,000자 이내로 입력해주세요.');
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 5000 || instruction.includes('\0')) throw new Error('다시 작성할 지시를 1~5,000자로 입력해주세요.');
  return { previousText: text, instruction: instruction.trim() };
}
export async function rewriteDraft(source: Draft, settings: Settings, input: { previousText: string; instruction: string }, read: () => Promise<Snapshot>, generate: MonitorDependencies['generate'], signal: AbortSignal): Promise<Draft> {
  const rewrite = validateRewrite(input.previousText, input.instruction);
  const checkCancelled = () => { if (signal.aborted) throw new Error('재작성을 취소했습니다.'); };
  checkCancelled();
  if (source.room !== settings.room || (source.test && source.testSource !== 'conversation')) throw new Error('선택한 실제 대화의 초안으로 다시 작성해주세요.');
  const before = await read(); checkCancelled();
  if (before.status !== 'ready' || before.room !== source.room) throw new Error(before.detail || '초안의 카톡방을 열고 연결 상태를 확인해주세요.');
  const messages = before.messages.slice(-20).map(m => structuredClone(m));
  if (!messages.length) throw new Error('최근 대화를 확인한 뒤 다시 작성해주세요.');
  let replyTarget = source.targetSender && source.targetMessages?.length
    ? { sender: source.targetSender, messages: structuredClone(source.targetMessages) } : undefined;
  if (!replyTarget) {
    if (before.chatKind === 'group') throw new Error('단체방에서는 답변 대상이 지정된 초안으로 다시 작성해주세요.');
    const counterpart = before.chatKind === 'self' ? { ...messages.at(-1)!, sender: source.room, direction: 'incoming' as const } : [...messages].reverse().find(m => m.direction === 'incoming');
    if (!counterpart?.sender) throw new Error('답변할 상대 메시지를 확인하지 못했습니다.');
    replyTarget = { sender: counterpart.sender, messages: [counterpart] };
  }
  if (replyTarget.messages.some(m => m.sender !== replyTarget.sender || m.direction !== 'incoming')) throw new Error('원본 초안의 답변 대상을 확인하지 못했습니다.');
  const participants = before.chatKind === 'self' ? undefined : settings.participants;
  if (before.chatKind === 'group' && (!participants?.questioners.length || !participants.teachers.length)) throw new Error('단체방의 질문자와 선생님을 먼저 등록해주세요.');
  if (participants && !participants.questioners.includes(replyTarget.sender)) throw new Error('이 초안의 대상이 등록된 질문자에 포함되지 않습니다.');
  const reply = await generate(messages, { ...settings, participants, replyTarget, rewrite, delivery: 'app' }, signal);
  checkCancelled();
  const after = await read(); checkCancelled();
  if (after.status !== 'ready' || after.room !== source.room || after.chatKind !== before.chatKind || JSON.stringify(after.messages.slice(-20)) !== JSON.stringify(before.messages.slice(-20))) throw new Error('재작성 중 대화가 바뀌었습니다. 최신 대화를 확인한 뒤 다시 시도해주세요.');
  const text = (typeof reply === 'string' ? reply : reply.text).trim();
  if (!text) throw new Error('빈 초안이 반환됐습니다. 다시 작성해주세요.');
  return { id: randomUUID(), room: source.room, text, createdAt: Date.now(), delivery: 'local', test: true, testSource: 'conversation', targetSender: replyTarget.sender, targetMessages: replyTarget.messages,
    revision: { parentId: source.id, instruction: rewrite.instruction }, ...(source.teacherResponse ? { teacherResponse: structuredClone(source.teacherResponse) } : {}), contexts: typeof reply === 'string' ? undefined : reply.contexts,
    model: (typeof reply === 'string' ? settings.model : reply.model) || undefined, effort: (typeof reply === 'string' ? settings.effort : reply.effort) || undefined };
}
