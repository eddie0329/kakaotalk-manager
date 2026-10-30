import { Monitor, type MonitorDependencies } from './monitor';
import type { ChatMessage, RoomParticipants, Settings } from '../../shared/types';

export class RoomCollection {
  readonly personPrompts = new Map<string, Record<string, string>>();
  readonly participants = new Map<string, RoomParticipants>();
  readonly monitors = new Map<string, Monitor>();
  constructor(private settings: Settings, private dependencies: (room: string) => MonitorDependencies) {}
  add(room: string, history: ChatMessage[] = [], participants?: RoomParticipants, personPrompts?: Record<string, string>) {
    if (this.monitors.has(room)) return this.monitors.get(room)!;
    if (this.monitors.size >= 20) throw new Error('채팅방은 최대 20개까지 저장할 수 있습니다.');
    const monitor = new Monitor({ ...this.settings, room, participants, personPrompts: structuredClone(personPrompts ?? {}) }, this.dependencies(room));
    monitor.state.messages = history.slice(-20);
    this.monitors.set(room, monitor);
    if (personPrompts) this.personPrompts.set(room, structuredClone(personPrompts));
    if (participants) this.participants.set(room, structuredClone(participants));
    return monitor;
  }
  get(room: string) { return this.monitors.get(room); }
  remove(room: string) { const monitor = this.get(room); this.monitors.delete(room); this.participants.delete(room); this.personPrompts.delete(room); monitor?.stop(); }
  configure(settings: Settings) {
    this.settings = { ...settings };
    for (const [room, monitor] of this.monitors) {
      const history = monitor.state.messages;
      monitor.configure({ ...settings, room, participants: this.participants.get(room), personPrompts: this.personPrompts.get(room) });
      monitor.state.messages = history;
    }
  }
  setParticipants(room: string, participants?: RoomParticipants) {
    const monitor = this.get(room);
    if (!monitor) throw new Error('저장된 채팅방을 선택해주세요.');
    const history = monitor.state.messages;
    if (participants) this.participants.set(room, structuredClone(participants)); else this.participants.delete(room);
    monitor.configure({ ...this.settings, room, participants: this.participants.get(room), personPrompts: this.personPrompts.get(room) });
    monitor.state.messages = history;
  }
  setPersonPrompts(room: string, prompts: Record<string, string>) {
    if (!this.get(room)) throw new Error('저장된 채팅방을 선택해주세요.');
    this.personPrompts.set(room, structuredClone(prompts));
    this.setParticipants(room, this.participants.get(room));
  }
  startAll() { for (const monitor of this.monitors.values()) if (!monitor.state.enabled) monitor.start(); }
  stopAll() { for (const monitor of this.monitors.values()) monitor.stop(); }
  forgetAll() { for (const monitor of this.monitors.values()) monitor.forget(); }
  views() { return [...this.monitors].map(([room, monitor]) => ({ room, monitor: monitor.state, participants: this.participants.get(room), personPrompts: this.personPrompts.get(room) })); }
  histories() { return Object.fromEntries([...this.monitors].map(([room, monitor]) => [room, monitor.state.messages.slice(-20)])); }
}
