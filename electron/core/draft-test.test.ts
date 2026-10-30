import { describe, expect, it, vi } from 'vitest';
import { createConversationDraft, createTestDraft } from './draft-test';
import type { ChatMessage, Settings, Snapshot } from '../../shared/types';
describe('visible Codex generation check', () => {
  it('uses synthetic messages, the common prompt, and app-only delivery', async () => {
    const settings: Settings = { room: '실제 비공개 채팅방', prompt: '내 공통 프롬프트', codexPath: '', model: '', delivery: 'kakao' };
    const generate = vi.fn(async (_m: ChatMessage[], _s: Settings, _signal: AbortSignal) => '내일 몇 시에 볼까?');
    const draft = await createTestDraft(settings, generate, new AbortController().signal);
    expect(generate.mock.calls[0][0]).toHaveLength(2);
    expect(JSON.stringify(generate.mock.calls[0][0])).not.toContain(settings.room);
    expect(generate.mock.calls[0][1]).toMatchObject({ room: '가상 대화 테스트', prompt: settings.prompt, delivery: 'app' });
    expect(draft).toMatchObject({ text: '내일 몇 시에 볼까?', test: true, delivery: 'local' });
  });
  it('does not expose a late result after the test is cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createTestDraft({ room: '', prompt: '', codexPath: '', model: '', delivery: 'app' }, async () => '늦은 결과', controller.signal)).rejects.toThrow('취소');
  });
  it('records the model actually requested for this result, including resolved auto selections', async () => {
    const draft = await createTestDraft({ room: '', prompt: '규칙', codexPath: '', model: '', delivery: 'app' }, async () => ({ text: '테스트 답장', model: 'example-resolved' }), new AbortController().signal);
    expect(draft.model).toBe('example-resolved');
  });
});

describe('manual draft from a real chat snapshot', () => {
  const settings: Settings = { room: '나와의 대화', prompt: '내 공통 프롬프트', codexPath: '', model: 'test-model', effort: 'medium', delivery: 'kakao' };
  const capture = (): Snapshot => ({ status: 'ready', chatKind: 'self', room: settings.room, capturedAt: Date.now(), messages: Array.from({ length: 25 }, (_, i) => ({ id: `real-${i}`, direction: 'outgoing', sender: '나', text: `읽어온 실제 본문 ${i}`, time: '' })) });
  it('reads fresh real context, caps it at 20, and only interprets the final self message as incoming', async () => {
    const snapshot = capture(); const read = vi.fn(async () => snapshot);
    const generate = vi.fn(async (_messages: ChatMessage[], _settings: Settings, _signal: AbortSignal) => ({ text: '실제 대화 기반 답장', model: 'resolved-model', effort: 'medium' }));
    const draft = await createConversationDraft(settings, read, generate, new AbortController().signal);
    expect(read).toHaveBeenCalledOnce();
    const [messages, effective] = generate.mock.calls[0];
    expect(messages).toHaveLength(20); expect(messages[0].id).toBe('real-5');
    expect(messages.at(-1)).toMatchObject({ text: '읽어온 실제 본문 24', direction: 'incoming' });
    expect(messages.slice(0, -1).every(message => message.direction === 'outgoing')).toBe(true);
    expect(snapshot.messages.at(-1)?.direction).toBe('outgoing');
    expect(effective).toMatchObject({ prompt: settings.prompt, room: settings.room, delivery: 'app' });
    expect(draft).toMatchObject({ test: true, testSource: 'conversation', delivery: 'local', room: settings.room, model: 'resolved-model', effort: 'medium' });
  });
  it('never falls back to fabricated inputs on a closed, empty or mismatched room', async () => {
    const generate = vi.fn(async () => '초안');
    for (const snapshot of [{ ...capture(), status: 'room_closed' as const }, { ...capture(), messages: [] }, { ...capture(), room: '다른 방' }]) {
      await expect(createConversationDraft(settings, async () => snapshot, generate, new AbortController().signal)).rejects.toThrow();
    }
    expect(generate).not.toHaveBeenCalled();
  });
  it('does not publish a cancelled result or reinterpret outgoing messages in a real direct chat', async () => {
    const controller = new AbortController();
    await expect(createConversationDraft(settings, async () => capture(), async () => { controller.abort(); return '취소된 답장'; }, controller.signal)).rejects.toThrow('취소');
    const generate = vi.fn(async () => '초안');
    await expect(createConversationDraft(settings, async () => ({ ...capture(), chatKind: 'direct' }), generate, new AbortController().signal)).rejects.toThrow('상대 메시지');
    expect(generate).not.toHaveBeenCalled();
  });
});

