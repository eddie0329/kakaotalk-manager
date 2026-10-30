import { RefreshCw } from 'lucide-react';
export function DraftRewriteEditor({ instruction, disabled, running, onChange, onRewrite, onCancel }: {
  instruction: string; disabled: boolean; running: boolean; onChange: (text: string) => void; onRewrite: () => void; onCancel: () => void;
}) {
  return <div className="draft-rewrite">
    <label htmlFor="draft-rewrite-instruction">초안을 어떻게 바꿀까요?</label>
    <textarea id="draft-rewrite-instruction" value={instruction} disabled={disabled} onChange={event => onChange(event.target.value)} maxLength={5000} placeholder={'예: 더 정중한 존댓말로 바꿔줘.\n약속을 확정하지 말고 가능한 시간을 물어봐줘.'} aria-describedby="draft-rewrite-help"/>
    <div className="draft-rewrite-actions"><p id="draft-rewrite-help" className="field-note">{running ? '다시 작성 중입니다. 취소하면 현재 초안을 그대로 유지해요. ' : ''}현재 초안·최근 대화·저장한 지침을 참고해요. 이 요청에만 적용하며 결과는 새 초안으로 보관해요. Enter는 지시 줄바꿈이에요.</p><button type="button" className="button secondary small" disabled={!running && (disabled || !instruction.trim())} onClick={running ? onCancel : onRewrite}><RefreshCw size={14}/>{running ? '재작성 취소' : '지시대로 다시 만들기'}</button></div>
  </div>;
}
