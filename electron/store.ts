import { validPersonPrompts } from '../shared/person-prompts';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { mergeHistory } from '../shared/history';
import type { ChatMessage, Draft, RoomParticipants, Settings } from '../shared/types';
import { DEFAULT_PROMPT } from '../shared/types';
export interface Stored { personPromptsByRoom: Record<string, Record<string, string>>; archiveByRoom: Record<string, ChatMessage[]>; settings: Settings; roomNames: string[]; participantsByRoom: Record<string, RoomParticipants>; messagesByRoom: Record<string, ChatMessage[]>; messages: ChatMessage[]; drafts: Draft[]; }
export function defaults(): Stored { return { personPromptsByRoom: {}, archiveByRoom: {}, settings: { room: '', prompt: DEFAULT_PROMPT, codexPath: '', model: '', effort: '', delivery: 'app' }, roomNames: [], participantsByRoom: {}, messagesByRoom: {}, messages: [], drafts: [] }; }
export class Store {
  value: Stored;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fallback = defaults();
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, 'state.json'), 'utf8'));
      const settings = validateSettings({ ...fallback.settings, ...parsed.settings });
      const legacyMessages = Array.isArray(parsed.messages) ? parsed.messages.slice(-20) : [];
      const roomNames = Array.isArray(parsed.roomNames)
        ? [...new Set<string>(parsed.roomNames.filter((name: unknown) => typeof name === 'string' && name.trim() && name.length <= 200).map((name: string) => name.trim()))].slice(0, 20)
        : settings.room ? [settings.room] : [];
      const messagesByRoom = Object.fromEntries(roomNames.map(room => [room, Array.isArray(parsed.messagesByRoom?.[room]) ? parsed.messagesByRoom[room].slice(-20) : room === settings.room ? legacyMessages : []]));
      if (!roomNames.includes(settings.room)) settings.room = roomNames[0] ?? '';
      const participantsByRoom: Record<string, RoomParticipants> = Object.create(null);
      for (const room of roomNames) {
        try { if (parsed.participantsByRoom?.[room]) participantsByRoom[room] = validateParticipants(parsed.participantsByRoom[room]); } catch { /* Discard invalid room rules without losing other saved data. */ }
      }
      const archiveByRoom = Object.fromEntries(roomNames.map(room => [room, mergeHistory(Array.isArray(parsed.archiveByRoom?.[room]) ? parsed.archiveByRoom[room].filter((m: ChatMessage) => m && typeof m.id === 'string' && typeof m.text === 'string' && typeof m.sender === 'string') : [], messagesByRoom[room])]));
      const personPromptsByRoom = Object.fromEntries(roomNames.map(room => [room, validPersonPrompts(parsed.personPromptsByRoom?.[room])]));
      this.value = { personPromptsByRoom, archiveByRoom, settings, roomNames, participantsByRoom, messagesByRoom, messages: messagesByRoom[settings.room] ?? [], drafts: Array.isArray(parsed.drafts) ? parsed.drafts.slice(0, 20).map((draft: Draft) => draft.contactSend?.outcome === 'sending' ? { ...draft, contactSend: { ...draft.contactSend, outcome: 'unknown', detail: '앱이 전송 결과를 확인하기 전에 종료됐습니다. 카톡방을 직접 확인해주세요.' } } : draft) : [] };
    } catch { this.value = fallback; }
  }
  save() {
    const file = path.join(this.directory, 'state.json'); const temporary = file + '.tmp';
    const messagesByRoom = Object.fromEntries(this.value.roomNames.map(room => [room, (this.value.messagesByRoom[room] ?? []).slice(-20)]));
    const archiveByRoom = Object.fromEntries(this.value.roomNames.map(room => [room, mergeHistory(this.value.archiveByRoom[room] ?? [], messagesByRoom[room])]));
    this.value.archiveByRoom = archiveByRoom;
    const participantsByRoom = Object.fromEntries(this.value.roomNames.filter(room => this.value.participantsByRoom[room]).map(room => [room, this.value.participantsByRoom[room]]));
    const personPromptsByRoom = Object.fromEntries(this.value.roomNames.map(room => [room, validPersonPrompts(this.value.personPromptsByRoom[room])]));
    writeFileSync(temporary, JSON.stringify({ ...this.value, personPromptsByRoom, participantsByRoom, messagesByRoom, messages: (messagesByRoom[this.value.settings.room] ?? []).slice(-20), drafts: this.value.drafts.slice(0, 20) }, null, 2), { mode: 0o600 });
    chmodSync(temporary, 0o600); renameSync(temporary, file);
  }
  updateDraft(id: unknown, text: unknown, persist = true): Draft {
    if (typeof id !== 'string' || typeof text !== 'string' || text.length > 20_000 || text.includes('\0')) throw new Error('초안은 20,000자 이내의 텍스트로 입력해주세요.');
    const draft = this.value.drafts.find(item => item.id === id);
    if (!draft) throw new Error('초안을 찾을 수 없습니다. 기록이 삭제됐거나 보관 개수를 초과했을 수 있습니다.');
    if (draft.text === text) return draft;
    // Preserve generation provenance and original delivery status; edits are local, never re-sent.
    const previous = { text: draft.text, originalText: draft.originalText, editedAt: draft.editedAt };
    Object.assign(draft, { originalText: draft.originalText ?? draft.text, text, editedAt: Date.now() });
    // Preserve object identity while a self-message delivery may still be updating its status.
    try { if (persist) this.save(); } catch (error) { Object.assign(draft, previous); throw error; }
    return draft;
  }
  markTeacherResponse(room: string, sender: string, at: number) {
    let changed = false;
    for (const draft of this.value.drafts) {
      if (draft.room === room && draft.targetSender && !draft.teacherResponse) { draft.teacherResponse = { sender, at }; changed = true; }
    }
    if (changed) this.save();
  }
  tokenFile() { return path.join(this.directory, 'kakao-token.enc'); }
  hasToken() { return existsSync(this.tokenFile()); }
  deleteToken() { if (this.hasToken()) unlinkSync(this.tokenFile()); }
}
export function validateSettings(input: unknown): Settings {
  if (!input || typeof input !== 'object') throw new Error('설정 형식이 올바르지 않습니다.');
  const s = input as Record<string, unknown>;
  for (const key of ['room', 'prompt', 'codexPath', 'model']) if (typeof s[key] !== 'string') throw new Error('설정에 잘못된 값이 있습니다.');
  if ((s.room as string).length > 200 || (s.prompt as string).length > 20_000 || (s.codexPath as string).length > 2000 || (s.model as string).length > 100) throw new Error('설정 내용이 너무 깁니다.');
  if (s.delivery !== 'app' && s.delivery !== 'kakao') throw new Error('전달 방식을 확인해주세요.');
  if (s.effort !== undefined && (typeof s.effort !== 'string' || (s.effort.trim() && !/^[a-z_]{1,30}$/.test(s.effort.trim())))) throw new Error('effort 설정을 확인해주세요.');
  return { room: (s.room as string).trim(), prompt: s.prompt as string, codexPath: (s.codexPath as string).trim(), model: (s.model as string).trim(), effort: typeof s.effort === 'string' ? s.effort.trim() : '', delivery: s.delivery };
}

export function validateParticipants(input: unknown): RoomParticipants {
  if (!input || typeof input !== 'object') throw new Error('참여자 설정을 확인해주세요.');
  const value = input as Record<string, unknown>;
  const names = (key: string) => {
    const list = value[key];
    if (!Array.isArray(list) || list.length > 100 || list.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\r\n\0]/.test(name))) throw new Error('참여자는 목록별 최대 100명, 이름은 1~100자로 입력해주세요.');
    return [...new Set<string>(list.map(name => name.trim()))];
  };
  const questioners = names('questioners'), teachers = names('teachers');
  if (questioners.includes('나')) throw new Error('내 메시지는 초안 생성 대상에 등록할 수 없습니다.');
  if (questioners.some(name => teachers.includes(name))) throw new Error('같은 사람을 질문자와 선생님에 동시에 등록할 수 없습니다.');
  return { questioners, teachers };
}
