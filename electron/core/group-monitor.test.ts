import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from './monitor';
import type { ChatMessage, Draft, Settings, Snapshot } from '../../shared/types';
const settings: Settings = { room: '수학방', prompt: '설명해줘', codexPath: '', model: 'test', delivery: 'app', participants: { questioners: ['학생 A', '학생 B', '학부모'], teachers: ['선생님', '나'] } };
const msg = (id: string, sender: string, text = id): ChatMessage => ({ id, sender, text, direction: sender === '나' ? 'outgoing' : 'incoming', time: '오후 1:00' });
function setup() {
  let current: Snapshot = { status: 'ready', room: settings.room, messages: [msg('old', '선생님')], chatKind: 'group', capturedAt: Date.now() };
  const drafts: Draft[] = [];
  const generate = vi.fn(async (_messages: ChatMessage[], s: Settings, _signal: AbortSignal) => `${s.replyTarget!.sender} 초안`);
  const teacherResponded = vi.fn();
  const monitor = new Monitor(settings, { generate, recheck: async () => current, publish: async d => { drafts.push(d); }, teacherResponded, changed: vi.fn() });
  const append = (...messages: ChatMessage[]) => { current = { ...current, capturedAt: Date.now(), messages: [...current.messages, ...messages].slice(-20) }; monitor.ingest(current); };
  monitor.start(); monitor.ingest(current);
  return { monitor, append, generate, drafts, teacherResponded, current: () => current, setRecheck: (messages: ChatMessage[]) => { current = { ...current, messages }; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T10:00:00Z')); });
afterEach(() => vi.useRealTimers());
describe('group questioner workflow', () => {
  it('waits independently and targets each person while preserving shared room context', async () => {
    const s = setup(); s.append(msg('a1', '학생 A', '감사합니다'));
    await vi.advanceTimersByTimeAsync(4000); s.append(msg('b1', '학생 B'));
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.drafts.map(d => d.targetSender)).toEqual(['학생 A']);
    expect(s.generate.mock.calls[0][0].map(m => m.sender)).toEqual(['선생님', '학생 A', '학생 B']);
    expect(s.drafts[0].targetMessages?.map(m => m.text)).toEqual(['감사합니다']);
    await vi.advanceTimersByTimeAsync(4000); expect(s.drafts.map(d => d.targetSender)).toEqual(['학생 A', '학생 B']);
  });
  it('coalesces messages for the same sender without extending another sender’s wait', async () => {
    const s = setup(); s.append(msg('a1', '학생 A'), msg('b1', '학생 B'));
    await vi.advanceTimersByTimeAsync(8000); s.append(msg('a2', '학생 A'));
    await vi.advanceTimersByTimeAsync(2000); expect(s.drafts.map(d => d.targetSender)).toEqual(['학생 B']);
    await vi.advanceTimersByTimeAsync(8000); expect(s.drafts[1].targetMessages?.map(m => m.id)).toEqual(['a1', 'a2']);
  });
  it('does not trigger or reset timers for unregistered participants', async () => {
    const s = setup(); s.append(msg('a1', '학생 A'));
    await vi.advanceTimersByTimeAsync(9000); s.append(msg('other', '다른 학부모'));
    await vi.advanceTimersByTimeAsync(1000); expect(s.drafts).toHaveLength(1);
    s.append(msg('other-2', '다른 학부모')); await vi.advanceTimersByTimeAsync(10000); expect(s.drafts).toHaveLength(1);
  });
  it('cancels all waiting senders on any teacher message and does not replay the cancelled questions', async () => {
    const s = setup(); s.append(msg('a1', '학생 A'), msg('b1', '학생 B'));
    s.append(msg('reply', '선생님', '확인할게'));
    await vi.advanceTimersByTimeAsync(20000); expect(s.generate).not.toHaveBeenCalled();
    expect(s.teacherResponded).toHaveBeenCalledWith('선생님', Date.now() - 20000);
    s.monitor.ingest(s.current()); await vi.advanceTimersByTimeAsync(10000); expect(s.generate).not.toHaveBeenCalled();
    expect(s.monitor.state.tasks).toEqual([]);
  });
  it('only restarts the same sender during generation; stale completions cannot publish', async () => {
    const s = setup(); let finish!: (text: string) => void;
    s.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    s.append(msg('a1', '학생 A')); await vi.advanceTimersByTimeAsync(10000);
    const signal = s.generate.mock.calls[0][2];
    s.append(msg('b1', '학생 B')); expect(signal.aborted).toBe(false);
    s.append(msg('a2', '학생 A')); expect(signal.aborted).toBe(true);
    finish('오래된 초안'); await vi.advanceTimersByTimeAsync(0); expect(s.drafts).toEqual([]);
    await vi.advanceTimersByTimeAsync(10000); expect(s.drafts.map(d => d.targetSender).sort()).toEqual(['학생 A', '학생 B']);
  });
  it('aborts all in-flight jobs when a teacher answers', async () => {
    const s = setup(); const finishes: ((text: string) => void)[] = [];
    s.generate.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
    s.append(msg('a1', '학생 A'), msg('b1', '학생 B')); await vi.advanceTimersByTimeAsync(10000);
    s.append(msg('teacher', '나'));
    expect(s.generate.mock.calls.every(call => call[2].aborted)).toBe(true);
    finishes.forEach(finish => finish('취소된 초안')); await vi.advanceTimersByTimeAsync(0); expect(s.drafts).toEqual([]);
  });
  it('discovers a teacher reply in the final recheck and discards the draft', async () => {
    const s = setup(); s.append(msg('a1', '학생 A'));
    s.setRecheck([...s.current().messages, msg('teacher', '선생님')]);
    await vi.advanceTimersByTimeAsync(10000); expect(s.generate).toHaveBeenCalledOnce(); expect(s.drafts).toEqual([]);
  });
  it('handles teacher/question order in a single poll', async () => {
    const s = setup(); s.append(msg('a1', '학생 A'), msg('teacher', '선생님'), msg('b1', '학생 B'));
    await vi.advanceTimersByTimeAsync(10000); expect(s.drafts.map(d => d.targetSender)).toEqual(['학생 B']);
  });
  it('fails closed when group sender identity is unavailable', async () => {
    const s = setup(); s.append(msg('a1', '학생 A')); s.append(msg('unknown', ''));
    await vi.advanceTimersByTimeAsync(10000); expect(s.drafts).toEqual([]); expect(s.monitor.state.phase).toBe('needs_attention');
  });
  it('requires room participant configuration instead of treating every group sender as a counterpart', async () => {
    const s = setup(); s.monitor.configure({ ...settings, participants: undefined }); s.monitor.start();
    s.monitor.ingest(s.current()); s.append(msg('a1', '학생 A'));
    await vi.advanceTimersByTimeAsync(10000); expect(s.generate).not.toHaveBeenCalled(); expect(s.monitor.state.phase).toBe('needs_attention');
  });
  it('pausing cancels every participant timer and reconnecting does not replay messages', async () => {
    const s = setup(); s.append(msg('a1', '학생 A'), msg('b1', '학생 B')); s.monitor.stop();
    await vi.advanceTimersByTimeAsync(10000); expect(s.generate).not.toHaveBeenCalled();
    s.monitor.start(); s.monitor.ingest(s.current()); await vi.advanceTimersByTimeAsync(10000); expect(s.generate).not.toHaveBeenCalled();
  });
});
