import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RoomCollection } from './rooms';
import { Store } from '../store';
import { DraftAutosave } from '../draft-autosave';
import { ContactSender } from '../contact-send';
import type { ChatMessage, Draft, Settings, Snapshot } from '../../shared/types';

const directories: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'reply-note-combined-')); directories.push(directory);
  const store = new Store(directory);
  const settings: Settings = { room: 'C', prompt: '공통 규칙', model: '', codexPath: '', delivery: 'app' };
  store.value.settings = settings; store.value.roomNames = ['A', 'B', 'C'];
  store.value.participantsByRoom = { A: { questioners: ['A1', 'A2'], teachers: ['TA', '나'] }, B: { questioners: ['B1', 'B2'], teachers: ['TB', '나'] } };
  const snapshots = new Map<string, Snapshot>();
  const generate = vi.fn(async (_messages: ChatMessage[], s: Settings) => `${s.room}:${s.replyTarget?.sender ?? '상대'} 답장`);
  const collection = new RoomCollection(settings, room => ({
    generate, recheck: async () => snapshots.get(room)!, changed: vi.fn(),
    teacherResponded: (sender, at) => store.markTeacherResponse(room, sender, at),
    publish: async draft => { store.value.drafts.unshift(draft); store.value.messagesByRoom = collection.histories(); store.save(); }
  }));
  for (const room of store.value.roomNames) collection.add(room, [], store.value.participantsByRoom[room]);
  const append = (room: string, sender: string, direction: ChatMessage['direction'] = 'incoming') => {
    const old = snapshots.get(room)?.messages ?? [];
    const snapshot: Snapshot = { status: 'ready', room, chatKind: room === 'C' ? 'direct' : 'group', capturedAt: Date.now(), messages: [...old, { id: `${room}:${old.length}`, text: `${room} ${sender} 메시지`, sender, direction, time: '' }] };
    snapshots.set(room, snapshot); collection.get(room)!.ingest(snapshot);
  };
  collection.startAll(); append('A', 'TA'); append('B', 'TB'); append('C', '나', 'outgoing'); store.save();
  return { store, collection, append, generate };
}
describe('combined rooms, participants, editing and contact sending', () => {
  it('teacher A cancels only A; B target/provenance/teacher status survive draft autosave and restart', async () => {
    const s = fixture(); s.append('A', 'A1'); s.append('B', 'B1');
    await vi.advanceTimersByTimeAsync(4000); s.append('A', 'A2');
    await vi.advanceTimersByTimeAsync(2000); s.append('A', 'TA');
    await vi.advanceTimersByTimeAsync(4000);
    expect(s.store.value.drafts.map(d => [d.room, d.targetSender])).toEqual([['B', 'B1']]);
    expect(s.generate.mock.calls[0][0].every(m => m.id.startsWith('B:'))).toBe(true);
    const draft = s.store.value.drafts[0]; const autosave = new DraftAutosave(s.store, vi.fn());
    const saved = autosave.update(draft.id, '선생님이 직접 수정한 답장');
    s.append('B', 'TB'); autosave.flush(); await saved;
    const loaded = new Store(s.store.directory);
    expect(loaded.value.drafts[0]).toMatchObject({ room: 'B', targetSender: 'B1', text: '선생님이 직접 수정한 답장', teacherResponse: { sender: 'TB' } });
    expect(loaded.value.drafts[0].targetMessages?.[0].sender).toBe('B1');
    expect(loaded.value.participantsByRoom).toEqual(s.store.value.participantsByRoom);
  });
  it('manual send/rebaseline in direct room C does not cancel group A/B timers or mix their targets', async () => {
    const s = fixture(); s.append('A', 'A1'); s.append('B', 'B1'); s.append('C', '친구');
    const draft: Draft = { id: 'manual-c', room: 'C', text: 'C 답장', createdAt: Date.now(), delivery: 'local' }; s.store.value.drafts.push(draft);
    await vi.advanceTimersByTimeAsync(5000);
    const transport = vi.fn(async () => ({ outcome: 'sent' as const, detail: '확인됨', minimized: true }));
    const sender = new ContactSender(s.store, transport, room => room === 'C', room => { const monitor = s.collection.get(room)!; if (monitor.state.enabled) monitor.start(); }, vi.fn());
    await sender.send(draft.id, 'C 수정 답장');
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.store.value.drafts.filter(d => d.targetSender).map(d => [d.room, d.targetSender]).sort()).toEqual([['A', 'A1'], ['B', 'B1']]);
    expect(s.generate.mock.calls.some(call => call[1].room === 'C')).toBe(false);
    expect(transport).toHaveBeenCalledWith('C', 'C 수정 답장');
  });
  it('editing A rules pauses only A and preserves B settings through common saves and restart', async () => {
    const s = fixture(); s.append('A', 'A1'); s.append('B', 'B1');
    s.collection.setParticipants('A', { questioners: ['A3'], teachers: ['TA'] });
    expect(s.collection.get('A')!.state.enabled).toBe(false); expect(s.collection.get('B')!.state.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(10000); expect(s.store.value.drafts.map(d => d.targetSender)).toEqual(['B1']);
    s.collection.configure({ ...s.store.value.settings, prompt: '변경한 공통 규칙' });
    s.store.value.participantsByRoom = Object.fromEntries(s.collection.participants); s.store.save();
    const loaded = new Store(s.store.directory);
    expect(loaded.value.participantsByRoom.A.questioners).toEqual(['A3']);
    expect(loaded.value.participantsByRoom.B.questioners).toEqual(['B1', 'B2']);
  });
  it('a rejected group send does not reset any questioner jobs or call native sending', async () => {
    const s = fixture(); s.append('A', 'A1'); s.append('B', 'B1');
    s.store.value.drafts.push({ id: 'group', room: 'A', targetSender: 'A1', text: '단체방 초안', createdAt: Date.now(), delivery: 'local' });
    const transport = vi.fn(async () => ({ outcome: 'sent' as const, detail: '', minimized: true }));
    const reset = vi.fn(); const sender = new ContactSender(s.store, transport, room => s.collection.get(room)!.state.chatKind !== 'group', reset, vi.fn());
    await expect(sender.send('group', '단체방 초안')).rejects.toThrow('실제 채팅방');
    expect(reset).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.store.value.drafts.filter(d => d.id !== 'group').map(d => d.targetSender).sort()).toEqual(['A1', 'B1']);
  });
});
