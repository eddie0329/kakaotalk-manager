import { useEffect, useState } from 'react';
import type { ChatMessage, RoomParticipants } from '../shared/types';

export function RoomParticipantsEditor({ room, group, value, messages, busy, onSave }: {
  room: string; group: boolean; value?: RoomParticipants; messages: ChatMessage[]; busy: boolean;
  onSave: (value: RoomParticipants | null) => void;
}) {
  const [enabled, setEnabled] = useState(group || !!value);
  const [questioners, setQuestioners] = useState('');
  const [teachers, setTeachers] = useState('');
  const saved = JSON.stringify(value);
  useEffect(() => {
    setEnabled(group || !!value); setQuestioners(value?.questioners.join('\n') ?? ''); setTeachers(value?.teachers.join('\n') ?? '');
  }, [room, saved]);
  // A connection failure may temporarily hide the group classification. Preserve unsaved
  // names in that case; only saved values or an actual room switch should reset the form.
  useEffect(() => { if (group) setEnabled(true); }, [group]);
  const names = (text: string) => [...new Set(text.split('\n').map(name => name.trim()).filter(Boolean))];
  const next = enabled ? { questioners: names(questioners), teachers: names(teachers) } : null;
  const dirty = JSON.stringify(next) !== JSON.stringify(value ?? null);
  const observed = [...new Set(messages.map(m => m.sender).filter(Boolean))];
  const append = (text: string, name: string) => [...new Set([...names(text), name])].join('\n');
  return <section className="panel participants-panel">
    <div className="panel-heading"><h2>이 방의 초안 대상</h2><span className="tiny-badge">방별 설정</span></div>
    {!group && <label className="participants-toggle"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/> 지정한 참여자만 감지</label>}
    {enabled ? <>
      <p className="field-note">카카오톡에 표시되는 이름을 한 줄에 한 명씩 입력해주세요. 이름이 같은 참여자는 구분할 수 없으므로 서로 다른 표시 이름을 사용해주세요.</p>
      <div className="participants-fields"><div><label htmlFor="questioners">초안을 만들어줄 질문자</label><textarea id="questioners" value={questioners} onChange={e => setQuestioners(e.target.value)} placeholder={'학생 이름\n학부모 이름'} maxLength={10100}/></div><div><label htmlFor="teachers">답하면 생성을 취소할 선생님</label><textarea id="teachers" value={teachers} onChange={e => setTeachers(e.target.value)} placeholder={'선생님 이름\n나'} maxLength={10100}/></div></div>
      <p className="field-note">내가 보낸 메시지도 취소 신호로 쓰려면 선생님 목록에 ‘나’를 등록해주세요. 질문 여부와 관계없이 생성하며, 선생님 메시지는 이 방의 모든 대기·생성을 취소해요.</p>
      {!!observed.length && <div className="observed-participants"><span>최근 대화에서 확인한 이름</span>{observed.map(name => <div key={name}><strong>{name}</strong>{name !== '나' && <button type="button" disabled={names(teachers).includes(name)} onClick={() => setQuestioners(append(questioners, name))}>질문자에 추가</button>}<button type="button" disabled={names(questioners).includes(name)} onClick={() => setTeachers(append(teachers, name))}>선생님에 추가</button></div>)}</div>}
    </> : <p className="field-note">기존 1:1 방식으로 모든 상대 메시지에 초안을 만듭니다.</p>}
    <div className="participants-save"><button className="button secondary small" disabled={busy || !dirty || (enabled && (!next?.questioners.length || !next.teachers.length))} onClick={() => onSave(next)}>참여자 설정 저장</button><span className="field-note">{dirty ? '저장하지 않은 변경 사항이 있어요.' : '저장된 설정이에요.'} 저장하면 이 방의 감지가 일시정지됩니다.</span></div>
  </section>;
}
