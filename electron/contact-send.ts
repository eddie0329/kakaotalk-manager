import type { ContactSendResult } from '../shared/types';
import type { Store } from './store';

export class ContactSender {
  busyDraftId: string | null = null;
  constructor(private store: Store, private transport: (room: string, text: string) => Promise<ContactSendResult>, private allowedRoom: (room: string) => boolean, private beforeSend: (room: string) => void, private changed: () => void) {}
  async send(id: unknown, input: unknown): Promise<ContactSendResult> {
    if (this.busyDraftId) throw new Error('다른 초안을 전송하고 있습니다. 결과를 확인한 뒤 다시 시도해주세요.');
    if (typeof id !== 'string' || typeof input !== 'string' || !input.trim() || input.length > 20_000 || input.includes('\0')) throw new Error('보낼 초안 내용을 확인해주세요.');
    const draft = this.store.value.drafts.find(item => item.id === id);
    if (!draft || !this.allowedRoom(draft.room)) throw new Error('전송할 실제 채팅방을 선택해주세요.');
    if (draft.test && draft.testSource !== 'conversation') throw new Error('가상 대화 시험 초안은 실제 채팅방으로 전송할 수 없습니다.');
    const text = input.replace(/\r\n?/g, '\n');
    if (draft.contactSend?.outcome === 'sending' || draft.contactSend?.outcome === 'unknown') throw new Error('이 초안은 이전 전송 결과를 확인해야 합니다. 중복 방지를 위해 앱에서 다시 보내지 않습니다.');
    if (draft.contactSend?.outcome === 'sent' && draft.contactSend.text === text) throw new Error('같은 내용을 이미 전송했습니다.');
    this.store.updateDraft(id, text);
    const previous = draft.contactSend;
    draft.contactSend = { outcome: 'sending', text, at: Date.now() };
    try { this.store.save(); } catch (error) { draft.contactSend = previous; throw error; }
    this.busyDraftId = id; this.changed();
    let enteredTransport = false;
    let result: ContactSendResult;
    try {
      this.beforeSend(draft.room);
      enteredTransport = true;
      result = await this.transport(draft.room, text);
    } catch {
      result = { outcome: enteredTransport ? 'unknown' : 'failed', minimized: false, detail: enteredTransport ? '전송 결과를 확인하지 못했습니다. 중복 방지를 위해 자동 재전송하지 않습니다. 카톡방에서 직접 확인해주세요.' : '전송 준비 중 중단됐습니다. 메시지는 보내지 않았습니다.' };
    }
    draft.contactSend = { ...draft.contactSend!, outcome: result.outcome, detail: result.detail };
    try { this.store.save(); } catch { result = { ...result, detail: result.detail + ' 전송 기록 저장에도 실패했습니다. 앱을 종료하기 전에 카톡방을 확인해주세요.' }; }
    this.busyDraftId = null; this.changed(); return result;
  }
}
