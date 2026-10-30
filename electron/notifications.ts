import type { Draft } from '../shared/types';

export interface NotificationHandle {
  on(event: 'click' | 'failed' | 'show', listener: (...args: any[]) => void): unknown;
  show(): void;
  close(): void;
}
interface NotificationDependencies {
  supported(): boolean;
  create(options: { id: string; groupId: string; title: string; body: string; silent: boolean }): NotificationHandle;
  open(draftId?: string): void;
  changed(): void;
}

/** Local OS notifications only: retain native objects and never put message/draft text on the lock screen. */
export class DraftNotifications {
  error: string | null = null;
  private active = new Map<string, NotificationHandle>();
  private sequence = 0;
  constructor(private deps: NotificationDependencies) {}
  draft(draft: Draft, signal?: AbortSignal) {
    if (signal?.aborted) return;
    const title = draft.test && draft.testSource !== 'conversation' ? 'Codex 연결 시험이 완료됐어요' : '답장 초안이 준비됐어요';
    const room = Array.from(draft.room).slice(0, 40).join('');
    this.send(draft.id, title, `${room} · 눌러서 초안을 확인하세요.`, draft.id);
  }
  test() { this.send(`notification-test-${++this.sequence}`, '답장노트 알림 테스트', '초안이 완성되면 이렇게 알려드려요.'); }
  private send(id: string, title: string, body: string, draftId?: string) {
    this.error = null;
    try {
      if (!this.deps.supported()) throw new Error('unsupported');
      const notification = this.deps.create({ id, groupId: 'reply-note-drafts', title, body, silent: false });
      this.active.set(id, notification);
      const fail = () => {
        this.active.delete(id);
        this.error = '알림을 표시하지 못했어요. 시스템 설정에서 Reply Note의 알림 허용 여부를 확인해주세요. 초안은 앱에 보관돼요.';
        this.deps.changed();
      };
      notification.on('failed', fail);
      notification.on('click', () => this.deps.open(draftId));
      notification.on('show', () => { this.error = null; this.deps.changed(); });
      // Keep objects alive for notification-center clicks, with a bounded lifetime/history.
      while (this.active.size > 20) {
        const oldest = this.active.keys().next().value!;
        try { this.active.get(oldest)?.close(); } catch {}
        this.active.delete(oldest);
      }
      notification.show();
    } catch {
      this.active.delete(id);
      this.error = '데스크톱 알림을 실행하지 못했어요. 운영체제의 앱 알림 설정을 확인해주세요. 초안은 앱에 보관돼요.';
    }
    this.deps.changed();
  }
  close() {
    for (const notification of this.active.values()) { try { notification.close(); } catch {} }
    this.active.clear();
  }
}
