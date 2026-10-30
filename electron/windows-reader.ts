import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import path from 'node:path';
import { stopProcessTree } from './process-tree';
import type { Reader } from './reader';
import type { Snapshot } from '../shared/types';
import { windowsDiagnostic, windowsSnapshot, type WindowsCapture } from './windows-snapshot';

export function decodeWindowsCapture(raw: unknown): WindowsCapture {
  if (!raw || typeof raw !== 'object') throw new Error('Windows 접근성 응답 형식을 확인하지 못했습니다.');
  const data = raw as WindowsCapture;
  if (!['ok', 'not_running', 'room_closed', 'ambiguous_room', 'error'].includes(data.status)
    || !Array.isArray(data.rooms) || !data.rooms.every(room => typeof room === 'string' && room.length <= 200)
    || !Array.isArray(data.nodes) || data.nodes.length > 1200
    || data.nodes.some(node => !node || ['id', 'parent', 'type', 'className', 'name', 'text'].some(key => typeof node[key as keyof typeof node] !== 'string')
      || ['left', 'top', 'width', 'height'].some(key => !Number.isFinite(node[key as keyof typeof node]))
      || ['textPattern', 'valuePattern', 'password'].some(key => typeof node[key as keyof typeof node] !== 'boolean')
      || node.name.length > 20_000 || node.text.length > 20_000)) throw new Error('Windows 접근성 응답 형식을 확인하지 못했습니다.');
  if (new Set(data.nodes.map(node => node.id)).size !== data.nodes.length) throw new Error('Windows 접근성 항목이 중복되어 읽기를 중지했습니다.');
  return data;
}

/** One persistent, hidden Windows PowerShell 5.1 worker. Requests are serialized and time-bounded. */
export class WindowsReader implements Reader {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { id: number; resolve: (value: WindowsCapture) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private counter = 0;
  private epoch = randomUUID();
  private closed = false;
  constructor(private script: string) {}
  private stop(message: string) {
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    const child = this.child; this.child = null;
    this.lines?.close(); this.lines = null;
    child?.stdin.destroy(); if (child) stopProcessTree(child);
  }
  private start() {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // ExecutionPolicy is scoped to this worker; never changes the user's machine policy.
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-ExecutionPolicy', 'Bypass', '-File', this.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.epoch = randomUUID();
    const lines = createInterface({ input: child.stdout }); this.lines = lines;
    let received = 0;
    child.stdout.on('data', chunk => { received += chunk.length; if (received > 8 * 1024 * 1024 && this.child === child) this.stop('Windows 접근성 응답이 너무 커서 읽기를 중지했습니다.'); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { if (this.child === child) this.stop('Windows PowerShell을 실행하지 못했습니다. 설치 상태와 앱 실행 정책을 확인해주세요.'); });
    child.on('close', () => { if (this.child === child) this.stop('Windows 읽기 모듈이 종료됐습니다. PowerShell 실행 정책 또는 카카오톡 권한을 확인해주세요.'); });
    lines.on('line', line => {
      if (this.child !== child) return;
      received = 0;
      try {
        const packet = JSON.parse(line);
        if (!this.pending || packet.id !== this.pending.id) throw new Error('응답 순서가 일치하지 않습니다.');
        const capture = decodeWindowsCapture(packet.capture);
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(capture);
      } catch { this.stop('Windows 접근성 응답을 확인하지 못했습니다. 연결을 다시 확인해주세요.'); }
    });
  }
  private request(op: 'list' | 'read' | 'diagnose', room = ''): Promise<WindowsCapture> {
    const task = this.queue.catch(() => {}).then(() => new Promise<WindowsCapture>((resolve, reject) => {
      if (this.closed) { reject(new Error('Windows 읽기 모듈이 종료됐습니다.')); return; }
      if (!this.child) this.start();
      const id = ++this.counter;
      const timer = setTimeout(() => this.stop('Windows 대화 읽기 시간이 초과됐습니다. 채팅방을 복원하고 다시 확인해주세요.'), 14_000);
      this.pending = { id, resolve, reject, timer };
      this.child!.stdin.write(JSON.stringify({ id, op, room }) + '\n');
    }));
    this.queue = task; return task;
  }
  async read(room: string): Promise<Snapshot> { const capture = await this.request('read', room); return windowsSnapshot(capture, room, this.epoch); }
  async list() {
    const capture = await this.request('list');
    const snapshot: Snapshot = capture.status === 'ok'
      ? { status: capture.truncated ? 'error' : 'ready', room: '', messages: [], capturedAt: Date.now(), detail: capture.truncated ? '열린 창 목록 읽기가 시간 내에 완료되지 않았습니다. 다시 확인해주세요.' : '열린 채팅방 목록을 확인했습니다. 채팅방을 추가하면 실제 대화를 확인합니다.' }
      : windowsSnapshot(capture, '', this.epoch);
    return { rooms: capture.rooms, snapshot };
  }
  async diagnostic(room: string) { return windowsDiagnostic(await this.request('diagnose', room)); }
  close() { this.closed = true; this.stop('앱이 종료되어 대화 읽기를 취소했습니다.'); }
}
