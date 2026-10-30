import type { Store } from './store';

/** Stage each keystroke in the main process; coalesce disk writes and flush on copy, blur and quit. */
export class DraftAutosave {
  readonly status: Record<string, 'saving' | 'error'> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = new Set<string>();
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  constructor(private store: Store, private changed: () => void) {}
  update(id: unknown, text: unknown): Promise<void> {
    const draft = this.store.updateDraft(id, text, false);
    this.pending.add(draft.id); this.status[draft.id] = 'saving';
    clearTimeout(this.timer);
    const promise = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.timer = setTimeout(() => { try { this.flush(); } catch { /* reported to pending callers */ } }, 500);
    this.changed(); return promise;
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.pending.size) return;
    const waiters = this.waiters.splice(0);
    try {
      this.store.save();
      for (const id of this.pending) delete this.status[id];
      this.pending.clear(); waiters.forEach(waiter => waiter.resolve());
    } catch {
      const error = new Error('초안을 자동 저장하지 못했어요. 입력 내용은 유지하고 있습니다. 저장 공간을 확인한 뒤 다시 수정하거나 복사해주세요.');
      for (const id of this.pending) this.status[id] = 'error';
      waiters.forEach(waiter => waiter.reject(error));
      throw error;
    } finally { this.changed(); }
  }
}
