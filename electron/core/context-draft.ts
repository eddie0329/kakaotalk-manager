import { randomUUID } from 'node:crypto';
import type { ChatMessage, Draft, Settings, Snapshot } from '../../shared/types';
import type { MonitorDependencies } from './monitor';
export async function createContextDraft(question: ChatMessage, settings: Settings, read: () => Promise<Snapshot>, generate: MonitorDependencies['generate'], signal: AbortSignal): Promise<Draft> {
  if (signal.aborted) throw new Error('생성이 취소됐습니다.');
  const before = await read();
  if (signal.aborted) throw new Error('생성이 취소됐습니다.');
  if (before.status !== 'ready' || before.room !== settings.room) throw new Error(before.detail || '질문이 있는 채팅방을 열고 연결해주세요.');
  if (question.direction !== 'incoming' || !question.sender) throw new Error('발신자가 확인된 상대 메시지를 선택해주세요.');
  if (settings.participants && !settings.participants.questioners.includes(question.sender)) throw new Error('등록된 질문자의 메시지를 선택해주세요.');
  const reply = await generate(before.messages.slice(-20), { ...settings, replyTarget: { sender: question.sender, messages: [question] }, delivery: 'app' }, signal);
  if (signal.aborted) throw new Error('생성이 취소됐습니다.');
  const after = await read();
  if (signal.aborted) throw new Error('생성이 취소됐습니다.');
  if (after.status !== 'ready' || after.room !== settings.room || JSON.stringify(before.messages) !== JSON.stringify(after.messages)) throw new Error('생성 중 대화가 바뀌었습니다. 최신 대화를 확인한 뒤 다시 생성해주세요.');
  const text = (typeof reply === 'string' ? reply : reply.text).trim();
  if (!text) throw new Error('빈 초안이 반환됐습니다.');
  return { id: randomUUID(), room: settings.room, text, createdAt: Date.now(), delivery: 'local', test: true, testSource: 'conversation', targetSender: question.sender, targetMessages: [question],
    model: typeof reply === 'string' ? settings.model : reply.model, effort: typeof reply === 'string' ? settings.effort : reply.effort, contexts: typeof reply === 'string' ? undefined : reply.contexts };
}
