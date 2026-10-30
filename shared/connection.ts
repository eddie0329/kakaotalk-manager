import type { MonitorState } from './types';

export function connectionLabel(state: Pick<MonitorState, 'readerStatus' | 'phase' | 'enabled'> & { chatKind?: MonitorState['chatKind'] }): string {
  switch (state.readerStatus) {
    case 'permission_required': return '손쉬운 사용 권한 확인 필요';
    case 'not_running': return '카카오톡 실행 필요';
    case 'room_closed': return '채팅방 열기 · 이름 확인 필요';
    case 'ambiguous_room': return '동일한 채팅방 이름 확인 필요';
    case 'unsupported_room': return '지원하지 않는 채팅방';
    case 'unsupported_platform': return '지원하지 않는 운영체제';
    case 'error': return '대화 읽기 오류';
    case 'ready': return state.chatKind === 'self' ? '나와의 채팅 · 수동 초안 가능' : state.enabled ? '대화 연결됨' : '연결 확인됨 · 감지 중지';
    default: return state.phase === 'connecting' ? '연결 확인 중' : '연결 확인 전';
  }
}
export function attentionLabel(state: MonitorState): string {
  if (state.phase === 'needs_materials') return '사진·파일 확인 필요';
  if (state.phase === 'error') return '초안 생성 실패';
  if (state.phase === 'needs_attention' && state.readerStatus === 'ready') return '발신자 확인 필요';
  return connectionLabel(state);
}
