import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DraftNotifications } from './notifications';
import type { Draft } from '../shared/types';

const draft: Draft = { id: 'draft-exact-id', room: '테스트 대화', text: '알림에 노출하면 안 되는 실제 초안 본문', createdAt: 1, delivery: 'local', test: true, testSource: 'conversation' };
function fixture(supported = true) {
  const native = new EventEmitter() as EventEmitter & { show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  native.show = vi.fn(); native.close = vi.fn();
  const deps = { supported: () => supported, create: vi.fn(() => native), open: vi.fn(), changed: vi.fn() };
  return { center: new DraftNotifications(deps), native, deps };
}
describe('draft desktop notifications', () => {
  it('notifies on a manual real-chat draft with sound and opens its exact draft on click', () => {
    const { center, native, deps } = fixture();
    center.draft(draft);
    expect(deps.create.mock.calls[0][0]).toMatchObject({ id: draft.id, title: '답장 초안이 준비됐어요', silent: false });
    expect(JSON.stringify(deps.create.mock.calls)).not.toContain(draft.text);
    expect(native.show).toHaveBeenCalledOnce();
    native.emit('click'); expect(deps.open).toHaveBeenCalledWith(draft.id);
  });
  it('distinguishes synthetic connection checks from real drafts and notifies automatic drafts too', () => {
    const { center, deps } = fixture();
    center.draft({ ...draft, testSource: 'synthetic' });
    expect(deps.create.mock.calls[0][0].title).toContain('연결 시험');
    center.draft({ ...draft, id: 'auto', test: false });
    expect(deps.create.mock.calls[1][0].title).toBe('답장 초안이 준비됐어요');
  });
  it('does not notify cancelled jobs and never throws on unsupported/failed OS notifications', () => {
    const { center, native, deps } = fixture();
    const controller = new AbortController(); controller.abort(); center.draft(draft, controller.signal);
    expect(deps.create).not.toHaveBeenCalled();
    center.draft(draft); native.emit('failed', {}, 'raw OS error with private path');
    expect(center.error).toContain('알림 허용'); expect(center.error).not.toContain('private');
    const unsupported = fixture(false); expect(() => unsupported.center.draft(draft)).not.toThrow();
    expect(unsupported.center.error).toBeTruthy();
  });
  it('tests OS delivery without generating a draft, requiring Codex or including chat data', () => {
    const { center, deps, native } = fixture(); center.test();
    expect(JSON.stringify(deps.create.mock.calls)).not.toContain(draft.room);
    expect(deps.create.mock.calls[0][0].title).toContain('알림 테스트');
    native.emit('click'); expect(deps.open).toHaveBeenCalledWith(undefined);
  });
  it('bounds retained native notifications and cleans them up on exit', () => {
    const handles: Array<EventEmitter & { show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const center = new DraftNotifications({ supported: () => true, open: vi.fn(), changed: vi.fn(), create: () => {
      const native = new EventEmitter() as typeof handles[number]; native.show = vi.fn(); native.close = vi.fn(); handles.push(native); return native;
    } });
    for (let i = 0; i < 22; i++) center.draft({ ...draft, id: `draft-${i}` });
    expect(handles.filter(native => native.close.mock.calls.length)).toHaveLength(2);
    center.close(); expect(handles.every(native => native.close.mock.calls.length === 1)).toBe(true);
  });
});
