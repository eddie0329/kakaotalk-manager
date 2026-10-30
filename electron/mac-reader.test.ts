import { describe, expect, it, vi } from 'vitest';
import { MacReader } from './reader';

function fixture() {
  const calls: Array<{ id: number; op: string; room: string; text?: string }> = [];
  const replies: Array<(value?: object) => void> = [];
  const native = { request: vi.fn((raw: string) => {
    const packet = JSON.parse(raw); calls.push(packet);
    return new Promise<string>(resolve => replies.push((extra = {}) => resolve(JSON.stringify({ id: packet.id, status: 'ready', room: packet.room, messages: [], ...extra }))));
  }) };
  return { reader: new MacReader('unused.node', () => native), calls, replies };
}
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
describe('Mac native scheduling', () => {
  it('runs manual send before queued polling, without interrupting an active read', async () => {
    const f = fixture(); const first = f.reader.read('A'); await turn();
    const second = f.reader.read('B'); const list = f.reader.list(); const send = f.reader.send('C', 'edited body');
    await turn(); expect(f.calls.map(c => c.op)).toEqual(['read']);
    f.replies[0](); await first; await turn();
    expect(f.calls[1]).toMatchObject({ op: 'send', room: 'C', text: 'edited body' });
    f.replies[1]({ sendOutcome: 'sent', minimized: true }); expect(await send).toMatchObject({ outcome: 'sent', minimized: true }); await turn();
    expect(f.calls[2]).toMatchObject({ op: 'read', room: 'B' }); f.replies[2](); await second; await turn();
    expect(f.calls[3].op).toBe('list'); f.replies[3](); await list;
  });
  it('retains FIFO among sends and recovers after a malformed response', async () => {
    const f = fixture(); const read = f.reader.read('A'); await turn();
    const one = f.reader.send('B', 'one'); const failed = expect(one).rejects.toThrow('전송 응답');
    const two = f.reader.send('C', 'two'); f.replies[0](); await read; await turn();
    f.replies[1](); await failed; await turn(); expect(f.calls[2]).toMatchObject({ room: 'C', text: 'two' });
    f.replies[2]({ sendOutcome: 'unknown', minimized: false }); expect((await two).outcome).toBe('unknown');
    expect(f.calls.filter(c => c.op === 'send')).toHaveLength(2);
  });
  it('does not overlap a native call that remains unresolved after timeout or auto-retry a send', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const read = expect(f.reader.read('A')).rejects.toThrow('지연'); await turn();
      const send = expect(f.reader.send('B', 'body')).rejects.toThrow('이전 대화 읽기');
      await vi.advanceTimersByTimeAsync(14_001); await read; await send;
      expect(f.calls).toHaveLength(1);
      f.replies[0](); await turn(); const recovered = f.reader.read('C'); await turn();
      expect(f.calls[1].room).toBe('C'); f.replies[1](); await recovered;
    } finally { vi.useRealTimers(); }
  });
  it('keeps the reader epoch on message IDs after scheduling changes', async () => {
    const f = fixture(); const read = f.reader.read('A'); await turn();
    f.replies[0]({ messages: [{ id: 'row-1', text: 'body', direction: 'outgoing', sender: '나', time: '' }] });
    expect((await read).messages[0].id).toMatch(/^[0-9a-f-]+:row-1$/);
  });
});

it('keeps media identity stable across key order changes and separates reused rows with different attachments', async () => {
  let message = { id: 'row-media', text: '', direction: 'incoming', sender: '학생', time: '', attachments: [{ id: 'media-0', kind: 'image', name: '' }] };
  const reader = new MacReader('unused', () => ({ request: async raw => { const packet = JSON.parse(raw); return JSON.stringify({ id: packet.id, status: 'ready', room: packet.room, messages: [message] }); } }));
  const first = await reader.read('수학방');
  message = { ...message, attachments: [{ name: '', kind: 'image', id: 'media-0' }] };
  expect((await reader.read('수학방')).messages[0].id).toBe(first.messages[0].id);
  message = { ...message, attachments: [{ name: '다른파일.pdf', kind: 'file', id: 'media-0' }] };
  expect((await reader.read('수학방')).messages[0].id).not.toBe(first.messages[0].id);
});

it('exports using its cached raw message identity and rejects forged sources without a native action', async () => {
  const packets: any[] = [];
  const raw = { id: 'native-row', text: '', direction: 'outgoing', sender: '나', time: '', attachments: [{ id: 'media-0', kind: 'image' }] };
  const reader = new MacReader('unused', () => ({ request: async value => {
    const packet = JSON.parse(value); packets.push(packet);
    return JSON.stringify({ id: packet.id, status: 'ready', messages: packet.op === 'read' ? [raw] : [], exportedName: packet.op === 'export' ? 'photo.jpeg' : undefined });
  } }));
  const message = (await reader.read('self')).messages[0];
  await expect(reader.exportAttachment('other', { message, attachmentId: 'media-0' }, '/capture-test')).rejects.toThrow();
  await expect(reader.exportAttachment('self', { message: { ...message, text: 'forged' }, attachmentId: 'media-0' }, '/capture-test')).rejects.toThrow();
  expect(packets).toHaveLength(1);
  expect(await reader.exportAttachment('self', { message, attachmentId: 'media-0' }, '/capture-test')).toBe('photo.jpeg');
  expect(packets[1]).toMatchObject({ op: 'export', rowId: 'native-row', expectedMessage: raw, destination: '/capture-test' });
});
