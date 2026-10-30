import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface Environment {
  platform: string; arch: string; home: string; execPath: string;
  env: NodeJS.ProcessEnv; exists: (file: string) => boolean;
}
/** Resolve a native executable, including npm's optional platform package, without cmd.exe. */
export function resolveCodexPath(configured: string, context: Environment): string {
  const { platform, arch, home, execPath, env, exists } = context;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  const npmNative = (prefix: string) => {
    const architecture = arch === 'arm64' ? 'aarch64' : 'x86_64';
    const target = `${architecture}-pc-windows-msvc`;
    const relative = p.join('vendor', target, 'codex', 'codex.exe');
    return [
      p.join(prefix, 'node_modules', '@openai', 'codex', relative),
      p.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${arch}`, relative),
      p.join(prefix, 'node_modules', '@openai', `codex-win32-${arch}`, relative)
    ];
  };
  if (configured) {
    if (platform === 'win32' && /\.(cmd|ps1|bat)$/i.test(configured)) return npmNative(p.dirname(configured)).find(exists) ?? p.join(p.dirname(configured), name);
    return configured;
  }
  const directories = [env.CODEX_INSTALL_DIR, p.join(home, '.local', 'bin')];
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) directories.push(p.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'));
    if (env.APPDATA) directories.push(p.join(env.APPDATA, 'npm'));
  } else directories.push('/opt/homebrew/bin', '/usr/local/bin');
  directories.push(...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean), p.dirname(execPath));
  for (const directory of directories) {
    if (!directory) continue;
    const direct = p.join(directory, name);
    if (exists(direct)) return direct;
    if (platform === 'win32') { const native = npmNative(directory).find(exists); if (native) return native; }
  }
  return name;
}
export function codexExecutable(configured: string) {
  return resolveCodexPath(configured, { platform: process.platform, arch: process.arch, home: os.homedir(), execPath: process.execPath, env: process.env, exists: existsSync });
}
