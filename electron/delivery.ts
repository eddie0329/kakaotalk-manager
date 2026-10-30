import type { Draft } from '../shared/types';
export function kakaoText(draft: Draft) {
  const text = `[${draft.room}${draft.targetSender ? ` · ${draft.targetSender}` : ''} 답장 초안]\n${draft.text}`;
  const characters = Array.from(text);
  return characters.length <= 200 ? text : characters.slice(0, 165).join('') + '\n…전체 초안은 Reply Note에서 확인해주세요.';
}
export async function sendToMyKakao(draft: Draft, token: string, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  const combined = AbortSignal.any([signal, timeout]);
  const response = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST', signal: combined,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ template_object: JSON.stringify({ object_type: 'text', text: kakaoText(draft), link: { web_url: 'https://www.kakaocorp.com/page/service/service/KakaoTalk', mobile_web_url: 'https://www.kakaocorp.com/page/service/service/KakaoTalk' }, button_title: '카카오톡' }) })
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('카카오 인증이 만료됐습니다. 연결 설정에서 액세스 토큰을 갱신해주세요.');
    if (response.status === 403) throw new Error('카카오 메시지 전송 권한(talk_message)과 앱 설정을 확인해주세요.');
    throw new Error('카카오톡 전달에 실패했습니다. 초안은 앱에 보관되어 있습니다.');
  }
  const result = await response.json() as { result_code?: number };
  if (result.result_code !== 0) throw new Error('카카오톡 전송 결과를 확인하지 못했습니다. 중복 방지를 위해 자동 재전송하지 않습니다.');
}
