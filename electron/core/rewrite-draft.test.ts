import { describe, expect, it, vi } from 'vitest';
import { rewriteDraft, validateRewrite } from './rewrite-draft';
import { createTestDraft } from './draft-test';
import { promptFor } from '../codex';
import type { ChatMessage, Draft, Settings, Snapshot } from '../../shared/types';
const message = (sender: string, id = sender): ChatMessage => ({ id, sender, text: `${sender}의 대화`, direction: sender === '나' ? 'outgoing' : 'incoming', time: '' });
const settings: Settings = { room: '방', prompt: '공통 지침', personPrompts: { 상대: '존댓말 지침' }, model: 'model', codexPath: '', delivery: 'kakao' };
const source: Draft = { id: 'original', room: '방', text: '원래 초안', createdAt: 1, delivery: 'sent', contactSend: { outcome: 'sent', text: '원래 초안', at: 1 } };
const input = { previousText: '사용자가 수정한 현재 초안', instruction: '더 짧고 정중하게' };
const snapshot = (messages = [message('상대'), message('나')]): Snapshot => ({ room: '방', status: 'ready', chatKind: 'direct', messages, capturedAt: 0 });
describe('one-off draft rewriting', () => {
  it('uses fresh context and edited text; creates an unsent child draft and preserves the original', async () => {
    const original = structuredClone(source); const read = vi.fn(async () => snapshot());
    const generate = vi.fn(async (messages: ChatMessage[], s: Settings) => {
      expect(messages).toEqual(snapshot().messages); expect(s.rewrite).toEqual(input);
      expect(s.delivery).toBe('app'); expect(s.personPrompts).toEqual(settings.personPrompts); expect(s.replyTarget?.sender).toBe('상대');
      const prompt = promptFor(messages, s); expect(prompt).toContain('존댓말 지침'); expect(prompt).toContain(input.previousText); expect(prompt).toContain(input.instruction);
      return { text: '새 초안', model: 'resolved', effort: 'medium' };
    });
    const result = await rewriteDraft(source, settings, input, read, generate, new AbortController().signal);
    expect(read).toHaveBeenCalledTimes(2); expect(source).toEqual(original);
    expect(result).toMatchObject({ text: '새 초안', delivery: 'local', revision: { parentId: source.id, instruction: input.instruction }, targetSender: '상대', model: 'resolved' });
    expect(result.id).not.toBe(source.id); expect(result.contactSend).toBeUndefined(); expect(settings).not.toHaveProperty('rewrite');
  });
  it('keeps the original group recipient even when someone else spoke last, including previous teacher status', async () => {
    const group: Settings = { ...settings, participants: { questioners: ['A', 'B'], teachers: ['나'] }, personPrompts: { A: 'A의 존댓말', B: 'B의 반말' } };
    const original: Draft = { ...source, targetSender: 'A', targetMessages: [message('A')], teacherResponse: { sender: '나', at: 4 } };
    const read = async () => ({ ...snapshot([message('B')]), chatKind: 'group' as const });
    const result = await rewriteDraft(original, group, input, read, async (m, s) => { expect(s.replyTarget?.sender).toBe('A'); const p = promptFor(m, s); expect(p).toContain('A의 존댓말'); expect(p).not.toContain('B의 반말'); return 'A의 새 답변'; }, new AbortController().signal);
    expect(result.targetMessages).toEqual(original.targetMessages); expect(result.teacherResponse).toEqual(original.teacherResponse);
    await expect(rewriteDraft(original, { ...group, participants: { questioners: ['B'], teachers: ['나'] } }, input, read, vi.fn(), new AbortController().signal)).rejects.toThrow('등록된 질문자');
  });
  it('caps context at 20 and supports self-chat manually without changing the transcript', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => message('나', `id-${i}`)); const before = snapshot(rows); before.chatKind = 'self';
    const result = await rewriteDraft(source, settings, input, async () => before, async (m, s) => { expect(m).toHaveLength(20); expect(s.replyTarget?.messages[0].direction).toBe('incoming'); return '나와의 대화 수정'; }, new AbortController().signal);
    expect(rows.every(m => m.direction === 'outgoing')).toBe(true); expect(result.targetSender).toBe('방');
  });
  it('discards results when the conversation changes during generation or cancellation arrives', async () => {
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot([message('새 상대')]));
    await expect(rewriteDraft(source, settings, input, read, async () => '늦은 결과', new AbortController().signal)).rejects.toThrow('대화가 바뀌');
    const controller = new AbortController(); const stable = vi.fn(async () => snapshot());
    await expect(rewriteDraft(source, settings, input, stable, async () => { controller.abort(); return '취소 결과'; }, controller.signal)).rejects.toThrow('취소');
    expect(stable).toHaveBeenCalledOnce();
    const generate = vi.fn(); await expect(rewriteDraft(source, settings, input, stable, generate, controller.signal)).rejects.toThrow('취소'); expect(generate).not.toHaveBeenCalled();
  });
  it('rejects synthetic/unavailable/mismatched rooms, missing group targets and blank model replies', async () => {
    const generate = vi.fn(async () => '결과'); const signal = new AbortController().signal;
    await expect(rewriteDraft({ ...source, test: true, testSource: 'synthetic' }, settings, input, async () => snapshot(), generate, signal)).rejects.toThrow('실제 대화');
    for (const state of [{ ...snapshot(), status: 'room_closed' as const }, { ...snapshot(), room: '다른 방' }, snapshot([]), { ...snapshot(), chatKind: 'group' as const }]) await expect(rewriteDraft(source, settings, input, async () => state, generate, signal)).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    await expect(rewriteDraft(source, settings, input, async () => snapshot(), async () => '  ', signal)).rejects.toThrow('빈 초안');
  });
  it('validates one-off instruction bounds but allows rewriting an emptied editor', () => {
    expect(validateRewrite('', ' 새로 써줘 ')).toEqual({ previousText: '', instruction: '새로 써줘' });
    for (const instruction of ['', '  ', null, 'x'.repeat(5001), 'a\0b']) expect(() => validateRewrite('초안', instruction)).toThrow();
    for (const text of [null, 'x'.repeat(20001), 'a\0b']) expect(() => validateRewrite(text, '지시')).toThrow();
  });
  it('orders the one-off instruction after saved styles without changing them or leaking it into connection tests', async () => {
    const s = { ...settings, rewrite: input }; const p = promptFor(snapshot().messages, s);
    expect(p.indexOf('공통 지침')).toBeLessThan(p.indexOf('존댓말 지침'));
    expect(p.indexOf('존댓말 지침')).toBeLessThan(p.indexOf(input.instruction));
    expect(p).toContain('이번 사용자의 지시를 우선'); expect(p).toContain('사실의 근거가 아니다');
    const generate = vi.fn(async (_m: ChatMessage[], effective: Settings) => { expect(effective.rewrite).toBeUndefined(); return '시험'; });
    await createTestDraft(s, generate, new AbortController().signal);
  });
  it('continues to block unresolved images in the context used for rewriting', () => {
    const m = { ...message('상대'), attachments: [{ id: 'photo', kind: 'image' as const }] };
    expect(() => promptFor([m], { ...settings, rewrite: input })).toThrow('사진·파일');
  });
});
