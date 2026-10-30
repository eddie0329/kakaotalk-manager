import { describe, expect, it } from 'vitest';
import { resolveCodexPath } from './codex-path';
const context = (files: string[], env: NodeJS.ProcessEnv = {}) => ({ platform: 'win32', arch: 'x64', home: 'C:\\Users\\Tester', execPath: 'C:\\Apps\\Reply Note.exe', env, exists: (file: string) => files.includes(file) });
describe('Windows native Codex discovery', () => {
  it('finds standalone installer executables outside inherited PATH', () => {
    const file = 'C:\\Users\\Tester\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
    expect(resolveCodexPath('', context([file], { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' }))).toBe(file);
  });
  it('resolves npm shims to the native platform package without a shell', () => {
    const prefix = 'C:\\Users\\Tester\\AppData\\Roaming\\npm';
    const file = `${prefix}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`;
    expect(resolveCodexPath('', context([file], { APPDATA: 'C:\\Users\\Tester\\AppData\\Roaming' }))).toBe(file);
    expect(resolveCodexPath(`${prefix}\\codex.cmd`, context([file]))).toBe(file);
    expect(resolveCodexPath(`${prefix}\\codex.ps1`, context([file]))).toBe(file);
  });
  it('preserves a configured native executable path, including spaces', () => {
    expect(resolveCodexPath('D:\\My Tools\\codex.exe', context([]))).toBe('D:\\My Tools\\codex.exe');
  });
  it('honors installer directory and Windows Path casing', () => {
    expect(resolveCodexPath('', context(['D:\\Codex\\codex.exe'], { CODEX_INSTALL_DIR: 'D:\\Codex' }))).toBe('D:\\Codex\\codex.exe');
    expect(resolveCodexPath('', context(['D:\\Tools\\codex.exe'], { Path: 'D:\\Tools;C:\\Windows' }))).toBe('D:\\Tools\\codex.exe');
  });
});
