import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from './monitor';
import type { ChatMessage, Draft, Settings, Snapshot } from '../../shared/types';

const settings: Settings = { room: '친구', prompt: '짧고 자연스럽게', codexPath: '', model: '', delivery: 'app' };
const message = (id: string, direction: ChatMessage['direction'] = 'incoming', text = id): ChatMessage => ({ id, direction, text, sender: direction === 'incoming' ? '친구' : '나', time: '오후 1:00' });
const ready = (messages: ChatMessage[]): Snapshot => ({ status: 'ready', room: '친구', messages, capturedAt: Date.now() });
function setup() {
  let current = ready([message('old')]);
  const published: Draft[] = [];
  const generate = vi.fn(async () => '초안');
  const monitor = new Monitor(settings, { generate, recheck: async () => current, publish: async d => { published.push(d); }, changed: vi.fn() });
  const ingest = (messages: ChatMessage[]) => { current = ready(messages); monitor.ingest(current); };
  monitor.start(); ingest([message('old')]);
  return { monitor, ingest, published, generate, setCurrent: (s: Snapshot) => { current = s; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T13:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });
describe('reply workflow', () => {
  it('keeps per-draft model provenance from the generation result', async () => {
    const published: Draft[] = [];
    let current = ready([message('old')]);
    const monitor = new Monitor(settings, { generate: async () => ({ text: '모델을 선택한 답장', model: 'example-chosen' }), recheck: async () => current, publish: async draft => { published.push(draft); }, changed: () => {} });
    monitor.start(); monitor.ingest(current);
    current = ready([message('old'), message('new')]); monitor.ingest(current);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(published[0].model).toBe('example-chosen');
  });
  it('allows self-chat reception checks without generating or sending any draft', async () => {
    const s = setup();
    s.monitor.ingest({ ...ready([message('self-1')]), chatKind: 'self' });
    s.monitor.ingest({ ...ready([message('self-1'), message('phone-test')]), chatKind: 'self' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.monitor.state.messages.at(-1)?.id).toBe('phone-test');
    expect(s.monitor.state.phase).toBe('watching');
    expect(s.generate).not.toHaveBeenCalled(); expect(s.published).toHaveLength(0);
  });
  it('uses history only as context and does not draft on initial connection or duplicate polls', async () => {
    const s = setup(); s.ingest([message('old')]); await vi.advanceTimersByTimeAsync(20_000);
    expect(s.generate).not.toHaveBeenCalled(); expect(s.monitor.state.phase).toBe('watching');
  });
  it('coalesces consecutive messages and restarts the 10 second wait', async () => {
    const s = setup(); s.ingest([message('old'), message('a')]);
    await vi.advanceTimersByTimeAsync(9000); s.ingest([message('old'), message('a'), message('b')]);
    await vi.advanceTimersByTimeAsync(9999); expect(s.generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(s.generate).toHaveBeenCalledTimes(1); expect(s.published).toHaveLength(1);
    expect(s.generate.mock.calls[0][0].at(-1)?.id).toBe('b');
  });
  it('cancels the wait when the user answers', async () => {
    const s = setup(); s.ingest([message('old'), message('a')]);
    s.ingest([message('old'), message('a'), message('mine', 'outgoing')]);
    await vi.advanceTimersByTimeAsync(20_000); expect(s.generate).not.toHaveBeenCalled(); expect(s.published).toHaveLength(0);
  });
  it('aborts an in-flight generation and only publishes the current conversation', async () => {
    const s = setup(); let finish!: (v: string) => void;
    s.generate.mockImplementationOnce(() => new Promise<string>(r => { finish = r; }));
    s.ingest([message('old'), message('a')]); await vi.advanceTimersByTimeAsync(10_000);
    const signal = s.generate.mock.calls[0][2];
    s.ingest([message('old'), message('a'), message('b')]); expect(signal.aborted).toBe(true);
    finish('오래된 초안'); await vi.advanceTimersByTimeAsync(0); expect(s.published).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000); expect(s.published.map(d => d.text)).toEqual(['초안']);
  });
  it('discards a draft when the immediate pre-delivery recheck discovers my reply', async () => {
    const s = setup(); s.ingest([message('old'), message('a')]);
    s.setCurrent(ready([message('old'), message('a'), message('mine', 'outgoing')]));
    await vi.advanceTimersByTimeAsync(10_000); expect(s.generate).toHaveBeenCalledTimes(1); expect(s.published).toHaveLength(0);
  });
  it('pausing or a closed window invalidates in-flight work', async () => {
    const s = setup(); let finish!: (v: string) => void;
    s.generate.mockImplementationOnce(() => new Promise<string>(r => { finish = r; }));
    s.ingest([message('old'), message('a')]); await vi.advanceTimersByTimeAsync(10_000); s.monitor.stop(); finish('늦은 초안');
    await vi.advanceTimersByTimeAsync(1000); expect(s.published).toHaveLength(0); expect(s.monitor.state.enabled).toBe(false);
    s.monitor.start(); s.ingest([message('old'), message('a')]); s.ingest([message('old'), message('a'), message('b')]);
    s.monitor.ingest({ ...ready([]), status: 'room_closed' }); await vi.advanceTimersByTimeAsync(10_000);
    expect(s.generate).toHaveBeenCalledTimes(1); expect(s.monitor.state.phase).toBe('needs_attention');
  });
  it('reconnection and a history reload set a baseline instead of replaying old messages', async () => {
    const s = setup(); s.ingest([message('old'), message('a')]);
    s.monitor.ingest({ ...ready([]), status: 'error' }); s.ingest([message('old'), message('a'), message('offline')]);
    await vi.advanceTimersByTimeAsync(10_000); expect(s.generate).not.toHaveBeenCalled();
    s.ingest([message('different-history')]); await vi.advanceTimersByTimeAsync(10_000); expect(s.generate).not.toHaveBeenCalled();
  });
  it('handles identical text as two messages when native row identities differ', async () => {
    const s = setup(); s.ingest([message('old'), message('a', 'incoming', '응')]); await vi.advanceTimersByTimeAsync(5000);
    s.ingest([message('old'), message('a', 'incoming', '응'), message('b', 'incoming', '응')]);
    await vi.advanceTimersByTimeAsync(5000); expect(s.generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); expect(s.generate).toHaveBeenCalledTimes(1);
  });
  it('fails closed on unknown sender direction and retains at most 20 messages', async () => {
    const s = setup(); const ms = Array.from({ length: 24 }, (_, n) => message(String(n)));
    s.ingest(ms); expect(s.monitor.state.messages).toHaveLength(20);
    s.ingest([...ms.slice(-19), message('unclear', 'unknown')]);
    await vi.advanceTimersByTimeAsync(20_000); expect(s.generate).not.toHaveBeenCalled(); expect(s.monitor.state.phase).toBe('needs_attention');
  });
  it('changing settings cancels pending work and requires an explicit restart', async () => {
    const s = setup(); s.ingest([message('old'), message('a')]); s.monitor.configure({ ...settings, room: '다른 사람' });
    await vi.advanceTimersByTimeAsync(20_000); expect(s.generate).not.toHaveBeenCalled(); expect(s.monitor.state.enabled).toBe(false);
  });
});
