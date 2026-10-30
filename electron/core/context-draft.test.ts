import { describe, expect, it, vi } from 'vitest';
import { createContextDraft } from './context-draft';
import type { ChatMessage, Settings, Snapshot } from '../../shared/types';
const question: ChatMessage = { id: 'old-question', sender: '민수', text: '이 자료 설명해주세요', direction: 'incoming', time: '' };
const settings: Settings = { room: '수학방', prompt: '', codexPath: '', model: '', delivery: 'kakao', participants: { questioners: ['민수'], teachers: ['선생님'] } };
const capture: Snapshot = { room: settings.room, status: 'ready', chatKind: 'group', messages: [{ ...question, id: 'other-message', sender: '선생님' }], capturedAt: 1 };
it('can explicitly regenerate an older selected question with current room context and preserves source metadata', async () => {
  const context = { question, references: [], attachments: [], note: '원문', updatedAt: 1 };
  const generate = vi.fn(async () => ({ text: '초안', contexts: [context] }));
  const result = await createContextDraft(question, settings, async () => capture, generate, new AbortController().signal);
  expect(generate.mock.calls[0][1]).toMatchObject({ replyTarget: { sender: '민수', messages: [question] }, delivery: 'app' });
  expect(result).toMatchObject({ delivery: 'local', targetSender: '민수', contexts: [context] });
});
it('discards results if a teacher or another message arrives during a manual context generation', async () => {
  const read = vi.fn().mockResolvedValueOnce(capture).mockResolvedValueOnce({ ...capture, messages: [...capture.messages, { ...question, id: 'new' }] });
  await expect(createContextDraft(question, settings, read, async () => '초안', new AbortController().signal)).rejects.toThrow('바뀌었습니다');
});
it('never generates when cancelled during the initial read or for an unregistered target', async () => {
  const controller = new AbortController(), generate = vi.fn(async () => '초안');
  await expect(createContextDraft(question, settings, async () => { controller.abort(); return capture; }, generate, controller.signal)).rejects.toThrow('취소');
  expect(generate).not.toHaveBeenCalled();
  await expect(createContextDraft({ ...question, sender: '다른 사람' }, settings, async () => capture, generate, new AbortController().signal)).rejects.toThrow('등록된 질문자');
});
