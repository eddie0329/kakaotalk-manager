import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomCollection } from './rooms';
import type { ChatMessage, Draft, Settings, Snapshot } from '../../shared/types';

const settings: Settings = { room: 'A', prompt: '공통 프롬프트', codexPath: '', model: '', delivery: 'app' };
const msg = (id: string, text: string, direction: ChatMessage['direction'] = 'incoming'): ChatMessage => ({ id, text, direction, sender: direction === 'outgoing' ? '나' : '친구', time: '오후 1:00' });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const snapshots = new Map<string, Snapshot>();
  const drafts: Draft[] = [];
  const generate = vi.fn(async (_messages: ChatMessage[], s: Settings, _signal: AbortSignal) => `${s.room} 초안`);
  const collection = new RoomCollection(settings, room => ({ generate, recheck: async () => snapshots.get(room)!, publish: async draft => { drafts.push(draft); }, changed: vi.fn() }));
  function ingest(room: string, messages: ChatMessage[]) {
    const snapshot: Snapshot = { status: 'ready', room, messages, capturedAt: Date.now() };
    snapshots.set(room, snapshot); collection.get(room)!.ingest(snapshot);
  }
  for (const room of ['A', 'B']) collection.add(room);
  collection.startAll();
  ingest('A', [msg('a0', 'A의 이전 대화')]); ingest('B', [msg('b0', 'B의 이전 대화')]);
  return { collection, ingest, drafts, generate };
}
describe('independent saved conversations', () => {
  it('my answer in A cancels only A while B generates with only B context', async () => {
    const s = fixture();
    s.ingest('A', [msg('a0', 'A의 이전 대화'), msg('a1', 'A의 새 메시지')]);
    s.ingest('B', [msg('b0', 'B의 이전 대화'), msg('b1', 'B의 새 메시지')]);
    s.ingest('A', [msg('a0', 'A의 이전 대화'), msg('a1', 'A의 새 메시지'), msg('a2', '내 답장', 'outgoing')]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.drafts.map(d => d.room)).toEqual(['B']);
    expect(s.generate.mock.calls[0][0].map(m => m.text)).toEqual(['B의 이전 대화', 'B의 새 메시지']);
    expect(s.generate.mock.calls[0][1].prompt).toBe(settings.prompt);
  });
  it('removing A aborts its in-flight job and leaves B running', async () => {
    const s = fixture(); let finishA!: (text: string) => void;
    s.generate.mockImplementationOnce(() => new Promise<string>(resolve => { finishA = resolve; }));
    s.ingest('A', [msg('a0', 'A의 이전 대화'), msg('a1', 'A의 새 메시지')]);
    await vi.advanceTimersByTimeAsync(10_000);
    const signalA = s.generate.mock.calls[0][2];
    s.collection.remove('A'); expect(signalA.aborted).toBe(true); expect(s.collection.get('B')!.state.enabled).toBe(true);
    finishA('취소된 초안'); await vi.advanceTimersByTimeAsync(0); expect(s.drafts).toHaveLength(0);
    s.ingest('B', [msg('b0', 'B의 이전 대화'), msg('b1', 'B의 새 메시지')]);
    await vi.advanceTimersByTimeAsync(10_000); expect(s.drafts.map(d => d.room)).toEqual(['B']);
  });
  it('adding another room does not reset an existing wait timer', async () => {
    const s = fixture(); s.ingest('A', [msg('a0', 'A의 이전 대화'), msg('a1', 'A의 새 메시지')]);
    await vi.advanceTimersByTimeAsync(5000); s.collection.add('C');
    await vi.advanceTimersByTimeAsync(5000); expect(s.drafts.map(d => d.room)).toEqual(['A']);
  });
  it('retains at most 20 messages for each room, and common settings pause all rooms', () => {
    const collection = new RoomCollection(settings, () => ({ generate: async () => '', recheck: async () => { throw new Error('unused'); }, publish: async () => {}, changed: () => {} }));
    for (const room of ['A', 'B']) collection.add(room, Array.from({ length: 25 }, (_, i) => msg(`${room}-${i}`, `${room} 기록`)));
    collection.startAll(); collection.configure({ ...settings, prompt: '새 공통 규칙' });
    for (const { room, monitor } of collection.views()) { expect(monitor.enabled).toBe(false); expect(monitor.messages).toHaveLength(20); expect(monitor.messages.every(m => m.id.startsWith(room))).toBe(true); }
  });
});

it('preserves room participant rules across common settings changes and pauses only the edited room', () => {
  const s = fixture();
  s.collection.setParticipants('A', { questioners: ['학생'], teachers: ['선생님'] });
  expect(s.collection.get('A')!.state.enabled).toBe(false); expect(s.collection.get('B')!.state.enabled).toBe(true);
  s.collection.configure({ ...settings, prompt: '변경' });
  expect(s.collection.views().find(r => r.room === 'A')!.participants).toEqual({ questioners: ['학생'], teachers: ['선생님'] });
  s.collection.remove('A'); expect(s.collection.participants.has('A')).toBe(false);
});
