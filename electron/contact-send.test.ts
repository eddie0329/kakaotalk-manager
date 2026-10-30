import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store';
import { ContactSender } from './contact-send';
import type { ContactSendResult } from '../shared/types';

const directories: string[] = [];
function fixture(transport = vi.fn(async (): Promise<ContactSendResult> => ({ outcome: 'sent', detail: '대화에서 확인됨', minimized: true }))) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'reply-note-contact-')); directories.push(directory);
  const store = new Store(directory); store.value.drafts = [{ id: 'draft', room: '친구', text: '원문', createdAt: 1, delivery: 'local' }]; store.save();
  const sender = new ContactSender(store, transport, room => room === '친구', vi.fn(), vi.fn());
  return { directory, store, sender, transport };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe('manual contact send transaction', () => {
  it('sends the reviewed edited text to its own room and persists an attempt before touching KakaoTalk', async () => {
    const f = fixture();
    f.transport.mockImplementationOnce(async () => {
      expect(new Store(f.directory).value.drafts[0].contactSend).toMatchObject({ outcome: 'unknown', text: '수정한 답장\n둘째 줄' });
      return { outcome: 'sent', detail: '대화에서 확인됨', minimized: true };
    });
    await f.sender.send('draft', '수정한 답장\r\n둘째 줄');
    expect(f.transport).toHaveBeenCalledWith('친구', '수정한 답장\n둘째 줄');
    expect(new Store(f.directory).value.drafts[0]).toMatchObject({ text: '수정한 답장\n둘째 줄', originalText: '원문', contactSend: { outcome: 'sent' } });
    expect(f.sender.busyDraftId).toBeNull();
  });
  it('blocks duplicate clicks and concurrent requests, including after a successful send', async () => {
    let finish!: (result: ContactSendResult) => void;
    const f = fixture(vi.fn(() => new Promise<ContactSendResult>(resolve => { finish = resolve; })));
    const first = f.sender.send('draft', '보낼 답장');
    await expect(f.sender.send('draft', '보낼 답장')).rejects.toThrow('전송하고');
    finish({ outcome: 'sent', detail: '확인됨', minimized: true }); await first;
    await expect(f.sender.send('draft', '보낼 답장')).rejects.toThrow('이미 전송');
    expect(f.transport).toHaveBeenCalledOnce();
  });
  it('does not retry an ambiguous result, even if the text changes or the app restarts', async () => {
    const f = fixture(vi.fn(async () => { throw new Error('native timeout after possible send'); }));
    expect((await f.sender.send('draft', '답장')).outcome).toBe('unknown');
    await expect(f.sender.send('draft', '새 답장')).rejects.toThrow('이전 전송 결과');
    expect(new Store(f.directory).value.drafts[0].contactSend?.outcome).toBe('unknown');
    expect(f.transport).toHaveBeenCalledOnce();
  });
  it('permits another manual attempt when the native preflight explicitly says no send occurred', async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce({ outcome: 'failed', detail: '기존 입력이 있어 중단', minimized: true });
    await f.sender.send('draft', '답장');
    expect((await f.sender.send('draft', '답장')).outcome).toBe('sent');
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it('rejects deleted, synthetic, invalid and unselected-room drafts before any native action', async () => {
    const f = fixture();
    await expect(f.sender.send('missing', '내용')).rejects.toThrow('실제 채팅방');
    await expect(f.sender.send('draft', '')).rejects.toThrow('내용');
    f.store.value.drafts[0].test = true;
    await expect(f.sender.send('draft', '내용')).rejects.toThrow('가상 대화');
    f.store.value.drafts[0].test = false; f.store.value.drafts[0].room = '다른 방';
    await expect(f.sender.send('draft', '내용')).rejects.toThrow('실제 채팅방');
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('does not send when it cannot persist the attempt', async () => {
    const f = fixture(); const save = vi.spyOn(f.store, 'save').mockImplementationOnce(() => { throw new Error('disk error'); });
    await expect(f.sender.send('draft', '원문')).rejects.toThrow('disk error');
    expect(f.transport).not.toHaveBeenCalled(); expect(f.store.value.drafts[0].contactSend).toBeUndefined(); save.mockRestore();
  });
});
