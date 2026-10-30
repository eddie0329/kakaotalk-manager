import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, defaults, validateParticipants } from './store';
import type { ChatMessage, Draft } from '../shared/types';
const directories: string[] = [];
const temp = () => { const directory = mkdtempSync(path.join(os.tmpdir(), 'reply-note-store-test-')); directories.push(directory); return directory; };
const message = (id: string): ChatMessage => ({ id, text: id, direction: 'incoming', sender: '친구', time: '' });
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe('saved-room persistence', () => {
  it('migrates a previous single-room save without losing its prompt or context', () => {
    const directory = temp(); const previous = defaults();
    writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ settings: { ...previous.settings, room: '기존 채팅방', prompt: '기존 규칙' }, messages: [message('기존 대화')], drafts: [] }));
    const store = new Store(directory);
    expect(store.value.roomNames).toEqual(['기존 채팅방']);
    expect(store.value.messagesByRoom['기존 채팅방']).toEqual([message('기존 대화')]);
    expect(store.value.settings.prompt).toBe('기존 규칙');
  });
  it('persists separate bounded histories and excludes removed rooms on save', () => {
    const directory = temp(); const store = new Store(directory);
    store.value.roomNames = ['A', 'B']; store.value.settings.room = 'B';
    store.value.messagesByRoom = { A: Array.from({ length: 30 }, (_, i) => message(`A-${i}`)), B: [message('B-1')] };
    store.save(); const loaded = new Store(directory);
    expect(loaded.value.messagesByRoom.A).toHaveLength(20); expect(loaded.value.messagesByRoom.B).toEqual([message('B-1')]);
    loaded.value.roomNames = ['A']; loaded.value.settings.room = 'A'; loaded.save();
    expect(JSON.parse(readFileSync(path.join(directory, 'state.json'), 'utf8')).messagesByRoom.B).toBeUndefined();
  });
});

describe('editable draft persistence', () => {
  const draft = (id: string): Draft => ({ id, room: '친구', text: '생성 당시 원문', createdAt: 1, delivery: 'sent', model: 'example-model', effort: 'medium' });
  it('persists edits across restart while keeping original generation, delivery and other drafts intact', () => {
    const directory = temp(); const store = new Store(directory);
    const original = draft('first'); store.value.drafts = [original, draft('second')]; store.save();
    expect(store.updateDraft('first', '내가 수정한 답장\n두 번째 줄')).toBe(original);
    store.updateDraft('first', '한 번 더 수정');
    const loaded = new Store(directory);
    expect(loaded.value.drafts[0]).toMatchObject({ text: '한 번 더 수정', originalText: '생성 당시 원문', delivery: 'sent', model: 'example-model', effort: 'medium' });
    expect(loaded.value.drafts[0].editedAt).toBeTypeOf('number');
    expect(loaded.value.drafts[1].text).toBe('생성 당시 원문');
  });
  it('does not resurrect deleted drafts or accept invalid/oversized editor input', () => {
    const store = new Store(temp()); store.value.drafts = [draft('first')];
    expect(() => store.updateDraft('deleted', '수정')).toThrow('찾을 수 없습니다');
    for (const text of [null, 'x'.repeat(20_001), '널\0문자']) expect(() => store.updateDraft('first', text)).toThrow('20,000자');
    expect(store.value.drafts[0].text).toBe('생성 당시 원문');
    store.updateDraft('first', ''); expect(new Store(store.directory).value.drafts[0].text).toBe('');
  });
  it('does not mark an unchanged draft edited and rolls back failed persistence', () => {
    const store = new Store(temp()); store.value.drafts = [draft('first')];
    const save = vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('disk write failed'); });
    store.updateDraft('first', '생성 당시 원문'); expect(save).not.toHaveBeenCalled();
    expect(() => store.updateDraft('first', '저장 실패할 수정')).toThrow('disk write failed');
    expect(store.value.drafts[0]).toMatchObject({ text: '생성 당시 원문' });
    expect(store.value.drafts[0].editedAt).toBeUndefined(); expect(store.value.drafts[0].originalText).toBeUndefined();
    save.mockRestore();
  });
});

describe('group room rules and teacher response persistence', () => {
  it('keeps different participant lists per room across restart and removes deleted room rules', () => {
    const store = new Store(temp()); store.value.roomNames = ['A', 'B'];
    store.value.participantsByRoom = { A: { questioners: ['학생 A'], teachers: ['선생님 A', '나'] }, B: { questioners: ['학생 B'], teachers: ['선생님 B'] } };
    store.save();
    const loaded = new Store(store.directory); expect(loaded.value.participantsByRoom).toEqual(store.value.participantsByRoom);
    loaded.value.roomNames = ['B']; loaded.save(); expect(new Store(store.directory).value.participantsByRoom.A).toBeUndefined();
  });
  it('validates names, deduplicates exact matches and rejects overlapping roles', () => {
    expect(validateParticipants({ questioners: [' 학생 ', '학생'], teachers: ['선생님', '나'] })).toEqual({ questioners: ['학생'], teachers: ['선생님', '나'] });
    for (const rules of [null, { questioners: ['나'], teachers: [] }, { questioners: ['학생'], teachers: ['학생'] }, { questioners: ['학생\n가짜'], teachers: [] }, { questioners: [null], teachers: [] }]) expect(() => validateParticipants(rules)).toThrow();
  });
  it('marks only completed targeted drafts in the affected room and preserves edits and original text', () => {
    const store = new Store(temp());
    const base: Draft = { id: 'a', room: 'A', text: '수정한 초안', originalText: '생성한 초안', editedAt: 5, createdAt: 1, delivery: 'local', targetSender: '학생' };
    store.value.drafts = [base, { ...base, id: 'b', room: 'B' }, { ...base, id: 'direct', targetSender: undefined }];
    store.markTeacherResponse('A', '선생님', 10); store.markTeacherResponse('A', '나', 20);
    expect(store.value.drafts[0]).toMatchObject({ text: '수정한 초안', originalText: '생성한 초안', teacherResponse: { sender: '선생님', at: 10 } });
    expect(store.value.drafts[1].teacherResponse).toBeUndefined(); expect(store.value.drafts[2].teacherResponse).toBeUndefined();
    expect(new Store(store.directory).value.drafts[0].teacherResponse).toEqual({ sender: '선생님', at: 10 });
  });
  it('drops invalid group settings without erasing existing saved conversations', () => {
    const directory = temp(); writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ ...defaults(), roomNames: ['A'], participantsByRoom: { A: { teachers: 'invalid' } }, messagesByRoom: { A: [message('old')] } }));
    const store = new Store(directory); expect(store.value.roomNames).toEqual(['A']); expect(store.value.messagesByRoom.A).toHaveLength(1); expect(store.value.participantsByRoom.A).toBeUndefined();
  });
});
