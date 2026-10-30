import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** Windows child.kill terminates only the root, so explicitly cancel the Codex worker tree. */
export function stopProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM', grouped = false) {
  if (process.platform === 'win32' && child.pid) {
    const taskkill = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, error => { if (error) { try { child.kill(); } catch {} } });
  } else {
    try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
  }
}
