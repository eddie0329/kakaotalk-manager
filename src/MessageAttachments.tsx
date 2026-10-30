import { useState } from 'react';
import { FileText, Paperclip, Trash2 } from 'lucide-react';
import { attachmentLabel, attachmentReady, sameMessage } from '../shared/media';
import type { AppState, ChatMessage, Draft, QuestionContext } from '../shared/types';
export function MessageAttachments({ room, message, contexts, drafts = [], busy, canAcquire, onAction }: {
  room: string; message: ChatMessage; contexts: QuestionContext[]; drafts?: Draft[]; busy: boolean; canAcquire: boolean;
  onAction: (operation: () => Promise<AppState>) => void;
}) {
  const [expanded, setExpanded] = useState<string>();
  const [active, setActive] = useState<{ id: string; kind: 'acquire' | 'files' }>();
  const [failure, setFailure] = useState<{ id: string; detail: string }>();
  const run = (id: string, kind: 'acquire' | 'files', operation: () => Promise<AppState>) => {
    onAction(async () => {
      setFailure(undefined); setActive({ id, kind });
      try { return await operation(); }
      catch (error) { setFailure({ id, detail: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '자료를 가져오지 못했습니다.' }); throw error; }
      finally { setActive(undefined); }
    });
  };
  if (!message.attachments?.length) return null;
  return <div className="message-attachments">{message.attachments.map(attachment => {
    const ready = attachmentReady(message, attachment, contexts);
    const selection = { messageId: message.id, attachmentId: attachment.id };
    const files = contexts.flatMap(context => context.attachments.filter(file => file.source?.attachmentId === attachment.id && sameMessage(message, file.source?.message)).map(file => ({ file, owner: context.question.id })));
    const used = ready && drafts.some(d => d.contexts?.some(c => c.attachments.some(f => f.source?.message.id === message.id && f.source.attachmentId === attachment.id)));
    const working = active?.id === attachment.id;
    return <div className="message-attachment-wrap" key={attachment.id} title="사진·파일을 이 메시지에 끌어놓아 연결할 수도 있어요." onDragOver={e => e.preventDefault()} onDrop={e => {
      e.preventDefault(); if (busy) return;
      const dropped = Array.from(e.dataTransfer.files); if (!dropped.length) return;
      run(attachment.id, 'files', () => window.replyNote.dropQuestionFiles(room, message.id, dropped, selection));
    }}>
      <div className={`message-attachment ${ready ? 'ready' : 'missing'}`}><Paperclip size={15}/><div><strong>{attachmentLabel(attachment)}</strong><span role="status">{working ? active.kind === 'acquire' ? '원본 가져오는 중…' : '파일 확인 중…' : ready ? used ? '초안에 사용됨' : '자료 읽기 완료' : '내용 확인 필요'}</span></div>
        <div className="message-attachment-actions">
          {!ready && canAcquire && attachment.kind !== 'unknown' && (attachment.count ?? 1) === 1 && <button className="text-link" title="카톡 창을 잠깐 활성화해 선택한 원본을 저장하고 연결합니다." disabled={busy} onClick={() => run(attachment.id, 'acquire', () => window.replyNote.acquireChatAttachment(room, selection))}>{failure?.id === attachment.id ? '다시 가져오기' : '카톡에서 가져오기 · 실험'}</button>}
          {!ready && <button className="text-link" disabled={busy} onClick={() => run(attachment.id, 'files', () => window.replyNote.pickQuestionFiles(room, message.id, selection))}>직접 파일 선택</button>}
          {!!files.length && <button className="text-link" aria-expanded={expanded === attachment.id} onClick={() => setExpanded(expanded === attachment.id ? undefined : attachment.id)}>연결 확인</button>}
        </div>
      </div>
      {failure?.id === attachment.id && <p className="inline-warning attachment-error" role="alert">{failure.detail}</p>}
      {expanded === attachment.id && <div className="message-linked-files context-files">{files.map(({ file, owner }) => <div key={file.id}><FileText size={15}/><div><strong>{file.name}</strong><small>{file.imageCount ? `이미지 ${file.imageCount}장` : '본문 텍스트'} · {Math.ceil(file.size / 1024).toLocaleString()}KB</small>{file.excerpt && <p>{file.excerpt}</p>}{file.warning && <p className="inline-warning">{file.warning}</p>}</div><button className="icon-button" disabled={busy} aria-label={`${file.name} 연결 해제`} onClick={() => onAction(() => window.replyNote.removeQuestionFile(room, owner, file.id))}><Trash2 size={14}/></button></div>)}{ready && <button className="text-link" disabled={busy} onClick={() => run(attachment.id, 'files', () => window.replyNote.pickQuestionFiles(room, message.id, selection))}>파일 추가</button>}</div>}
    </div>;
  })}</div>;
}
