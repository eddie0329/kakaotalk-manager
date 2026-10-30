import type { ChatMessage, Draft, GeneratedReply, MonitorState, Settings, Snapshot, QuestionContext } from '../../shared/types';
import { sameMessage, assertMediaReady, MaterialRequiredError } from '../../shared/media';
import { randomUUID } from 'node:crypto';

export interface MonitorDependencies {
  generate: (messages: ChatMessage[], settings: Settings, signal: AbortSignal) => Promise<string | GeneratedReply>;
  materials?: () => QuestionContext[];
  recheck: () => Promise<Snapshot>;
  publish: (draft: Draft, signal: AbortSignal) => Promise<void>;
  teacherResponded?: (sender: string, at: number) => void;
  changed: () => void;
  now?: () => number;
  delay?: number;
}
interface Task {
  sender: string; messages: ChatMessage[]; phase: 'waiting' | 'generating' | 'needs_materials' | 'error';
  dueAt: number | null; timer?: ReturnType<typeof setTimeout>; job?: AbortController; detail?: string;
}
export const initialMonitorState = (): MonitorState => ({ enabled: false, phase: 'paused', detail: '감지를 시작하면 새 메시지를 확인합니다.', readerStatus: null, messages: [], dueAt: null, lastCheckedAt: null, chatKind: null, tasks: [] });
const equal = sameMessage;

