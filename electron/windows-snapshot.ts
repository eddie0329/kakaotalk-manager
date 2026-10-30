import { createHash } from 'node:crypto';
import type { ChatAttachment, ChatMessage, Snapshot } from '../shared/types';

export interface WindowsNode {
  id: string; parent: string; type: string; className: string; name: string;
  text: string; left: number; top: number; width: number; height: number;
  textPattern: boolean; valuePattern: boolean; password: boolean;
}
export interface WindowsCapture {
  status: 'ok' | 'not_running' | 'room_closed' | 'ambiguous_room' | 'error';
  rooms: string[]; nodes: WindowsNode[]; minimized?: boolean; truncated?: boolean;
}
const timeOnly = /^(?:(?:오전|오후|AM|PM)\s*)?\d{1,2}:\d{2}(?:\s*(?:AM|PM))?$/i;
const participant = /^(?:대화상대|참여자|채팅방 참여자|Participants?)\s*[:(]?\s*(\d+)\s*(?:명|people)?\)?$/i;
const selfLabel = /^(?:나와의 채팅|Chat with myself|My chat)$/i;
const listType = /^(?:List|DataGrid|Table)$/;
const rowType = /^(?:ListItem|DataItem)$/;

/** Converts only structurally identified message rows, never a flattened window transcript. */
export function windowsSnapshot(capture: WindowsCapture, room: string, epoch: string): Snapshot {
  const base: Snapshot = { status: 'error', room, capturedAt: Date.now(), messages: [] };
  if (capture.status !== 'ok') {
    const detail = { not_running: '카카오톡을 실행하고 로그인해주세요.', room_closed: '선택한 채팅방을 별도 창으로 열어주세요.', ambiguous_room: '같은 제목의 창이 여러 개입니다. 채팅방 제목을 고유하게 바꿔주세요.', error: 'Windows 접근성 읽기에 실패했습니다. 카카오톡과 Reply Note를 같은 사용자 권한으로 실행해주세요.' };
    return { ...base, status: capture.status, detail: detail[capture.status] };
  }
  if (capture.minimized) return { ...base, status: 'room_closed', detail: '채팅방이 최소화되어 있습니다. 창을 복원한 뒤 다른 창 뒤에 두세요. 앱이 창을 앞으로 가져오지는 않습니다.' };
  if (capture.truncated) return { ...base, detail: '접근성 구조가 너무 크거나 읽기 시간이 초과됐습니다. 채팅방 창을 확인한 뒤 다시 연결해주세요.' };
  const byId = new Map(capture.nodes.map(node => [node.id, node]));
  const children = new Map<string, WindowsNode[]>();
  for (const node of capture.nodes) { const siblings = children.get(node.parent) ?? []; siblings.push(node); children.set(node.parent, siblings); }
  // Header controls only. Message bodies cannot assert their own participant count or self status.
  const inMessages = (node: WindowsNode) => {
    let parent = byId.get(node.parent);
    for (let depth = 0; parent && depth < 32; depth++, parent = byId.get(parent.parent)) if (listType.test(parent.type) || rowType.test(parent.type)) return true;
    return false;
  };
  const header = capture.nodes.filter(node => !inMessages(node) && ['Button', 'Text', 'MenuItem'].includes(node.type));
  const counts = header.map(node => participant.exec(node.name.trim())).filter(match => match !== null).map(match => Number(match[1]));
  const self = !counts.length && header.some(node => selfLabel.test(node.name.trim()));
  const direct = counts.length > 0 && counts.every(count => count === 2);
  const group = counts.length > 0 && counts.every(count => count > 2 && count === counts[0]);
  if (!self && !direct && !group) return { ...base, status: 'unsupported_room', detail: 'Windows 접근성에서 일반 채팅방 참여자 수를 확인하지 못했습니다. 연결 설정에서 구조 진단 파일을 저장할 수 있습니다.' };
  if (!capture.nodes.some(node => node.type === 'Edit' && !node.password)) return { ...base, status: 'unsupported_room', detail: '채팅 입력란을 확인하지 못했습니다. 일반 채팅방을 별도 창으로 열어주세요.' };
  const lists = capture.nodes.filter(node => listType.test(node.type) && node.width > 0 && (children.get(node.id) ?? []).some(row => rowType.test(row.type)));
  // Multiple lists may include a participant/file drawer; do not silently choose one.
  if (lists.length !== 1) return { ...base, status: 'unsupported_room', detail: 'Windows 접근성에서 메시지 목록을 구분하지 못했습니다. 채팅방 서랍을 닫고 다시 연결해주세요. 계속 실패하면 구조 진단 파일을 저장해주세요.' };
  const list = lists[0];
  const rows = (children.get(list.id) ?? []).filter(node => rowType.test(node.type)).slice(-60);
  const messages: ChatMessage[] = [];
  let previousSender = '';
  for (const row of rows) {
    const descendants: WindowsNode[] = [];
    const visit = (id: string, depth = 0) => { if (depth > 20) return; for (const node of children.get(id) ?? []) { descendants.push(node); visit(node.id, depth + 1); } };
    visit(row.id);
    // A complete row must expose exactly one textual body, excluding its timestamp.
    // Names on list rows may concatenate sender, file controls, and text and are never used as a fallback.
    const texts = descendants.filter(node => ['Text', 'Document'].includes(node.type) && !node.password && !(children.get(node.id)?.length));
    // Only explicit profile/sender controls identify group participants. Body text is never a fallback name.
    const profileNodes = descendants.filter(node => ['Button', 'Text'].includes(node.type) && (/^(?:SenderName|Nickname|ProfileName)$/i.test(node.className) || /^(?:.+님의? 프로필|프로필[:：] .+)$/.test(node.name.trim())));
    const senderNames = [...new Set(profileNodes.map(node => node.name.trim().replace(/님의? 프로필$/, '').replace(/^프로필[:：] /, '').trim()).filter(Boolean))];
    const hasProfile = descendants.some(node => node.type === 'Button' && /프로필|profile/i.test(node.name));
    const senderName = senderNames.length === 1 ? senderNames[0] : '';
    const underProfile = (node: WindowsNode) => {
      let current: WindowsNode | undefined = node;
      for (let depth = 0; current && current.id !== row.id && depth < 20; depth++, current = byId.get(current.parent)) {
        if (profileNodes.includes(current) || /avatar|profile/i.test(current.className) || (current.type === 'Button' && /프로필|profile/i.test(current.name))) return true;
      }
      return false;
    };
    const content = descendants.filter(node => !underProfile(node));
    const filePattern = /^[^/\\\r\n]{1,180}\.(?:pdf|docx?|hwpx?|xlsx?|pptx?|txt|csv|zip|7z|png|jpe?g|webp|gif|bmp|heic|mp4|mov|mp3|m4a)$/i;
    const sizes = /^(?:\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB)|다운로드|열기|저장)$/i;
    const fileNodes = content.filter(node => ['Button', 'Hyperlink', 'Text'].includes(node.type) && (/^(?:Attachment|FileName|FileDownload|FileOpen)$/i.test(node.className) || ((node.type === 'Button' || node.type === 'Hyperlink') && (filePattern.test(node.name.trim()) || /파일.*(?:다운로드|열기|저장)|download|attachment/i.test(node.name)))));
    const filenames = texts.filter(node => !underProfile(node) && filePattern.test((node.text || node.name).trim()));
    const hasFile = fileNodes.length > 0 || (filenames.length > 0 && texts.some(node => sizes.test((node.text || node.name).trim())));
    const images = content.filter(node => node.type === 'Image' && !/프로필|profile|avatar|파일.*아이콘|file.*icon|document.*icon/i.test(node.name));
    const attachments: ChatAttachment[] = [];
    if (hasFile) attachments.push({ id: 'media-0', kind: 'file', name: filenames[0] ? (filenames[0].text || filenames[0].name).trim() : fileNodes.map(n => n.name.trim()).find(name => filePattern.test(name)) });
    for (const image of images) {
      if (hasFile && !/사진|photo/i.test(image.name)) continue;
      const count = Number(/(\d+)\s*장/.exec(image.name)?.[1]) || undefined;
      attachments.push({ id: `media-${attachments.length}`, kind: 'image', ...(count ? { count } : {}) });
    }
    const payload = texts.filter(node => !underProfile(node) && (node.text || node.name).trim() && !timeOnly.test((node.text || node.name).trim()) && !profileNodes.includes(node) && !(senderName && (node.text || node.name).trim() === senderName) && !(hasFile && (filenames.includes(node) || sizes.test((node.text || node.name).trim()))));
    if (!payload.length && !attachments.length && /^(?:DateSeparator|UnreadSeparator)$/i.test(row.className)) { previousSender = ''; continue; }
    const ambiguous = payload.length > 1 || content.some(node => node.type === 'Hyperlink' && !fileNodes.includes(node));
    if (ambiguous || (!payload.length && !attachments.length)) attachments.push({ id: `media-${attachments.length}`, kind: 'unknown' });
    const bubble = payload.length === 1 ? payload[0] : images[0] ?? fileNodes[0];
    const text = !ambiguous && payload.length === 1 ? (payload[0].text || payload[0].name).trim() : '';
    if (text.length > 20_000) return { ...base, detail: '메시지 본문이 너무 길어 읽지 못했습니다.' };
    const leading = bubble && bubble.width > 0 ? (bubble.left - list.left) / list.width : -1;
    const trailing = bubble && bubble.width > 0 ? (list.left + list.width - bubble.left - bubble.width) / list.width : -1;
    const direction = self ? 'outgoing' : hasProfile || senderName ? 'incoming' : leading >= .35 && trailing >= 0 && trailing <= .12 ? 'outgoing'
      : leading >= 0 && leading <= .28 && trailing >= .30 ? 'incoming' : 'unknown';
    const hash = createHash('sha256').update(text + (attachments.length ? JSON.stringify(attachments) : '')).digest('hex').slice(0, 16);
    messages.push({ id: `${epoch}:${row.id}:${hash}`, text, ...(attachments.length ? { attachments } : {}), direction, sender: direction === 'outgoing' ? '나' : direction === 'incoming' ? group ? senderName || (!hasProfile && !profileNodes.length ? previousSender : '') : room : '', time: texts.map(node => (node.text || node.name).trim()).find(text => timeOnly.test(text)) ?? '' });
    previousSender = direction === 'incoming' ? messages.at(-1)!.sender : '';
  }
  if (!messages.length) return { ...base, status: 'unsupported_room', detail: '카카오톡이 Windows 접근성에 메시지 본문을 제공하지 않습니다. 이 버전의 레이아웃은 추가 확인이 필요합니다. 구조 진단 파일을 저장해주세요.' };
  return { ...base, status: 'ready', messages: messages.slice(-20), chatKind: self ? 'self' : group ? 'group' : 'direct' };
}

/** No titles, names, text, runtime IDs, or absolute screen coordinates leave this report. */
export function windowsDiagnostic(capture: WindowsCapture) {
  const indices = new Map(capture.nodes.map((node, index) => [node.id, index]));
  return {
    format: 1, platform: 'win32', status: capture.status, minimized: !!capture.minimized, truncated: !!capture.truncated,
    nodes: capture.nodes.map(node => ({
      parent: indices.get(node.parent) ?? -1, type: node.type.replace(/[^A-Za-z]/g, '').slice(0, 30),
      className: /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/.test(node.className) ? node.className : '(redacted)',
      hasName: !!node.name, hasText: !!node.text, textPattern: node.textPattern, valuePattern: node.valuePattern,
      participantCount: ['Button', 'Text', 'MenuItem'].includes(node.type) ? Number(participant.exec(node.name.trim())?.[1]) || null : null,
      selfLabel: selfLabel.test(node.name.trim()), password: node.password
    }))
  };
}
