import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store';
import { DraftAutosave } from './draft-autosave';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'reply-note-autosave-')); directories.push(directory);
  const store = new Store(directory);
  store.value.drafts = ['A', 'B'].map(id => ({ id, room: id, text: '생성 원문', delivery: 'local' as const, createdAt: 1 }));
  store.save();
  return { store, autosave: new DraftAutosave(store, vi.fn()) };
}
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe('draft autosave durability', () => {
  it('coalesces rapid keystrokes into a single disk write with the latest text', async () => {
    vi.useFakeTimers(); const { store, autosave } = fixture(); const save = vi.spyOn(store, 'save');
    const first = autosave.update('A', '수'); await vi.advanceTimersByTimeAsync(250);
    const last = autosave.update('A', '수정한 최신 답장'); await vi.advanceTimersByTimeAsync(499);
    expect(new Store(store.directory).value.drafts[0].text).toBe('생성 원문'); expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await Promise.all([first, last]);
    expect(save).toHaveBeenCalledOnce(); expect(new Store(store.directory).value.drafts[0].text).toBe('수정한 최신 답장');
    expect(autosave.status.A).toBeUndefined();
  });
  it('flushes immediately on blur/copy/quit, including all rooms, before the debounce expires', async () => {
    vi.useFakeTimers(); const { store, autosave } = fixture();
    const first = autosave.update('A', '방 A 수정'); const second = autosave.update('B', '방 B 수정');
    autosave.flush(); await Promise.all([first, second]);
    expect(new Store(store.directory).value.drafts.map(draft => draft.text)).toEqual(['방 A 수정', '방 B 수정']);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps edited input and reports failed persistence until an explicit flush succeeds', async () => {
    const { store, autosave } = fixture(); const save = vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('disk full'); });
    const pending = expect(autosave.update('A', '사라지면 안 되는 수정')).rejects.toThrow('자동 저장');
    expect(() => autosave.flush()).toThrow('자동 저장'); await pending;
    expect(store.value.drafts[0].text).toBe('사라지면 안 되는 수정'); expect(autosave.status.A).toBe('error');
    autosave.flush(); expect(autosave.status.A).toBeUndefined();
    expect(new Store(store.directory).value.drafts[0].text).toBe('사라지면 안 되는 수정'); save.mockRestore();
  });
  it('never recreates a deleted draft when a pending debounce completes', async () => {
    const { store, autosave } = fixture(); const pending = autosave.update('A', '삭제 직전 입력');
    store.value.drafts = store.value.drafts.filter(draft => draft.id !== 'A');
    autosave.flush(); await pending;
    expect(new Store(store.directory).value.drafts.map(draft => draft.id)).toEqual(['B']);
  });
});
