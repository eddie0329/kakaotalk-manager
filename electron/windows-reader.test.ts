import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { WindowsReader } from './windows-reader';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
function worker(onRequest: (packet: any, child: any) => void) {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) { const packet = JSON.parse(chunk.toString()); queueMicrotask(() => onRequest(packet, child)); done(); } });
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
  return child;
}
describe('Windows reader worker protocol', () => {
  it('reuses one hidden worker and sends literal room names on stdin, with no shell', async () => {
    const packets: any[] = [];
    const child = worker((packet, process) => {
      packets.push(packet);
      process.stdout.write(JSON.stringify({ id: packet.id, capture: { status: 'not_running', rooms: [], nodes: [] } }) + '\n');
    });
    vi.mocked(spawn).mockReturnValueOnce(child);
    const reader = new WindowsReader('C:\\My App\\chat-reader.ps1');
    expect((await reader.list()).snapshot.status).toBe('not_running');
    expect((await reader.read('친구 & $(명령아님)')).status).toBe('not_running');
    expect(packets.map(packet => packet.op)).toEqual(['list', 'read']);
    expect(packets[1].room).toBe('친구 & $(명령아님)');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(args).not.toContain('친구 & $(명령아님)');
    expect(args).toContain('-NoProfile'); expect(args).toContain('-Mta');
    expect(options).toMatchObject({ windowsHide: true }); expect(options).not.toHaveProperty('shell', true);
    reader.close(); expect(child.kill).toHaveBeenCalled();
  });
  it('kills a stuck worker on timeout and recovers on the next request', async () => {
    vi.useFakeTimers();
    const stuck = worker(() => {});
    const recovered = worker((packet, process) => process.stdout.write(JSON.stringify({ id: packet.id, capture: { status: 'not_running', rooms: [], nodes: [] } }) + '\n'));
    vi.mocked(spawn).mockReturnValueOnce(stuck).mockReturnValueOnce(recovered);
    const reader = new WindowsReader('worker.ps1');
    const failed = expect(reader.read('친구')).rejects.toThrow('시간이 초과');
    await vi.advanceTimersByTimeAsync(14_001); await failed;
    expect(stuck.kill).toHaveBeenCalled();
    expect((await reader.list()).snapshot.status).toBe('not_running');
    reader.close();
  });
  it('rejects out-of-order or malformed replies and does not retain raw diagnostics', async () => {
    const child = worker((_packet, process) => process.stdout.write('{"id":999,"private":"private chat text"}\n'));
    vi.mocked(spawn).mockReturnValueOnce(child);
    const reader = new WindowsReader('worker.ps1');
    await expect(reader.read('친구')).rejects.toThrow('접근성 응답을 확인하지 못했습니다');
    expect(child.kill).toHaveBeenCalled(); reader.close();
  });
  it('cancels pending and queued requests when closing without spawning another worker', async () => {
    let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
    const child = worker(() => started()); vi.mocked(spawn).mockReturnValueOnce(child);
    const reader = new WindowsReader('worker.ps1');
    const one = expect(reader.read('친구1')).rejects.toThrow('종료');
    const two = expect(reader.read('친구2')).rejects.toThrow('종료');
    await start; reader.close();
    await Promise.all([one, two]); expect(spawn).toHaveBeenCalledTimes(1);
  });
});
