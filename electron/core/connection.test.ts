import { describe, expect, it } from 'vitest';
import { attentionLabel, connectionLabel } from '../../shared/connection';
import { Monitor } from './monitor';
import type { Settings } from '../../shared/types';
const settings: Settings = { room: '친구', prompt: '자연스럽게', codexPath: '', model: '', delivery: 'app' };
describe('connection diagnostics', () => {
  it('shows actionable permission and room-name errors while paused', () => {
    expect(connectionLabel({ enabled: false, phase: 'paused', readerStatus: 'permission_required' })).toContain('권한');
    expect(connectionLabel({ enabled: false, phase: 'paused', readerStatus: 'room_closed' })).toContain('이름');
    expect(connectionLabel({ enabled: false, phase: 'paused', readerStatus: 'unsupported_room' })).toContain('지원하지');
    expect(connectionLabel({ enabled: false, phase: 'paused', readerStatus: 'ready' })).toContain('감지 중지');
  });
  it('a connection probe checks the room without enabling generation or seeding a reply', () => {
    const monitor = new Monitor(settings, { generate: async () => '', recheck: async () => { throw new Error('unused'); }, publish: async () => {}, changed: () => {} });
    monitor.inspect({ status: 'ready', room: '친구', messages: [], capturedAt: Date.now() });
    expect(monitor.state.enabled).toBe(false); expect(monitor.state.phase).toBe('paused');
    expect(monitor.state.detail).toContain('감지 시작');
    monitor.configure({ ...settings, room: '다른 사람' }); expect(monitor.state.readerStatus).toBeNull();
  });
  it('labels self-chat with manual draft availability', () => {
    expect(connectionLabel({ enabled: true, phase: 'watching', readerStatus: 'ready', chatKind: 'self' })).toContain('수동 초안');
  });
  it('keeps saved context when an offline room is inspected while paused', () => {
    const monitor = new Monitor(settings, { generate: async () => '', recheck: async () => { throw new Error('unused'); }, publish: async () => {}, changed: () => {} });
    monitor.state.messages = [{ id: 'saved', text: '저장된 대화', direction: 'incoming', sender: '친구', time: '' }];
    monitor.inspect({ status: 'room_closed', room: '친구', messages: [], capturedAt: Date.now() });
    expect(monitor.state.messages[0].id).toBe('saved');
    expect(monitor.state.enabled).toBe(false); expect(monitor.state.readerStatus).toBe('room_closed');
  });
  it('exposes a concrete attention reason instead of a generic connection warning', () => {
    const monitor = new Monitor(settings, { generate: async () => '', recheck: async () => { throw new Error('unused'); }, publish: async () => {}, changed: () => {} });
    monitor.state.phase = 'needs_attention'; monitor.state.readerStatus = 'unsupported_room';
    expect(attentionLabel(monitor.state)).toContain('지원하지');
    monitor.state.readerStatus = 'permission_required'; expect(attentionLabel(monitor.state)).toContain('권한');
    monitor.state.phase = 'error'; expect(attentionLabel(monitor.state)).toBe('초안 생성 실패');
  });
});
