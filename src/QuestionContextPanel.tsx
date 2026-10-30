import { useEffect, useId, useState } from 'react';
import { FileText, Paperclip, Sparkles, Trash2 } from 'lucide-react';
import { attachmentKey, attachmentLabel, messageLabel, sameMessage, unresolvedAttachments } from '../shared/media';
import type { AppState, AttachmentSelection, ChatMessage, QuestionContext } from '../shared/types';

type ContextProps = {
  room: string; question: ChatMessage; history: ChatMessage[]; contexts: QuestionContext[];
  busy: boolean; running: boolean; connected: boolean; recent: ChatMessage[];
  onAction: (operation: () => Promise<AppState>) => void;
};
export function QuestionContextPanel(props: ContextProps) {
  const [open, setOpen] = useState(false);
  const saved = props.contexts.find(c => c.question.id === props.question.id);
  return <details className="message-context" data-question-id={props.question.id} onToggle={e => { if (e.currentTarget.open) setOpen(true); }}>
    <summary><Paperclip size={12}/> 원문 보기·연결{saved && (saved.references.length > 0 || saved.note || saved.attachments.length > 0) ? <small>연결됨</small> : null}</summary>
    {open && <QuestionContextEditor {...props}/>}
  </details>;
}
function QuestionContextEditor({ room, question, history, contexts, busy, running, connected, onAction, recent }: ContextProps) {
  const fieldId = useId();
  const [sourceKey, setSourceKey] = useState('');
  const [references, setReferences] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const all = [...new Map([...history, ...contexts.flatMap(c => [c.question, ...c.references, ...c.attachments.flatMap(f => f.source ? [f.source.message] : [])])].map(m => [m.id, m])).values()];
  const sources = all.flatMap(message => (message.attachments ?? []).map(attachment => ({ message, attachment, key: attachmentKey(message.id, attachment.id) })));
  const selectedSource = sources.find(s => s.key === sourceKey);
  const sourceSelection: AttachmentSelection | undefined = selectedSource ? { messageId: selectedSource.message.id, attachmentId: selectedSource.attachment.id } : undefined;
  const missing = unresolvedAttachments(recent, contexts, question ? [question] : []);
  const saved = contexts.find(c => c.question.id === question?.id);
  const savedReferences = JSON.stringify(saved?.references.map(m => m.id) ?? []);
  const savedNote = saved?.note ?? '';
  useEffect(() => { setReferences(JSON.parse(savedReferences)); setNote(savedNote); }, [question?.id, savedReferences, savedNote]);
  const dirty = JSON.stringify(references) !== savedReferences || note !== savedNote;
  const disabled = busy || running || !question;
  const referencePool = [...new Map([...history, ...(saved?.references ?? [])].map(m => [m.id, m])).values()].filter(m => m.id !== question?.id && (!search || `${m.sender} ${m.text}`.toLowerCase().includes(search.toLowerCase()))).reverse();
  const saveThen = (next?: () => Promise<AppState>) => {
    if (!question) return;
    onAction(async () => {
      const state = await window.replyNote.saveQuestionContext(room, question.id, references, note);
      return next ? next() : state;
    });
  };
  return <div className="context-body">
        <blockquote className="context-question">{question ? messageLabel(question) : ''}</blockquote>
        {!!missing.length && <div className="context-media-warning" role="status">최근 대화와 연결한 원문에 내용 미확인 첨부 {missing.length}건이 있어 생성을 보류합니다. 대화 속 사진·파일에서 가져오거나 직접 파일을 선택해주세요.</div>}
        <label htmlFor={`${fieldId}-search`}>답장 원문 찾기 · 앱이 수집한 대화 최대 500개</label>
        <input id={`${fieldId}-search`} className="context-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="이름이나 대화 내용으로 찾기"/>
        <div className="context-reference-list" aria-label="연결할 원문 목록">{referencePool.slice(0, 80).map(m => <label key={m.id}><input type="checkbox" checked={references.includes(m.id)} disabled={disabled || (!references.includes(m.id) && references.length >= 10)} onChange={e => setReferences(current => e.target.checked ? [...current, m.id] : current.filter(id => id !== m.id))}/><span><strong>{m.sender || '발신자 확인 필요'} <small>{m.time}</small></strong><span>{messageLabel(m)}</span></span></label>)}{!referencePool.length && <p>수집된 원문이 없으면 아래에 직접 붙여넣어주세요.</p>}</div>
        <span className="context-count">연결한 원문 {references.length} / 10개</span>
        <label htmlFor={`${fieldId}-note`}>수집되지 않은 원문·보충 설명</label>
        <textarea id={`${fieldId}-note`} className="context-note" value={note} disabled={disabled} onChange={e => setNote(e.target.value)} placeholder="카톡에서 확인한 원문이나 문제 설명을 붙여넣어주세요." maxLength={10000}/>
        {!!sources.length && <><label htmlFor={`${fieldId}-source`}>이 자료가 해당하는 카톡 첨부</label><select id={`${fieldId}-source`} className="context-source" value={sourceKey} disabled={disabled} onChange={e => setSourceKey(e.target.value)}><option value="">보충 자료 · 특정 카톡 첨부에 연결하지 않음</option>{sources.map(source => <option key={source.key} value={source.key}>{source.message.sender || '발신자 확인 필요'} · {source.message.time} · {attachmentLabel(source.attachment)}</option>)}</select><p className="context-notice">카톡 첨부를 지정해야 해당 사진·파일의 ‘내용 확인 필요’ 표시가 해제됩니다. 묶음 사진은 표시된 장수만큼 파일을 연결해주세요.</p></>}
        <div className={`context-drop ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => {
          e.preventDefault(); setDragging(false); if (disabled || !question) return;
          const files = Array.from(e.dataTransfer.files); if (!files.length) return;
          saveThen(() => window.replyNote.dropQuestionFiles(room, question.id, files, sourceSelection));
        }}><Paperclip size={22}/><strong>사진·파일을 여기에 끌어놓으세요</strong><button className="button secondary small" disabled={disabled || (saved?.attachments.length ?? 0) >= 4} onClick={() => saveThen(() => window.replyNote.pickQuestionFiles(room, question!.id, sourceSelection))}>사진·파일 선택</button><small>PNG·JPG·WebP / PDF / DOC·DOCX / HWP·HWPX / TXT·MD·CSV<br/>파일당 10MB, 질문당 4개 · PDF는 파일당 5쪽까지</small></div>
        {!!saved?.attachments.length && <div className="context-files">{saved.attachments.map(file => <div key={file.id}><FileText size={17}/><div><strong>{file.name}</strong><small>{file.imageCount ? `이미지 ${file.imageCount}장` : '본문 텍스트'} · {Math.ceil(file.size / 1024).toLocaleString()}KB</small>{!!sources.length && <select aria-label={`${file.name}의 카톡 첨부`} value={file.source && sources.some(s => s.key === attachmentKey(file.source!.message.id, file.source!.attachmentId) && sameMessage(s.message, file.source!.message)) ? attachmentKey(file.source.message.id, file.source.attachmentId) : ''} disabled={disabled} onChange={e => { const source = sources.find(s => s.key === e.target.value); onAction(() => window.replyNote.linkQuestionFile(room, question!.id, file.id, source ? { messageId: source.message.id, attachmentId: source.attachment.id } : undefined)); }}><option value="">특정 첨부에 연결되지 않음</option>{sources.map(source => <option key={source.key} value={source.key}>{source.message.sender || '발신자 확인 필요'} · {attachmentLabel(source.attachment)}</option>)}</select>}{sourceSelection && <button className="text-link" disabled={disabled} onClick={() => onAction(() => window.replyNote.linkQuestionFile(room, question!.id, file.id, sourceSelection))}>위에서 선택한 첨부에 연결</button>}{file.excerpt && <p>{file.excerpt}</p>}{file.warning && <p className="inline-warning">{file.warning}</p>}</div><button className="icon-button" disabled={disabled} aria-label={`${file.name} 연결 해제`} onClick={() => onAction(() => window.replyNote.removeQuestionFile(room, question!.id, file.id))}><Trash2 size={14}/></button></div>)}</div>}
        <p className="context-notice">연결한 원문·문서 내용·이미지는 초안 생성 시 OpenAI로 전달됩니다. 자료를 변경하면 해당 방의 진행 중 작업을 취소합니다. 생성 결과는 앱에 보관돼요.</p>
        <div className="button-row"><button className="button secondary small" disabled={disabled || !dirty} onClick={() => saveThen()}>원문·설명 저장</button><button className="button primary small" disabled={disabled || !connected || missing.length > 0} onClick={() => saveThen(() => window.replyNote.generateQuestionDraft(room, question!.id))}><Sparkles size={14}/>{running ? '초안 작성 중…' : '이 질문과 자료로 초안 만들기'}</button>{dirty && <small>저장하지 않은 원문·설명이 있어요.</small>}</div>
    </div>;
}
