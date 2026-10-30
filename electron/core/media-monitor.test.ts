import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Monitor } from './monitor';
import type { ChatMessage, Draft, QuestionContext, Settings, Snapshot } from '../../shared/types';
const settings: Settings = { room: '수학방', model: '', codexPath: '', prompt: '', delivery: 'app', participants: { questioners: ['학생', '다른 학생'], teachers: ['선생님'] } };
const text = (id: string, sender = '학생'): ChatMessage => ({ id, sender, direction: 'incoming', text: '설명해주세요', time: '' });
const photo = (id: string, sender = '학생'): ChatMessage => ({ ...text(id, sender), text: '', attachments: [{ id: 'media-0', kind: 'image' }] });
function setup(initial: ChatMessage[] = [text('baseline', '선생님')]) {
  let current: Snapshot = { status: 'ready', room: settings.room, chatKind: 'group', messages: initial, capturedAt: 1 };
  const contexts: QuestionContext[] = [], drafts: Draft[] = [];
  const generate = vi.fn(async () => '초안');
  const teacherResponded = vi.fn();
  const monitor = new Monitor(settings, { generate, materials: () => contexts, recheck: async () => current, publish: async draft => { drafts.push(draft); }, teacherResponded, changed: vi.fn() });
  monitor.start(); monitor.ingest(current);
  const append = (m: ChatMessage) => { current = { ...current, messages: [...current.messages, m] }; monitor.ingest(current); };
  return { monitor, generate, contexts, drafts, append, teacherResponded, current: () => current, recheck: (m: ChatMessage) => { current = { ...current, messages: [...current.messages, m] }; } };
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
it('a new photo then text is preserved and blocks the model rather than answering from text alone', async () => {
  const s = setup(); s.append(photo('p')); s.append(text('q'));
  await vi.advanceTimersByTimeAsync(10000);
  expect(s.monitor.state.messages.map(m => m.id)).toEqual(['baseline', 'p', 'q']);
  expect(s.monitor.state.phase).toBe('needs_materials'); expect(s.generate).not.toHaveBeenCalled(); expect(s.drafts).toHaveLength(0);
});
it('unread media present at initial connection also blocks a later question', async () => {
  const s = setup([photo('p', '선생님')]); s.append(text('q'));
  await vi.advanceTimersByTimeAsync(10000); expect(s.generate).not.toHaveBeenCalled(); expect(s.monitor.state.phase).toBe('needs_materials');
});
it('new unread media from another participant aborts an already running draft', async () => {
  const s = setup(); let finish!: (value: string) => void; s.generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  s.append(text('q')); await vi.advanceTimersByTimeAsync(10000);
  const signal = s.generate.mock.calls[0][2]; s.append(photo('p', '미등록 학부모'));
  expect(signal.aborted).toBe(true); expect(s.monitor.state.phase).toBe('needs_materials');
  finish('사진을 못 본 답장'); await vi.advanceTimersByTimeAsync(0); expect(s.drafts).toHaveLength(0);
});
it('a teacher photo is still a room-wide cancellation signal', async () => {
  const s = setup(); s.append(text('q')); s.append(photo('teacher-photo', '선생님'));
  await vi.advanceTimersByTimeAsync(10000); expect(s.generate).not.toHaveBeenCalled(); expect(s.teacherResponded).toHaveBeenCalled(); expect(s.monitor.state.tasks).toHaveLength(0);
});
it('generates when a previous photo is explicitly mapped and its content is prepared', async () => {
  const p = photo('p'); const s = setup([p]);
  s.contexts.push({ question: p, references: [], note: '', updatedAt: 1, attachments: [{ id: 'file', name: '문제.png', kind: 'image', size: 10, imageCount: 1, excerpt: '', source: { message: p, attachmentId: 'media-0' } }] });
  s.append(text('q')); await vi.advanceTimersByTimeAsync(10000);
  expect(s.generate).toHaveBeenCalledOnce(); expect(s.drafts).toHaveLength(1);
});
it('the last-minute recheck cannot publish a draft that missed an attachment', async () => {
  const s = setup(); s.append(text('q')); s.recheck(photo('p', '미등록 학부모'));
  await vi.advanceTimersByTimeAsync(10000); expect(s.generate).toHaveBeenCalledOnce(); expect(s.drafts).toHaveLength(0);
});
