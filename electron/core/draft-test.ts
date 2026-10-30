import { randomUUID } from 'node:crypto';
import type { ChatMessage, Draft, Settings, Snapshot } from '../../shared/types';
import type { MonitorDependencies } from './monitor';

export async function createTestDraft(settings: Settings, generate: MonitorDependencies['generate'], signal: AbortSignal): Promise<Draft> {
  if (signal.aborted) throw new Error('테스트를 취소했습니다.');
  const room = '가상 대화 테스트';
  const messages: ChatMessage[] = [
    { id: 'test-1', direction: 'outgoing', sender: '나', text: '요즘 잘 지내? 오랜만에 같이 밥 먹자!', time: '오후 12:00' },
    { id: 'test-2', direction: 'incoming', sender: room, text: '좋아! 내일 점심 시간 괜찮아?', time: '오후 12:01' }
  ];
  const reply = await generate(messages, { ...settings, room, participants: undefined, personPrompts: undefined, rewrite: undefined, replyTarget: undefined, contexts: undefined, delivery: 'app' }, signal);
  const text = (typeof reply === 'string' ? reply : reply.text).trim();
  if (signal.aborted) throw new Error('테스트를 취소했습니다.');
  if (!text) throw new Error('Codex가 빈 초안을 반환했습니다.');
  return { id: randomUUID(), room, text, createdAt: Date.now(), delivery: 'local', test: true, testSource: 'synthetic', model: (typeof reply === 'string' ? settings.model : reply.model) || undefined, effort: (typeof reply === 'string' ? settings.effort : reply.effort) || undefined };
}

/** Manual, app-only test using a fresh real snapshot. Never feeds the automatic delivery path. */
export async function createConversationDraft(settings: Settings, read: () => Promise<Snapshot>, generate: MonitorDependencies['generate'], signal: AbortSignal): Promise<Draft> {
  if (signal.aborted) throw new Error('테스트를 취소했습니다.');
  const snapshot = await read();
  if (signal.aborted) throw new Error('테스트를 취소했습니다.');
  if (snapshot.status !== 'ready' || snapshot.room !== settings.room) throw new Error(snapshot.detail || '선택한 채팅방을 읽지 못했습니다. 연결을 확인해주세요.');
  const messages = snapshot.messages.slice(-20).map(message => ({ ...message }));
  const last = messages.at(-1);
  if (!last || (!last.text.trim() && !last.attachments?.length)) throw new Error('읽을 수 있는 최근 대화가 없습니다. 카카오톡에 메시지를 남긴 뒤 다시 시도해주세요.');
  if (snapshot.chatKind === 'self') {
    // Self chat cannot distinguish phone/desktop senders. For this explicit manual test only,
    // interpret the final message as the counterpart's input; never alter the saved transcript.
    last.direction = 'incoming'; last.sender = settings.room;
  } else if (last.direction !== 'incoming') throw new Error('실제 대화에서는 마지막 메시지가 상대 메시지일 때 생성해주세요.');
  if (snapshot.chatKind === 'group' && (!settings.participants?.questioners.length || !settings.participants.teachers.length)) throw new Error('단체방의 질문자와 선생님을 먼저 등록해주세요.');
  const target = snapshot.chatKind !== 'self' && settings.participants ? last : undefined;
  if (target && !settings.participants?.questioners.includes(target.sender)) throw new Error('참여자를 지정한 방은 마지막 메시지가 등록된 질문자의 메시지일 때 수동 생성할 수 있습니다.');
  const replyTarget = target ? { sender: target.sender, messages: [{ ...target }] } : undefined;
  const reply = await generate(messages, { ...settings, materialMessages: snapshot.chatKind === 'self' ? structuredClone(snapshot.messages.slice(-20)) : undefined, replyTarget, delivery: 'app' }, signal);
  if (target) {
    const latest = await read();
    if (latest.status !== 'ready' || latest.room !== settings.room || JSON.stringify(latest.messages.slice(-20)) !== JSON.stringify(snapshot.messages.slice(-20))) throw new Error('생성 중 대화가 바뀌었습니다. 최신 대화로 다시 생성해주세요.');
  }
  if (signal.aborted) throw new Error('테스트를 취소했습니다.');
  const text = (typeof reply === 'string' ? reply : reply.text).trim();
  if (!text) throw new Error('Codex가 빈 초안을 반환했습니다.');
  return { id: randomUUID(), room: settings.room, text, createdAt: Date.now(), delivery: 'local', test: true, testSource: 'conversation', contexts: typeof reply === 'string' ? undefined : reply.contexts, ...(replyTarget ? { targetSender: replyTarget.sender, targetMessages: replyTarget.messages } : {}), model: (typeof reply === 'string' ? settings.model : reply.model) || undefined, effort: (typeof reply === 'string' ? settings.effort : reply.effort) || undefined };
}
