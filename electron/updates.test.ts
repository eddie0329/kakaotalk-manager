import { describe, expect, it, vi } from 'vitest';
import { newerVersion, readRelease, trustedDownload, UpdateChecker } from './updates';

const repo = 'https://github.com/eddie0329/kakaotalk-manager/releases/download/v0.5.0/';
function release() {
  return { tag_name: 'v0.5.0', draft: false, prerelease: false, body: '변경 내용', assets: [
    { name: 'Reply-Note-0.5.0-arm64-mac.zip', state: 'uploaded', size: 100, browser_download_url: repo + 'Reply-Note-0.5.0-arm64-mac.zip' },
    { name: 'Reply-Note-Setup-0.5.0.exe', state: 'uploaded', size: 200, browser_download_url: repo + 'Reply-Note-Setup-0.5.0.exe' },
  ] };
}
function fixture(fetcher: typeof fetch) {
  const changed = vi.fn();
  return { center: new UpdateChecker({ version: '0.4.4', platform: 'darwin', arch: 'arm64', changed, fetch: fetcher }), changed };
}
describe('release update checks', () => {
  it('compares versions numerically and never offers a downgrade', () => {
    expect(newerVersion('v0.10.0', '0.9.9')).toBe(true);
    expect(newerVersion('v0.4.4', '0.4.4')).toBe(false);
    expect(newerVersion('v0.4.3', '0.4.4')).toBe(false);
    expect(readRelease(release(), '0.6.0', 'darwin', 'arm64').status).toBe('current');
    expect(() => newerVersion('0.5.0-beta.1', '0.4.4')).toThrow();
  });
  it('selects only the exact installer for the current OS and architecture', () => {
    expect(readRelease(release(), '0.4.4', 'darwin', 'arm64').downloadUrl).toMatch(/arm64-mac.zip$/);
    expect(readRelease(release(), '0.4.4', 'win32', 'x64').downloadUrl).toMatch(/Setup-0.5.0.exe$/);
    for (const [os, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'x64']]) {
      expect(readRelease(release(), '0.4.4', os, arch)).toMatchObject({ status: 'unavailable', downloadUrl: null });
    }
  });
  it('rejects draft, prerelease and malformed release metadata', () => {
    for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: '../wrong' }, { tag_name: 'v0.5.0-beta.1' }]) {
      expect(() => readRelease({ ...release(), ...patch }, '0.4.4', 'darwin', 'arm64')).toThrow();
    }
    expect(() => readRelease(null, '0.4.4', 'darwin', 'arm64')).toThrow();
  });
  it('does not open assets from another repository, tag, host, or protocol', () => {
    for (const url of ['https://example.com/app.zip', repo.replace('github.com', 'github.com.attacker.test') + 'app.zip', repo.replace('v0.5.0', 'v0.4.0') + 'Reply-Note-0.5.0-arm64-mac.zip', 'file:///tmp/app.zip']) {
      const data = release(); data.assets[0].browser_download_url = url;
      expect(readRelease(data, '0.4.4', 'darwin', 'arm64').downloadUrl).toBeNull();
    }
    expect(trustedDownload(repo + 'Reply-Note-0.5.0-arm64-mac.zip')).toBe(true);
    for (const url of [repo.replace('https:', 'http:') + 'file', repo.replace('github.com', 'evil@github.com') + 'file', repo + 'file?redirect=evil', 'javascript:alert(1)']) expect(trustedDownload(url)).toBe(false);
  });
  it('does not offer an incomplete or empty upload', () => {
    for (const patch of [{ state: 'starter' }, { size: 0 }]) {
      const data = release(); Object.assign(data.assets[0], patch);
      expect(readRelease(data, '0.4.4', 'darwin', 'arm64').status).toBe('unavailable');
    }
  });
  it('coalesces simultaneous checks and sends no chat or authentication data', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(r => { resolve = r; }));
    const { center, changed } = fixture(fetcher);
    const first = center.check(), second = center.check();
    expect(center.state.status).toBe('checking'); expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/eddie0329/kakaotalk-manager/releases/latest');
    expect(request?.body).toBeUndefined();
    expect(JSON.stringify(request?.headers)).not.toMatch(/authorization|token/i);
    resolve(new Response(JSON.stringify(release()))); await Promise.all([first, second]);
    expect(center.state).toMatchObject({ status: 'available', latestVersion: '0.5.0' });
    expect(center.state.checkedAt).toBeTypeOf('number'); expect(changed).toHaveBeenCalledTimes(2);
  });
  it('shows network, timeout and malformed response failures without claiming to be current', async () => {
    for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new Error('private/path/token')), vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timeout', 'TimeoutError')), vi.fn<typeof fetch>().mockResolvedValue(new Response('invalid-json'))]) {
      const { center } = fixture(fetcher); await center.check();
      expect(center.state).toMatchObject({ status: 'error', downloadUrl: null });
      expect(center.state.message).not.toContain('private');
    }
  });
  it('handles missing releases and rate limits, then allows a retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValue(new Response(JSON.stringify(release())));
    const { center } = fixture(fetcher);
    await center.check(); expect(center.state.status).toBe('unavailable');
    await center.check(); expect(center.state.message).toContain('제한');
    await center.check(); expect(center.state.status).toBe('available');
  });
  it('aborts on quit and prevents future checks', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const { center, changed } = fixture(fetcher);
    const work = center.check(); center.close(); await work; await center.check();
    expect(fetcher).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
  });
});
