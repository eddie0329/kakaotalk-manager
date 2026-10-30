import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { messageFingerprint, sameMessage } from '../shared/media';
import type { AttachmentSource, ChatMessage, ContactSendResult, Snapshot } from '../shared/types';
export interface Reader { read(room: string): Promise<Snapshot>; list(): Promise<{ rooms: string[]; snapshot: Snapshot }>; exportAttachment?(room: string, source: AttachmentSource, destination: string): Promise<string>; close(): void; }
interface NativeReply extends Snapshot { id: number; rooms?: string[]; sendOutcome?: ContactSendResult['outcome']; minimized?: boolean; exportedName?: string; }
export class MacReader implements Reader {
  private originals = new Map<string, { room: string; raw: ChatMessage; public: ChatMessage }>();
  private counter = 0;
  private epoch = randomUUID();
  private native: { request: (json: string) => Promise<string> } | null = null;
  private pending: Array<{ op: string; run: () => Promise<void> }> = [];
  private draining = false;
  private inflight: Promise<string> | null = null;
  constructor(private executable: string, private loadNative: () => { request: (json: string) => Promise<string> } = () => require(executable)) {}
  private request(op: string, room = '', text?: string, extra: Record<string, unknown> = {}): Promise<NativeReply> {
    const execute = async () => {
      this.native ??= this.loadNative();
      if (this.inflight) throw new Error('이전 대화 읽기가 아직 응답하지 않았습니다. 잠시 후 다시 연결해주세요.');
      const id = ++this.counter;
      const operation = this.native!.request(JSON.stringify({ ...extra, id, op, room, text }));
      this.inflight = operation;
      void operation.then(() => { if (this.inflight === operation) this.inflight = null; }, () => { if (this.inflight === operation) this.inflight = null; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('카카오톡 대화 읽기가 지연되고 있습니다. 채팅방을 확인해주세요.')), op === 'export' ? 45_000 : 14_000); })]);
        const result = JSON.parse(raw) as NativeReply;
        if (result.id !== id || !result.status || !Array.isArray(result.messages)) throw new Error('대화 읽기 결과를 확인하지 못했습니다.');
        return result;
      } finally { clearTimeout(timer); }
    };
    return new Promise<NativeReply>((resolve, reject) => {
      const job = { op, run: async () => { try { resolve(await execute()); } catch (error) { reject(error); } } };
      // Keep a running native call intact; manual sends go ahead of queued polling.
      const firstRead = this.pending.findIndex(item => item.op !== 'send' && item.op !== 'export');
      if ((op === 'send' || op === 'export') && firstRead >= 0) this.pending.splice(firstRead, 0, job);
      else this.pending.push(job);
      if (!this.draining) { this.draining = true; queueMicrotask(() => { void this.drain(); }); }
    });
  }
  private async drain() {
    try { while (this.pending.length) await this.pending.shift()!.run(); }
    finally { this.draining = false; }
  }
  async read(room: string) {
    const result = await this.request('read', room);
    return { ...result, messages: result.messages.map(raw => {
      const message = { ...raw, id: `${this.epoch}:${raw.id}${raw.attachments?.length ? ':' + createHash('sha256').update(messageFingerprint(raw)).digest('hex').slice(0, 16) : ''}` };
      this.originals.set(message.id, { room, raw: structuredClone(raw), public: structuredClone(message) });
      while (this.originals.size > 1000) this.originals.delete(this.originals.keys().next().value!);
      return message;
    }) };
  }
  async exportAttachment(room: string, source: AttachmentSource, destination: string) {
    const original = this.originals.get(source.message.id);
    if (!original || original.room !== room || !sameMessage(source.message, original.public)) throw new Error('대화를 다시 감지한 뒤 원본을 가져와주세요.');
    const media = source.message.attachments?.find(a => a.id === source.attachmentId);
    if (!media || media.kind === 'unknown' || (media.count ?? 1) !== 1 || source.message.attachments?.length !== 1) throw new Error('현재 한 장의 사진 또는 단일 파일만 자동으로 가져올 수 있습니다.');
    const result = await this.request('export', room, undefined, { rowId: original.raw.id, expectedMessage: original.raw, attachmentId: source.attachmentId, destination });
    if (result.status !== 'ready' || !result.exportedName) throw new Error(result.detail || '카톡 원본을 가져오지 못했습니다.');
    return result.exportedName;
  }
  async send(room: string, text: string): Promise<ContactSendResult> {
    const result = await this.request('send', room, text);
    if (!result.sendOutcome || !['sent', 'failed', 'unknown'].includes(result.sendOutcome)) throw new Error('전송 응답을 확인하지 못했습니다.');
    return { outcome: result.sendOutcome, detail: result.detail || '카톡방에서 전송 결과를 확인해주세요.', minimized: result.minimized === true };
  }
  async list() { const r = await this.request('list'); return { rooms: r.rooms ?? [], snapshot: r }; }
  close() {}
}
export class UnsupportedReader implements Reader {
  async read(room: string): Promise<Snapshot> { return { status: 'unsupported_platform', room, messages: [], capturedAt: Date.now(), detail: '이 운영체제의 대화 수집은 지원하지 않습니다. macOS 또는 Windows에서 실행해주세요.' }; }
  async list() { return { rooms: [], snapshot: await this.read('') }; }
  close() {}
}
export class DemoReader implements Reader {
  private n = 2;
  messages = [
    { id: 'demo-1', text: '주말에 시간 괜찮아? 같이 점심 먹을까?', direction: 'incoming' as const, sender: '테스트 친구', time: '오후 12:30' },
    { id: 'demo-2', text: '좋아! 토요일 점심 어때?', direction: 'outgoing' as const, sender: '나', time: '오후 12:31' }
  ] as import('../shared/types').ChatMessage[];
  private groupMessages: import('../shared/types').ChatMessage[] = [
    { id: 'group-1', text: '오늘 배운 이차방정식 문제를 같이 확인해볼게요.', direction: 'incoming', sender: '김선생님', time: '오후 1:00' },
    { id: 'group-2', text: '네, 감사합니다.', direction: 'incoming', sender: '민수', time: '오후 1:01' }
  ];
  async read(room: string): Promise<Snapshot> { return { status: room ? 'ready' : 'room_closed', room, messages: [...(room === '수학 수업방' ? this.groupMessages : this.messages)], chatKind: room === '수학 수업방' ? 'group' : 'direct', capturedAt: Date.now() }; }
  appendGroup(sender: string) {
    const id = ++this.n;
    this.groupMessages.push({ id: `group-${id}`, sender, direction: 'incoming', text: sender === '김선생님' ? '잠깐만요, 제가 확인해볼게요.' : sender === '민수' ? `이 문제는 어디부터 풀면 되나요? (${id})` : `풀이 과정을 한 번 더 설명해줄 수 있나요? (${id})`, time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) });
    this.groupMessages = this.groupMessages.slice(-20);
  }
  appendMedia(kind: 'image' | 'file') {
    const id = ++this.n;
    this.groupMessages.push({ id: `group-${id}`, sender: '민수', direction: 'incoming', text: '', attachments: [{ id: 'media-0', kind, ...(kind === 'file' ? { name: '수학문제.pdf' } : {}) }], time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) });
    this.groupMessages = this.groupMessages.slice(-20);
  }
  async exportAttachment(room: string, source: AttachmentSource, destination: string) {
    const current = await this.read(room);
    const message = current.messages.find(m => sameMessage(source.message, m));
    if (!message || message.attachments?.find(a => a.id === source.attachmentId)?.kind !== 'image') throw new Error('데모에서는 사진 원본 가져오기만 시험할 수 있습니다.');
    const name = 'KakaoTalk_Photo_demo.png';
    await writeFile(path.join(destination, name), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=', 'base64'));
    return name;
  }
  async list() { return { rooms: ['테스트 친구', '수학 수업방'], snapshot: await this.read('테스트 친구') }; }
  append(direction: 'incoming' | 'outgoing') { this.messages.push({ id: `demo-${++this.n}`, text: direction === 'incoming' ? `그럼 12시에 역 앞에서 보자! (${this.n})` : '응 좋아! 그때 보자 😊', direction, sender: direction === 'incoming' ? '테스트 친구' : '나', time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) }); this.messages = this.messages.slice(-20); }
  close() {}
}
