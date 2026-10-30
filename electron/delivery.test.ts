import { describe, expect, it, vi, afterEach } from 'vitest';
import { kakaoText, sendToMyKakao } from './delivery';
import type { Draft } from '../shared/types';
const draft: Draft = { id: '1', room: '친구', text: '안녕!', createdAt: 1, delivery: 'local' };
afterEach(() => vi.unstubAllGlobals());
describe('private draft delivery', () => {
  it('limits Kakao text to 200 Unicode characters and preserves the full local draft', () => {
    const long = { ...draft, text: '😊'.repeat(300) };
    expect(Array.from(kakaoText(long)).length).toBeLessThanOrEqual(200);
    expect(kakaoText(long)).toContain('전체 초안'); expect(long.text).toBe('😊'.repeat(300));
  });
  it('only calls the memo/self endpoint, with no recipient or chat-room automation', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ result_code: 0 }) })); vi.stubGlobal('fetch', fetch);
    await sendToMyKakao(draft, 'test-token', new AbortController().signal);
    expect(fetch.mock.calls[0][0]).toBe('https://kapi.kakao.com/v2/api/talk/memo/default/send');
  });
  it('does not automatically retry a rejected or expired token', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401 })); vi.stubGlobal('fetch', fetch);
    await expect(sendToMyKakao(draft, 'expired', new AbortController().signal)).rejects.toThrow('만료'); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
