import { useState } from 'react';
import type { ChatMessage, RoomParticipants } from '../shared/types';
import { PERSON_PROMPT_LIMIT } from '../shared/person-prompts';

export function PersonPromptsEditor({ room, group, participants, messages, value = {}, busy, onSave }: {
  room: string; group: boolean; participants?: RoomParticipants; messages: ChatMessage[];
  value?: Record<string, string>; busy: boolean; onSave: (name: string, prompt: string) => Promise<void>;
}) {
  const perPerson = group || !!participants;
  const names = perPerson ? [...new Set([...(participants?.questioners ?? []), ...messages.filter(m => m.direction === 'incoming').map(m => m.sender), ...Object.keys(value)])].filter(name => !!name && name !== '나') : [room];
  const [selected, setSelected] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const name = names.includes(selected) ? selected : names[0] ?? '';
  const saved = Object.hasOwn(value, name) ? value[name] : '';
  const text = Object.hasOwn(edits, name) ? edits[name] : saved;
  const dirty = text.trim() !== saved;
  async function save() {
    const reviewedName = name, reviewedText = text;
    await onSave(reviewedName, reviewedText);
    setEdits(current => {
      if (current[reviewedName] !== reviewedText) return current;
      const remaining = { ...current }; delete remaining[reviewedName]; return remaining;
    });
  }
  return <details className="panel person-prompts-panel">
    <summary className="panel-heading"><h2>사람별 프롬프트</h2><span className="tiny-badge">{Object.keys(value).length ? `${Object.keys(value).length}명 저장 · ` : ''}이 방에만 적용</span></summary>
    <p className="field-note">공통 프롬프트에 추가할 말투와 호칭을 적어주세요. 존댓말·말투가 충돌하면 개인 지침을 우선해요. 비워서 저장하면 공통 프롬프트만 사용해요.</p>
    {names.length ? <>
      <label htmlFor="person-prompt-name">답변 대상</label>
      <select id="person-prompt-name" disabled={busy} value={name} onChange={event => setSelected(event.target.value)}>{names.map(person => <option key={person} value={person}>{person}</option>)}</select>
      <label htmlFor="person-prompt-text">{name}님에게 적용할 지침</label>
      <textarea id="person-prompt-text" disabled={busy} value={text} onChange={event => setEdits(current => ({ ...current, [name]: event.target.value }))} maxLength={PERSON_PROMPT_LIMIT} placeholder={'예: 항상 정중한 존댓말을 사용해줘.\n호칭은 ‘선생님’으로 하고, 이모티콘은 사용하지 마.'}/>
      <div className="participants-save"><button type="button" className="button secondary small" disabled={busy || !dirty} onClick={() => { void save().catch(() => {}); }}>개인 프롬프트 저장</button><span className="field-note">{dirty ? '저장하지 않은 변경 사항이 있어요.' : '저장된 설정이에요.'} {text.length.toLocaleString()} / 5,000</span></div>
      <p className="field-note">저장하면 이 방의 대기·생성을 취소하고 감지를 일시정지해요. 감지를 다시 시작하면 새 지침으로 작성해요.</p>
    </> : <p className="field-note">위에서 질문자를 등록하면 사람별 지침을 설정할 수 있어요.</p>}
  </details>;
}
