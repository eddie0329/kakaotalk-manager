// 공개된 GitHub Release 파일의 HTTPS URL과 버전을 입력하면 버튼이 활성화됩니다.
// null인 동안에는 다운로드를 제공하지 않습니다.
const releases = {
  mac: { url: 'https://github.com/eddie0329/kakaotalk-manager/releases/download/v0.4.2/Reply-Note-0.4.2-arm64-mac.zip', version: '0.4.2' },
  windows: { url: 'https://github.com/eddie0329/kakaotalk-manager/releases/download/v0.4.2/Reply-Note-Setup-0.4.2.exe', version: '0.4.2' },
};

for (const [platform, release] of Object.entries(releases)) {
  if (!release.url) continue;
  let url;
  try { url = new URL(release.url); } catch { continue; }
  if (url.protocol !== 'https:') continue;
  const button = document.querySelector(`[data-platform="${platform}"]`);
  button.href = url.href;
  button.removeAttribute('aria-disabled');
  button.textContent = `${platform === 'mac' ? 'Mac' : 'Windows'} 다운로드 ↓`;
  if (release.version) document.querySelector(`[data-version="${platform}"]`).textContent = `v${release.version} · 베타`;
}