it('targets a registered group questioner and rejects changed conversations or teacher messages for manual generation', async () => {
  const settings: Settings = { room: '수학방', prompt: '', codexPath: '', model: '', delivery: 'app', participants: { questioners: ['학생'], teachers: ['선생님'] } };
  const snapshot: Snapshot = { status: 'ready', room: settings.room, chatKind: 'group', capturedAt: 1, messages: [{ id: 'a', sender: '학생', text: '설명해주세요', direction: 'incoming', time: '' }] };
  const generate = vi.fn(async (_m: ChatMessage[], _s: Settings, _signal: AbortSignal) => '설명 초안');
  const draft = await createConversationDraft(settings, async () => snapshot, generate, new AbortController().signal);
  expect(draft.targetSender).toBe('학생'); expect(generate.mock.calls[0][1].replyTarget?.sender).toBe('학생');
  const changed = { ...snapshot, messages: [...snapshot.messages, { id: 'b', sender: '선생님', text: '확인할게', direction: 'incoming' as const, time: '' }] };
  const read = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(changed);
  await expect(createConversationDraft(settings, read, generate, new AbortController().signal)).rejects.toThrow('바뀌었습니다');
  await expect(createConversationDraft(settings, async () => changed, generate, new AbortController().signal)).rejects.toThrow('등록된 질문자');
});

it('applies saved participant rules to direct-chat manual drafts as well as automatic drafts', async () => {
  const settings: Settings = { room: '개별 수업방', prompt: '', codexPath: '', model: '', delivery: 'app', participants: { questioners: ['학생'], teachers: ['선생님', '나'] } };
  const snapshot: Snapshot = { status: 'ready', room: settings.room, chatKind: 'direct', capturedAt: 1, messages: [{ id: 'q', sender: '미등록 참여자', text: '문의', direction: 'incoming', time: '' }] };
  const generate = vi.fn(async () => '잘못된 초안');
  await expect(createConversationDraft(settings, async () => snapshot, generate, new AbortController().signal)).rejects.toThrow('등록된 질문자');
  expect(generate).not.toHaveBeenCalled();
});

it('discards a participant-targeted manual draft when a teacher answers during generation in a direct chat', async () => {
  const settings: Settings = { room: '개별 수업방', prompt: '', codexPath: '', model: '', delivery: 'app', participants: { questioners: ['학생'], teachers: ['선생님', '나'] } };
  const snapshot: Snapshot = { status: 'ready', room: settings.room, chatKind: 'direct', capturedAt: 1, messages: [{ id: 'q', sender: '학생', text: '문의', direction: 'incoming', time: '' }] };
  const after: Snapshot = { ...snapshot, messages: [...snapshot.messages, { id: 't', sender: '선생님', text: '답변', direction: 'incoming', time: '' }] };
  const read = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(after);
  const generate = vi.fn(async (_messages: ChatMessage[], s: Settings) => { expect(s.replyTarget?.sender).toBe('학생'); return '늦은 초안'; });
  await expect(createConversationDraft(settings, read, generate, new AbortController().signal)).rejects.toThrow('바뀌었습니다');
});

it('keeps the synthetic CLI connection check isolated from real participant/reply-target settings', async () => {
  const settings: Settings = { room: '실제 방', prompt: '공통 규칙', codexPath: '', model: '', delivery: 'app', participants: { questioners: ['실제 질문자'], teachers: ['실제 선생님'] }, replyTarget: { sender: '실제 질문자', messages: [{ id: 'private', sender: '실제 질문자', direction: 'incoming', text: '실제 메시지', time: '' }] } };
  const generate = vi.fn(async (_messages: ChatMessage[], s: Settings) => { expect(s.participants).toBeUndefined(); expect(s.replyTarget).toBeUndefined(); return '연결 시험'; });
  await createTestDraft(settings, generate, new AbortController().signal);
});

it('preserves the actual self-chat attachment identity when the final photo becomes a manual question', async () => {
  const settings: Settings = { room: 'self', prompt: '', codexPath: '', model: '', delivery: 'app' };
  const photo: ChatMessage = { id: 'self-photo', text: '', sender: '나', direction: 'outgoing', time: '', attachments: [{ id: 'media-0', kind: 'image' }] };
  const { assertMediaReady } = await import('../../shared/media');
  const { promptFor } = await import('../codex');
  const contexts = [{ question: photo, references: [], note: '', updatedAt: 1, attachments: [{ id: 'original', name: 'photo.jpeg', kind: 'image' as const, size: 1, imageCount: 1, excerpt: '', source: { message: photo, attachmentId: 'media-0' } }] }];
  const draft = await createConversationDraft(settings, async () => ({ room: 'self', status: 'ready', capturedAt: 1, chatKind: 'self', messages: [photo] }), async (messages, effective) => {
    expect(messages[0].direction).toBe('incoming');
    expect(effective.materialMessages?.[0]).toEqual(photo);
    expect(() => assertMediaReady(messages, contexts)).toThrow();
    assertMediaReady(effective.materialMessages!, contexts);
    expect(() => promptFor(messages, { ...effective, contexts: contexts.map(c => ({ ...c, documents: [], images: [] })) })).not.toThrow();
    return { text: '사진 기반 답장', contexts };
  }, new AbortController().signal);
  expect(draft.contexts?.[0].attachments[0].source?.message.direction).toBe('outgoing');
});