/** Read-only workflow. Each questioner owns a timer/job; a teacher response cancels the room. */
export class Monitor {
  state = initialMonitorState();
  private previous: ChatMessage[] | null = null;
  private tasks = new Map<string, Task>();
  private settings: Settings;
  private now: () => number;
  constructor(settings: Settings, private deps: MonitorDependencies) { this.settings = { ...settings }; this.now = deps.now ?? Date.now; }
  configure(settings: Settings) { this.stop(); this.settings = { ...settings }; this.previous = null; this.state.messages = []; this.state.readerStatus = null; this.state.lastCheckedAt = null; this.state.chatKind = null; }
  inspect(snapshot: Snapshot) {
    if (this.state.enabled) { this.ingest(snapshot); return; }
    this.state.readerStatus = snapshot.status; this.state.chatKind = snapshot.chatKind ?? null; this.state.lastCheckedAt = this.now();
    if (snapshot.status === 'ready') this.state.messages = snapshot.messages.slice(-20);
    this.state.detail = snapshot.status === 'ready'
      ? snapshot.chatKind === 'self' ? '나와의 채팅 연결을 확인했습니다. 실제 대화 초안 만들기 버튼으로 수동 생성할 수 있습니다.'
        : snapshot.chatKind === 'group' && !this.settings.participants ? '단체방을 연결했습니다. 이 방의 질문자와 선생님을 등록해주세요.' : '연결을 확인했습니다. 감지 시작을 누르면 새 메시지부터 초안을 만듭니다.'
      : snapshot.detail || '카카오톡 연결 상태를 확인해주세요.';
    this.deps.changed();
  }
  start() { this.cancel(); this.previous = null; this.state = { ...this.state, enabled: true, phase: 'connecting', detail: '열린 채팅방을 확인하고 있습니다.', dueAt: null }; this.deps.changed(); }
  stop() { this.cancel(); this.previous = null; this.state = { ...this.state, enabled: false, phase: 'paused', dueAt: null, detail: '감지가 일시정지되어 있습니다.' }; this.deps.changed(); }
  invalidate(sender?: string) { this.cancel(sender); this.deps.changed(); }
  forget() { this.stop(); this.state.messages = []; this.deps.changed(); }
  private cancel(sender?: string) {
    for (const [key, task] of this.tasks) if (sender === undefined || key === sender) {
      if (task.timer) clearTimeout(task.timer); task.job?.abort(); this.tasks.delete(key);
    }
    this.syncTasks();
  }
  private syncTasks(detail?: string) {
    const tasks = [...this.tasks.values()];
    this.state.tasks = tasks.map(({ sender, phase, dueAt, detail }) => ({ sender, phase, dueAt, detail }));
    this.state.dueAt = tasks.reduce<number | null>((min, t) => t.dueAt === null ? min : min === null ? t.dueAt : Math.min(min, t.dueAt), null);
    this.state.phase = tasks.some(t => t.phase === 'generating') ? 'generating' : tasks.some(t => t.phase === 'waiting') ? 'waiting' : tasks.some(t => t.phase === 'needs_materials') ? 'needs_materials' : tasks.some(t => t.phase === 'error') ? 'error' : 'watching';
    this.state.detail = detail ?? tasks.find(t => t.phase === 'needs_materials')?.detail ?? (tasks.length ? `질문자별로 ${tasks.length}개의 초안을 처리하고 있습니다.` : '새 메시지를 기다리고 있습니다.');
  }
  ingest(snapshot: Snapshot) {
    if (!this.state.enabled) return;
    this.state.lastCheckedAt = this.now(); this.state.readerStatus = snapshot.status;
    const oldKind = this.state.chatKind; this.state.chatKind = snapshot.chatKind ?? null;
    if (snapshot.status !== 'ready' || snapshot.room !== this.settings.room) {
      this.cancel(); this.previous = null; this.state.phase = 'needs_attention';
      this.state.detail = snapshot.detail || '선택한 채팅방을 카카오톡에서 열어주세요.'; this.deps.changed(); return;
    }
    const messages = snapshot.messages.slice(-20); this.state.messages = messages;
    if (snapshot.chatKind === 'self') {
      this.cancel(); this.previous = null; this.state.phase = 'watching';
      this.state.detail = '나와의 채팅 수신 확인 중입니다. 실제 대화 초안 만들기 버튼으로 수동 생성할 수 있습니다.'; this.deps.changed(); return;
    }
    const participants = this.settings.participants;
    if (snapshot.chatKind === 'group' && (!participants?.questioners.length || !participants.teachers.length)) {
      this.cancel(); this.previous = null; this.state.phase = 'needs_attention'; this.state.detail = '단체방의 질문자와 선생님을 각각 등록하고 저장해주세요.'; this.deps.changed(); return;
    }
    if (this.previous === null || oldKind !== this.state.chatKind) {
      this.cancel(); this.previous = messages; this.syncTasks('연결됐습니다. 새 메시지부터 초안을 만듭니다.'); this.deps.changed(); return;
    }
    const previous = this.previous; this.previous = messages;
    if (previous.length === messages.length && previous.every((m, i) => equal(m, messages[i]))) { this.deps.changed(); return; }
    let overlap = 0;
    for (let n = Math.min(previous.length, messages.length); n > 0; n--) {
      if (previous.slice(-n).every((m, i) => equal(m, messages[i]))) { overlap = n; break; }
    }
    if (!overlap && previous.length) {
      this.cancel(); this.syncTasks('대화가 다시 로드되어 기준을 갱신했습니다. 다음 새 메시지부터 확인합니다.'); this.deps.changed(); return;
    }
    const appended = messages.slice(overlap);
    // Unknown identities may belong to a teacher; never keep generating across that uncertainty.
    if (appended.some(m => m.direction === 'unknown' || (participants && !m.sender.trim()))) {
      this.cancel(); this.state.phase = 'needs_attention'; this.state.detail = '새 메시지의 발신자를 확인할 수 없어 초안 생성을 멈췄습니다.'; this.deps.changed(); return;
    }
    if (!participants) {
      this.cancel();
      const last = appended.at(-1);
      if (last?.direction === 'incoming') this.schedule(last.sender || this.settings.room, appended.filter(m => m.direction === 'incoming'));
      else this.syncTasks('직접 보낸 답장을 확인해 초안 생성을 취소했습니다.');
      this.deps.changed(); return;
    }
    // New media invalidates an in-flight answer even when another participant sent it.
    for (const task of this.tasks.values()) if (task.phase === 'generating') {
      try { assertMediaReady(messages, this.deps.materials?.() ?? [], task.messages); }
      catch (error) { if (error instanceof MaterialRequiredError) { task.job?.abort(); task.phase = 'needs_materials'; task.detail = error.message; } }
    }
    // Process in chronological order: a new question AFTER a teacher reply can start a new wait.
    let teacherSeen = false;
    for (const message of appended) {
      if (participants.teachers.includes(message.sender)) {
        this.cancel(); teacherSeen = true; this.deps.teacherResponded?.(message.sender, this.now());
      } else if (message.direction === 'incoming' && participants.questioners.includes(message.sender)) {
        this.schedule(message.sender, [message]);
      }
    }
    this.syncTasks(teacherSeen && !this.tasks.size ? '선생님 메시지를 확인해 이 방의 모든 대기·생성을 취소했습니다.' : undefined);
    this.deps.changed();
  }
  private schedule(sender: string, messages: ChatMessage[]) {
    const existing = this.tasks.get(sender);
    const targets = [...(existing?.messages ?? []), ...messages].slice(-20);
    this.cancel(sender);
    const delay = this.deps.delay ?? 10_000;
    const task: Task = { sender, messages: targets, phase: 'waiting', dueAt: this.now() + delay };
    this.tasks.set(sender, task);
    task.timer = setTimeout(() => { task.timer = undefined; void this.run(task); }, delay);
    this.syncTasks();
  }
  private active(task: Task) { return this.state.enabled && this.tasks.get(task.sender) === task && !task.job?.signal.aborted; }
  private async run(task: Task) {
    if (!this.active(task)) return;
    const job = new AbortController(); task.job = job; task.phase = 'generating'; task.dueAt = null;
    this.syncTasks(); this.deps.changed();
    try {
      assertMediaReady(this.state.messages, this.deps.materials?.() ?? [], task.messages);
      const replyTarget = this.settings.participants ? { sender: task.sender, messages: task.messages.map(m => ({ ...m })) } : undefined;
      const reply = await this.deps.generate(this.state.messages.map(m => ({ ...m })), { ...this.settings, replyTarget }, job.signal);
      const text = (typeof reply === 'string' ? reply : reply.text).trim();
      if (!text) throw new Error('Codex가 빈 초안을 반환했습니다.');
      if (!this.active(task)) return;
      this.ingest(await this.deps.recheck());
      if (!this.active(task)) return;
      assertMediaReady(this.state.messages, this.deps.materials?.() ?? [], task.messages);
      const draft: Draft = { id: randomUUID(), room: this.settings.room, text, createdAt: this.now(), delivery: 'local',
        ...(replyTarget ? { targetSender: replyTarget.sender, targetMessages: replyTarget.messages } : {}),
        model: (typeof reply === 'string' ? this.settings.model : reply.model) || undefined,
        contexts: typeof reply === 'string' ? undefined : reply.contexts,
        effort: (typeof reply === 'string' ? this.settings.effort : reply.effort) || undefined };
      await this.deps.publish(draft, job.signal);
      if (!this.active(task)) return;
      this.tasks.delete(task.sender); this.syncTasks('새 초안이 준비됐습니다. 다음 메시지를 기다립니다.');
    } catch (error) {
      if (!this.active(task)) return;
      task.phase = error instanceof MaterialRequiredError ? 'needs_materials' : 'error'; task.detail = error instanceof Error ? error.message : '초안 생성에 실패했습니다.';
      this.syncTasks(task.detail);
    } finally { this.deps.changed(); }
  }
}
