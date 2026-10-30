import { assertMediaReady } from '../shared/media';
import { describe, expect, it } from 'vitest';
import { windowsDiagnostic, windowsSnapshot, type WindowsCapture, type WindowsNode } from './windows-snapshot';
import { decodeWindowsCapture } from './windows-reader';

function node(id: string, parent: string, type: string, name = '', geometry: Partial<WindowsNode> = {}): WindowsNode {
  return { id, parent, type, name, text: '', className: 'TestControl', left: 0, top: 0, width: 400, height: 20, textPattern: false, valuePattern: false, password: false, ...geometry };
}
function fixture(): WindowsCapture {
  return { status: 'ok', rooms: ['비공개 친구'], nodes: [
    node('window', '', 'Window', '비공개 친구'), node('participants', 'window', 'Button', '대화상대 2명'),
    node('compose', 'window', 'Edit', '메시지 입력'), node('list', 'window', 'List', '', { left: 100, width: 400 }),
    node('row-1', 'list', 'ListItem'), node('body-1', 'row-1', 'Text', '첫 번째 비공개 메시지', { left: 150, width: 120 }),
    node('time-1', 'row-1', 'Text', '오후 12:30'),
    node('row-2', 'list', 'ListItem'), node('body-2', 'row-2', 'Text', '두 번째 비공개 메시지', { left: 330, width: 140 })
  ] };
}
describe('Windows accessibility capture interpretation (synthetic layout)', () => {
  it('reads only message bodies and uses stable row identity, with separate directions', () => {
    const result = windowsSnapshot(fixture(), '비공개 친구', 'worker-1');
    expect(result.status).toBe('ready'); expect(result.chatKind).toBe('direct');
    expect(result.messages.map(message => message.direction)).toEqual(['incoming', 'outgoing']);
    expect(result.messages[0].time).toBe('오후 12:30');
    expect(result.messages[0].id).not.toContain('비공개');
    expect(windowsSnapshot(fixture(), '비공개 친구', 'worker-1').messages[0].id).toBe(result.messages[0].id);
    expect(windowsSnapshot(fixture(), '비공개 친구', 'worker-2').messages[0].id).not.toBe(result.messages[0].id);
  });
  it('does not pretend centered/long bubbles have a known sender', () => {
    const capture = fixture(); capture.nodes.at(-1)!.left = 150; capture.nodes.at(-1)!.width = 310;
    expect(windowsSnapshot(capture, '친구', 'worker').messages.at(-1)?.direction).toBe('unknown');
  });
  it('preserves newest attachment rows and requires their content before drafting', () => {
    const capture = fixture(); capture.nodes.push(node('attachment', 'row-2', 'Image', '사진'));
    const result = windowsSnapshot(capture, '친구', 'worker');
    expect(result.status).toBe('ready');
    expect(result.messages.at(-1)?.attachments?.[0].kind).toBe('image');
    expect(() => assertMediaReady(result.messages, [])).toThrow('사진·파일');
  });
  it('requires a positive header participant count; message text cannot impersonate a header', () => {
    const capture = fixture(); capture.nodes = capture.nodes.filter(node => node.id !== 'participants');
    capture.nodes.find(node => node.id === 'body-1')!.name = '대화상대 2명';
    expect(windowsSnapshot(capture, '친구', 'worker').status).toBe('unsupported_room');
    capture.nodes.push(node('group', 'window', 'Button', '참여자 3명'));
    expect(windowsSnapshot(capture, '친구', 'worker').chatKind).toBe('group');
    expect(windowsSnapshot(capture, '친구', 'worker').messages[0].sender).toBe('');
  });
  it('keeps self chat reception-only and does not infer it just from the window title', () => {
    const capture = fixture(); capture.nodes = capture.nodes.filter(node => node.id !== 'participants');
    expect(windowsSnapshot(capture, '나와의 채팅', 'worker').status).toBe('unsupported_room');
    capture.nodes.push(node('self', 'window', 'Button', '나와의 채팅'));
    expect(windowsSnapshot(capture, '나와의 채팅', 'worker').chatKind).toBe('self');
  });
  it('rejects minimized, ambiguous, truncated, malformed and duplicate-identity captures', () => {
    expect(windowsSnapshot({ ...fixture(), minimized: true }, '친구', 'w').status).toBe('room_closed');
    expect(windowsSnapshot({ ...fixture(), status: 'ambiguous_room' }, '친구', 'w').status).toBe('ambiguous_room');
    expect(windowsSnapshot({ ...fixture(), truncated: true }, '친구', 'w').status).toBe('error');
    expect(() => decodeWindowsCapture({ nodes: [] })).toThrow();
    const capture = fixture(); capture.nodes.push({ ...capture.nodes[0] });
    expect(() => decodeWindowsCapture(capture)).toThrow('중복');
  });
  it('exports structural diagnostics without window titles, message contents, sender names or IDs', () => {
    const report = JSON.stringify(windowsDiagnostic(fixture()));
    expect(report).not.toContain('비공개'); expect(report).not.toContain('row-1');
    expect(report).not.toContain('12:30'); expect(report).toContain('participantCount');
    expect(report).not.toContain('150'); expect(report).toContain('TestControl');
  });
});

