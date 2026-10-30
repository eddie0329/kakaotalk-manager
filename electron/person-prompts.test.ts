import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { personPromptFor, validPersonPrompts, validatePersonPrompt } from '../shared/person-prompts';
import type { ChatMessage, Settings, Snapshot } from '../shared/types';
import { promptFor } from './codex';
import { Store, defaults } from './store';
import { RoomCollection } from './core/rooms';
import { createConversationDraft, createTestDraft } from './core/draft-test';
import { createContextDraft } from './core/context-draft';
const settings: Settings = { room: 'A', prompt: '짧고 편하게', model: '', codexPath: '', delivery: 'app' };
const incoming = (sender: string, id = sender): ChatMessage => ({ id, sender, direction: 'incoming', text: '안녕하세요', time: '' });
const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const directory = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'reply-note-person-prompts-')); directories.push(d); return d; };
describe('person-specific prompt selection', () => {
  it('adds only the direct recipient instructions, with style precedence and the common prompt retained', () => {
    const s = { ...settings, personPrompts: { A: '정중한 존댓말', B: '친구 말투' } };
    const prompt = promptFor([incoming('A')], s);
    expect(prompt).toContain('정중한 존댓말'); expect(prompt).toContain(settings.prompt); expect(prompt).toContain('개인 지침을 우선');
    expect(prompt).not.toContain('친구 말투');
    expect(personPromptFor([incoming('표시 이름')], s)?.prompt).toBe('정중한 존댓말');
    expect(personPromptFor([incoming('A')], settings)).toBeUndefined();
  });
  it('chooses the explicit group target rather than the last speaker and never falls back to another member', () => {
    const s: Settings = { ...settings, participants: { questioners: ['민수', '지우'], teachers: ['나'] }, personPrompts: { 민수: '존댓말', 지우: '반말', A: '방 이름의 지침' }, replyTarget: { sender: '민수', messages: [incoming('민수')] } };
    expect(personPromptFor([incoming('지우')], s)).toEqual({ sender: '민수', prompt: '존댓말' });
    expect(promptFor([incoming('지우')], s)).not.toContain('반말');
    expect(personPromptFor([incoming('민수')], { ...s, replyTarget: undefined })).toBeUndefined();
    expect(personPromptFor([incoming('지우')], { ...s, replyTarget: { sender: '미등록', messages: [] } })).toBeUndefined();
  });
  it('rejects invalid inputs while retaining other valid profiles and handling special property names literally', () => {
    for (const value of [null, 3, 'x'.repeat(5001), 'a\0b']) expect(() => validatePersonPrompt('이름', value)).toThrow();
    for (const name of ['', 'a\nb', 'a'.repeat(201)]) expect(() => validatePersonPrompt(name, '규칙')).toThrow();
    expect(validatePersonPrompt(' 이름 ', '  ')).toEqual({ name: '이름', prompt: '' });
    expect(validPersonPrompts({ A: '규칙', B: 5 })).toEqual({ A: '규칙' });
    const prompts = validPersonPrompts(JSON.parse('{"__proto__":"정중하게"}'));
    expect(personPromptFor([incoming('__proto__')], { ...settings, personPrompts: prompts })?.prompt).toBe('정중하게');
  });
  it('persists distinct same-name people per room, migrates old files and drops deleted room profiles', () => {
    const store = new Store(directory()); store.value.roomNames = ['A', 'B'];
    store.value.personPromptsByRoom = { A: { 민수: '존댓말' }, B: { 민수: '편하게' } }; store.save();
    const loaded = new Store(store.directory); expect(loaded.value.personPromptsByRoom).toEqual(store.value.personPromptsByRoom);
    loaded.value.roomNames = ['B']; loaded.save(); expect(new Store(store.directory).value.personPromptsByRoom.A).toBeUndefined();
    const old = JSON.parse(readFileSync(path.join(store.directory, 'state.json'), 'utf8')); delete old.personPromptsByRoom;
    writeFileSync(path.join(store.directory, 'state.json'), JSON.stringify(old)); expect(new Store(store.directory).value.personPromptsByRoom.B).toEqual({});
    expect(defaults().personPromptsByRoom).toEqual({});
  });
  it('preserves profiles through common/participant edits and pauses only the affected room', () => {
    const rooms = new RoomCollection(settings, () => ({ generate: vi.fn(async () => '초안'), recheck: vi.fn(), changed: vi.fn(), publish: vi.fn() }));
    rooms.add('A', [], undefined, { A: '존댓말' }); rooms.add('B', [], undefined, { B: '편하게' }); rooms.startAll();
    rooms.setPersonPrompts('A', { A: '격식 있게' }); expect(rooms.get('A')!.state.enabled).toBe(false); expect(rooms.get('B')!.state.enabled).toBe(true);
    rooms.setParticipants('A', { questioners: ['A'], teachers: ['나'] }); rooms.configure({ ...settings, prompt: '새 공통' });
    expect(rooms.views().find(r => r.room === 'A')!.personPrompts).toEqual({ A: '격식 있게' });
    expect(rooms.views().find(r => r.room === 'B')!.personPrompts).toEqual({ B: '편하게' });
    rooms.remove('A'); expect(rooms.personPrompts.has('A')).toBe(false);
  });
  it('applies instructions in automatic, manual conversation and selected-question drafts; synthetic tests isolate them', async () => {
    vi.useFakeTimers(); const s = { ...settings, personPrompts: { A: '존댓말' } };
    let latest: Snapshot = { status: 'ready', chatKind: 'direct', room: 'A', capturedAt: 0, messages: [incoming('A', 'old')] };
    const generate = vi.fn(async (messages: ChatMessage[], effective: Settings) => { expect(personPromptFor(messages, effective)?.prompt).toBe('존댓말'); return '답변입니다'; });
    const rooms = new RoomCollection(s, () => ({ generate, recheck: async () => latest, changed: vi.fn(), publish: vi.fn() }));
    const monitor = rooms.add('A', [], undefined, s.personPrompts); monitor.start(); monitor.ingest(latest);
    latest = { ...latest, messages: [...latest.messages, incoming('A', 'new')] }; monitor.ingest(latest); await vi.advanceTimersByTimeAsync(10000);
    expect(generate).toHaveBeenCalledOnce();
    await createConversationDraft(s, async () => latest, generate, new AbortController().signal);
    await createContextDraft(latest.messages[1], s, async () => latest, generate, new AbortController().signal);
    expect(generate).toHaveBeenCalledTimes(3);
    const synthetic = vi.fn(async (_messages: ChatMessage[], effective: Settings) => { expect(effective.personPrompts).toBeUndefined(); return '연결 시험'; });
    await createTestDraft(s, synthetic, new AbortController().signal); expect(synthetic).toHaveBeenCalledOnce();
  });
});
