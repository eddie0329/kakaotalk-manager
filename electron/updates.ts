import type { UpdateState } from '../shared/types';

const REPOSITORY = 'eddie0329/kakaotalk-manager';
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_PATH = `/${REPOSITORY}/releases/download/`;

function versionParts(version: string): number[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function newerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate), installed = versionParts(current);
  if (!next || !installed) throw new Error('버전 정보를 확인하지 못했습니다.');
  for (let i = 0; i < 3; i++) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}

export function trustedDownload(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith(RELEASE_PATH) && url.pathname.split('/').length === 7;
  } catch { return false; }
}

export function readRelease(input: unknown, current: string, platform: string, arch: string): Pick<UpdateState, 'status' | 'latestVersion' | 'notes' | 'downloadUrl' | 'message'> {
  if (!input || typeof input !== 'object') throw new Error('업데이트 정보를 확인하지 못했습니다.');
  const release = input as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !versionParts(release.tag_name)) {
    throw new Error('공개 배포 버전을 확인하지 못했습니다.');
  }
  const latestVersion = release.tag_name.replace(/^v/, '');
  const base = { latestVersion, notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '', downloadUrl: null };
  if (!newerVersion(latestVersion, current)) return { ...base, status: 'current', message: '현재 설치된 버전에서 업데이트할 새 버전이 없습니다.' };
  const name = platform === 'darwin' && (arch === 'arm64' || arch === 'x64')
    ? `Reply-Note-${latestVersion}-${arch}-mac.zip`
    : platform === 'win32' && arch === 'x64' ? `Reply-Note-Setup-${latestVersion}.exe` : null;
  const assets = Array.isArray(release.assets) ? release.assets as Array<Record<string, unknown>> : [];
  const expectedUrl = name ? `https://github.com${RELEASE_PATH}${release.tag_name}/${name}` : null;
  const asset = assets.find(item => item && item.name === name && item.state === 'uploaded' &&
    typeof item.size === 'number' && item.size > 0 && item.browser_download_url === expectedUrl && trustedDownload(item.browser_download_url));
  if (!asset) return { ...base, status: 'unavailable', message: `v${latestVersion}이 있지만 이 컴퓨터용 설치 파일은 아직 준비되지 않았습니다.` };
  return { ...base, status: 'available', downloadUrl: expectedUrl, message: `새 버전 v${latestVersion}을 다운로드할 수 있습니다.` };
}

interface Dependencies {
  version: string;
  platform: string;
  arch: string;
  changed(): void;
  fetch?: typeof fetch;
}

export class UpdateChecker {
  readonly state: UpdateState;
  private pending: Promise<void> | null = null;
  private controller = new AbortController();
  constructor(private readonly deps: Dependencies) {
    this.state = { status: 'idle', currentVersion: deps.version, latestVersion: null, checkedAt: null, notes: '', downloadUrl: null, message: '아직 업데이트를 확인하지 않았습니다.' };
  }
  async check(): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (this.pending) return this.pending;
    this.pending = this.run();
    try { await this.pending; } finally { this.pending = null; }
  }
  private async run() {
    Object.assign(this.state, { status: 'checking', message: '새 버전을 확인하고 있습니다.', downloadUrl: null });
    this.deps.changed();
    try {
      const response = await (this.deps.fetch ?? fetch)(API, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `Reply-Note/${this.deps.version}` },
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      if (response.status === 404) {
        Object.assign(this.state, { status: 'unavailable', latestVersion: null, notes: '', message: '공개된 배포 버전을 찾지 못했습니다. 잠시 후 다시 확인해주세요.' });
      } else {
        if (response.status === 403 || response.status === 429) throw new Error('업데이트 조회가 일시적으로 제한됐습니다. 잠시 후 다시 확인해주세요.');
        if (!response.ok) throw new Error('업데이트 서버에 연결하지 못했습니다. 잠시 후 다시 확인해주세요.');
        Object.assign(this.state, readRelease(await response.json(), this.deps.version, this.deps.platform, this.deps.arch));
      }
    } catch (error) {
      if (this.controller.signal.aborted) return;
      Object.assign(this.state, { status: 'error', latestVersion: null, notes: '', downloadUrl: null,
        message: error instanceof Error && error.message.startsWith('업데이트 ') ? error.message : '업데이트를 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해주세요.' });
    } finally {
      if (!this.controller.signal.aborted) { this.state.checkedAt = Date.now(); this.deps.changed(); }
    }
  }
  close() { this.controller.abort(); }
}