describe('group sender extraction (synthetic layout)', () => {
  it('keeps explicit participant names separate from bodies and inherits only continuation rows', () => {
    const capture = fixture(); capture.nodes.find(n => n.id === 'participants')!.name = '대화상대 5명';
    capture.nodes.push(node('sender', 'row-1', 'Text', '학생 A', { className: 'SenderName' }));
    capture.nodes.push(node('profile', 'row-1', 'Button', '학생 A님 프로필'));
    capture.nodes.push(node('row-3', 'list', 'ListItem'), node('body-3', 'row-3', 'Text', '학생 B의 질문', { left: 150, width: 120 }), node('sender-3', 'row-3', 'Text', '학생 B', { className: 'SenderName' }));
    capture.nodes.push(node('row-4', 'list', 'ListItem'), node('body-4', 'row-4', 'Text', '추가 질문', { left: 150, width: 120 }));
    const result = windowsSnapshot(capture, '수학방', 'w');
    expect(result.status).toBe('ready'); expect(result.chatKind).toBe('group');
    expect(result.messages.map(m => m.sender)).toEqual(['학생 A', '나', '학생 B', '학생 B']);
    expect(result.messages[0].text).toBe('첫 번째 비공개 메시지');
  });
  it('never substitutes a room title or an earlier sender for an unidentified new profile', () => {
    const capture = fixture(); capture.nodes.find(n => n.id === 'participants')!.name = '대화상대 5명';
    capture.nodes.push(node('sender', 'row-1', 'Text', '학생 A', { className: 'SenderName' }));
    capture.nodes.push(node('row-3', 'list', 'ListItem'), node('body-3', 'row-3', 'Text', '누군가의 메시지', { left: 150, width: 120 }), node('profile', 'row-3', 'Button', '프로필'));
    const result = windowsSnapshot(capture, '수학방', 'w');
    expect(result.messages.at(-1)?.sender).toBe('');
  });
});

describe('mixed text and attachment history', () => {
  it('keeps image-only rows and file-only rows in order with sender, name and timestamp', () => {
    const capture = fixture();
    capture.nodes = capture.nodes.filter(n => n.id !== 'body-2');
    capture.nodes.push(node('photo', 'row-2', 'Image', '사진', { left: 330, width: 140 }));
    capture.nodes.push(node('row-3', 'list', 'ListItem'), node('filename', 'row-3', 'Text', '수학문제.hwp', { left: 150, width: 120 }), node('filesize', 'row-3', 'Text', '64 KB'), node('download', 'row-3', 'Button', '파일 다운로드', { left: 150, width: 120 }), node('time-3', 'row-3', 'Text', '오후 12:35'));
    const result = windowsSnapshot(capture, '친구', 'w');
    expect(result.status).toBe('ready'); expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toMatchObject({ text: '', direction: 'outgoing', sender: '나', attachments: [{ kind: 'image' }] });
    expect(result.messages[2]).toMatchObject({ text: '', direction: 'incoming', sender: '친구', time: '오후 12:35', attachments: [{ kind: 'file', name: '수학문제.hwp' }] });
  });
  it('does not treat profile pictures as chat attachments or plain filenames in messages as files', () => {
    const capture = fixture(); capture.nodes.find(n => n.id === 'body-1')!.name = '수학문제.pdf';
    capture.nodes.push(node('profile', 'row-1', 'Button', '친구님 프로필'), node('avatar', 'profile', 'Image', '친구 사진'));
    const result = windowsSnapshot(capture, '친구', 'w');
    expect(result.messages[0].text).toBe('수학문제.pdf'); expect(result.messages[0].attachments).toBeUndefined();
  });
  it('keeps unreadable attachment rows as unknown rather than silently omitting them', () => {
    const capture = fixture(); capture.nodes.push(node('row-3', 'list', 'ListItem'), node('link', 'row-3', 'Hyperlink', '첨부 보기', { left: 150, width: 120 }));
    const result = windowsSnapshot(capture, '친구', 'w');
    expect(result.messages.at(-1)?.attachments?.[0].kind).toBe('unknown');
    expect(result.messages).toHaveLength(3);
  });
  it('counts photo/file rows within the latest 20 messages and preserves stable IDs on repeat polls', () => {
    const capture = fixture();
    for (let i = 3; i <= 25; i++) capture.nodes.push(node(`row-${i}`, 'list', 'ListItem'), node(`photo-${i}`, `row-${i}`, 'Image', '사진', { left: 150, width: 120 }));
    const result = windowsSnapshot(capture, '친구', 'w'); expect(result.messages).toHaveLength(20);
    expect(result.messages.every(m => m.attachments?.[0].kind === 'image')).toBe(true);
    expect(windowsSnapshot(capture, '친구', 'w').messages).toEqual(result.messages);
  });
});
