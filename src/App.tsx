import { DraftRewriteEditor } from './DraftRewriteEditor';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, ArrowUpRight as External, Check, CheckCheck, ChevronRight, CircleHelp, Clipboard, Clock3, FileText, MessageCircle, MoreHorizontal, Pause, Play, Plus, Paperclip, Radio, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Terminal, Trash2, X } from 'lucide-react';
import type { AppState, Draft, ReplyAction, Settings } from '../shared/types';
import { attentionLabel, connectionLabel } from '../shared/connection';
import { MessageAttachments } from './MessageAttachments';
import { messageLabel } from '../shared/media';
import { QuestionContextPanel } from './QuestionContextPanel';
import { handleDraftKeyDown } from './draft-keyboard';
import { PersonPromptsEditor } from './PersonPromptsEditor';
import { RoomParticipantsEditor } from './RoomParticipantsEditor';
import { version as appVersion } from '../package.json';
import { effortLabel, findModel } from '../shared/model-settings';

type Page = 'monitor' | 'prompt' | 'settings';
const phaseLabels = { paused: '일시정지', connecting: '연결 확인 중', watching: '새 메시지 감지 중', waiting: '메시지 기다리는 중', generating: '초안 작성 중', needs_materials: '사진·파일 확인 필요', needs_attention: '연결 확인 필요', error: '확인 필요' };
const time = (n: number) => new Date(n).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

export default function App() {
  const [state, setState] = useState<AppState>();
  const [page, setPage] = useState<Page>('monitor');
  const [settings, setSettings] = useState<Settings>();
  const [token, setToken] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [customModelMode, setCustomModelMode] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const roomInputRef = useRef<HTMLInputElement>(null);
  const savedRoomsRef = useRef<HTMLElement>(null);
  const draftPanelRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationAtBottom = useRef(true);
  const previousConversation = useRef('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const [selectedDraft, selectDraft] = useState<string>();
  const previousNewestDraft = useRef<string | null>(null);
  const [rewriteInputs, setRewriteInputs] = useState<Record<string, string>>({});
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const unsubscribe = window.replyNote.onState(s => { if (active) setState(s); });
    window.replyNote.getState().then(s => { if (active) { setState(s); setSettings(s.settings); } }).catch(e => setError(e.message));
    const ticker = setInterval(() => setTick(Date.now()), 1000);
    return () => { active = false; unsubscribe(); clearInterval(ticker); };
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3200); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    if (!state) return;
    const newest = state.drafts[0];
    if (previousNewestDraft.current !== null && newest?.test && newest.id !== previousNewestDraft.current) selectDraft(newest.id);
    previousNewestDraft.current = newest?.id ?? '';
  }, [!!state, state?.drafts[0]?.id]);
  useEffect(() => {
    if (!state?.draftFocus) return;
    selectDraft(state.draftFocus.id); setPage('monitor');
    requestAnimationFrame(() => draftPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }, [state?.draftFocus?.request]);
  useEffect(() => {
    const element = conversationRef.current;
    if (!element || !state) return;
    if (previousConversation.current !== state.settings.room || conversationAtBottom.current) {
      element.scrollTop = element.scrollHeight;
      conversationAtBottom.current = true;
    }
    previousConversation.current = state.settings.room;
  }, [state?.settings.room, state?.monitor.messages.at(-1)?.id, state?.monitor.messages.at(-1)?.text]);
  async function perform(fn: () => Promise<unknown>, success?: string) {
    setBusy(true); setError('');
    try { await fn(); if (success) setToast(success); } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '요청을 처리하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  const action = (name: ReplyAction) => perform(async () => { setState(await window.replyNote.action(name)); });
  async function save(event?: FormEvent) { event?.preventDefault(); if (!settings || !state) return; if (customModelMode && !settings.model.trim()) { setError('직접 사용할 모델 ID를 입력하거나 Codex 기본값을 선택해주세요.'); return; } await perform(async () => { const s = await window.replyNote.saveSettings({ ...settings, room: state.settings.room }); setState(s); setSettings(s.settings); }, '설정을 저장했습니다. 감지를 다시 시작해주세요.'); }
  async function addSavedRoom(event?: FormEvent) {
    event?.preventDefault();
    await perform(async () => { const next = await window.replyNote.addRoom(roomInput); setState(next); setRoomInput(''); selectDraft(undefined); requestAnimationFrame(() => savedRoomsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })); }, '채팅방을 추가했습니다. 목록에서 감지를 시작해주세요.');
  }
  async function chooseRoom(room: string) {
    await perform(async () => { setState(await window.replyNote.selectRoom(room)); selectDraft(undefined); });
  }
  function savedDraftText(id: string, text: string) {
    setDraftEdits(current => {
      if (current[id] !== text) return current;
      const remaining = { ...current }; delete remaining[id]; return remaining;
    });
  }
  function editDraft(id: string, text: string) {
    setDraftEdits(current => ({ ...current, [id]: text }));
    // Send to the main process immediately so Cmd+Q can flush even during the debounce window.
    void window.replyNote.updateDraft(id, text).then(() => savedDraftText(id, text)).catch(e => setError(e.message));
  }
  async function copyEditedDraft(id: string, text: string) {
    await window.replyNote.copyDraft(id, text); savedDraftText(id, text);
  }
  function startDraftTest(source: 'synthetic' | 'conversation' = 'synthetic') { setPage('monitor'); selectDraft(undefined); void action(source === 'conversation' ? 'draft-conversation' : 'test-draft'); requestAnimationFrame(() => draftPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })); }
  if (!state || !settings) return <div className="loading"><MessageCircle size={28}/><p>답장노트를 준비하고 있어요.</p>{error && <p>{error}</p>}</div>;
  const monitor = state.monitor;
  const defaultModel = state.modelCatalog.items.find(model => model.isDefault);
  const chosenModel = findModel(settings.model, state.modelCatalog.items);
  const effortModel = settings.model ? chosenModel : defaultModel;
  const availableEfforts = effortModel?.efforts ?? [];
  const showCustomModel = customModelMode || (!!settings.model && state.modelCatalog.items.length > 0 && !chosenModel);
  const activeModelDefinition = findModel(state.settings.model, state.modelCatalog.items) ?? (!state.settings.model ? defaultModel : undefined);
  const activeModel = activeModelDefinition?.id || state.settings.model || 'Codex 기본값';
  const activeEffort = state.settings.effort || activeModelDefinition?.defaultEffort || '';
  const draft = state.drafts.find(d => d.id === selectedDraft) ?? state.drafts.find(d => d.room === state.settings.room);
  const roomTarget = state.targets.find(t => t.room === state.settings.room);
  const questionerDrafts = state.drafts.filter(d => d.room === state.settings.room && d.targetSender).filter((d, i, all) => all.findIndex(other => other.targetSender === d.targetSender) === i);
  const activeCount = state.targets.filter(r => r.monitor.enabled).length;
  const dirty = (['prompt', 'codexPath', 'model', 'effort', 'delivery'] as const).some(key => settings[key] !== state.settings[key]);
  const countdown = monitor.dueAt ? Math.max(0, Math.ceil((monitor.dueAt - tick) / 1000)) : null;
  const today = state.drafts.filter(d => new Date(d.createdAt).toDateString() === new Date(tick).toDateString()).length;
  const connectionNeeded = monitor.readerStatus && monitor.readerStatus !== 'ready';
  const pageNames = { monitor: '대화 모니터', prompt: '공통 프롬프트', settings: '연결 설정' };
  function patch<K extends keyof Settings>(key: K, value: Settings[K]) { setSettings(s => s ? { ...s, [key]: value } : s); }
  const roomForm = <form onSubmit={addSavedRoom} className="room-form">
    <label htmlFor="room">저장할 채팅방 추가</label>
    <div className="input-row"><input ref={roomInputRef} id="room" list="open-rooms" value={roomInput} onChange={e => setRoomInput(e.target.value)} placeholder="카카오톡 창에 표시된 이름" maxLength={200}/><button className="icon-button bordered" type="button" title="열린 채팅방 새로고침" aria-label="열린 채팅방 새로고침" disabled={busy} onClick={() => action('refresh')}><RefreshCw size={16}/></button></div>
    <datalist id="open-rooms">{state.rooms.map(r => <option value={r} key={r}/>)}</datalist>
    <p className="field-note">이름은 카카오톡 채팅방 창 제목과 정확히 같아야 합니다. {state.platform === 'win32' ? '채팅방을 닫거나 최소화하지 말고 다른 창 뒤에 두세요.' : '연결된 뒤에는 카카오톡을 숨겨도 됩니다.'}</p>
    {state.rooms.length > 0 && <div className="open-rooms"><span>열려 있는 채팅방</span>{state.rooms.map(room => <button key={room} type="button" onClick={() => setRoomInput(room)}>{room}</button>)}</div>}
    <button className="button small secondary" disabled={busy || !roomInput.trim() || state.targets.some(target => target.room === roomInput.trim())}><Plus size={13}/> 채팅방 추가</button>
  </form>;
  const savedRoomsPanel = <section ref={savedRoomsRef} className="saved-rooms-section" aria-label="저장한 채팅방">
    <div className="section-heading"><h2>저장한 채팅방 <span>{state.targets.length}개</span><small>· {activeCount}개 감지 중</small></h2><button className="text-link" onClick={() => roomInputRef.current?.focus()}><Plus size={13}/> 채팅방 추가</button></div>
    {state.targets.length ? <div className="saved-rooms-grid">{state.targets.map(target => <div key={target.room} className={`saved-room-card ${state.settings.room === target.room ? 'selected' : ''}`}>
      <button className="saved-room-main" disabled={busy} onClick={() => void chooseRoom(target.room)} aria-label={`${target.room} 대화 선택`}><span className="mini-avatar">{target.room.slice(0, 1)}</span><span><strong>{target.room}</strong><small title={target.monitor.detail}><i className={`status-dot ${target.monitor.enabled && target.monitor.readerStatus === 'ready' ? 'live' : ''}`}/>{target.monitor.enabled ? target.monitor.phase === 'needs_attention' || target.monitor.phase === 'error' ? attentionLabel(target.monitor) : target.monitor.chatKind === 'self' ? '수신 확인 중' : target.monitor.phase === 'waiting' && target.monitor.dueAt ? `${Math.max(0, Math.ceil((target.monitor.dueAt - tick) / 1000))}초 후 초안 작성` : phaseLabels[target.monitor.phase] : connectionLabel(target.monitor)}</small></span></button>
      <div className="saved-room-actions"><button className="icon-button" disabled={busy || dirty} title={target.monitor.enabled ? '감지 정지' : '감지 시작'} aria-label={`${target.room} ${target.monitor.enabled ? '감지 정지' : '감지 시작'}`} onClick={() => perform(async () => { setState(await window.replyNote.toggleRoom(target.room, !target.monitor.enabled)); })}>{target.monitor.enabled ? <Pause size={14}/> : <Play size={14}/>}</button><button className="icon-button" disabled={busy} title="목록에서 제거" aria-label={`${target.room} 목록에서 제거`} onClick={() => setRemoveTarget(target.room)}><X size={13}/></button></div>
    </div>)}</div> : <div className="saved-rooms-empty">카카오톡에서 채팅방을 열고, 아래에서 이름을 추가해주세요. 여러 채팅방을 각각 저장할 수 있어요.</div>}
  </section>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="traffic-space"/>
      <div className="brand"><div className="brand-icon"><MessageCircle size={23} strokeWidth={2.1}/><span/></div><span>답장노트<span className="brand-dot">.</span></span></div>
      <div className="workspace-label">PERSONAL WORKSPACE</div>
      <nav aria-label="주 메뉴">
        {([{ id: 'monitor', icon: MessageCircle, label: '대화 모니터' }, { id: 'prompt', icon: FileText, label: '공통 프롬프트' }, { id: 'settings', icon: Settings2, label: '연결 설정' }] as const).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}><item.icon size={18}/><span>{item.label}</span>{page === item.id && <span className="nav-dot"/>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="local-card"><span className="local-icon"><ShieldCheck size={19}/></span><strong>내 PC에서 관리해요</strong><p>방마다 최근 20개를 보관해요.<br/>초안 생성 시 OpenAI로 전달돼요.</p><span className="local-tag"><span/> 로컬 저장</span></div><div className="profile"><div className="profile-avatar">나</div><div><strong>개인 워크스페이스</strong><span>Reply Note <b>v{appVersion}</b></span></div><MoreHorizontal size={17}/></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><span>워크스페이스</span><ChevronRight size={14}/><strong>{pageNames[page]}</strong><div className="topbar-right"><span className="platform-tag">{state.platform === 'darwin' ? 'macOS' : state.platform === 'win32' ? 'Windows' : state.platform}</span><span className="private-tag"><ShieldCheck size={14}/> 개인용</span></div></header>
      <main>
        {state.demo && <div className="demo-banner"><Sparkles size={16}/><strong>데모 모드</strong><span>실제 카카오톡·Codex 연결이나 메시지 전송 없이 화면과 처리 흐름을 확인합니다.</span></div>}
        {error && <div role="alert" className="error-banner"><CircleHelp size={18}/><span>{error}</span><button aria-label="오류 닫기" onClick={() => setError('')}><X size={16}/></button></div>}
        {state.update.status === 'available' && dismissedUpdate !== state.update.latestVersion && <div className="update-banner" role="status"><RefreshCw size={18}/><div><strong>새 버전 v{state.update.latestVersion}이 준비됐어요.</strong><p>현재 v{state.update.currentVersion} · 다운로드 후 앱을 종료하고 새 버전으로 교체해주세요.</p></div><button className="button primary small" disabled={busy} onClick={() => action('download-update')}>다운로드 <External size={12}/></button><button className="icon-button" aria-label="업데이트 안내 나중에 보기" onClick={() => setDismissedUpdate(state.update.latestVersion)}><X size={15}/></button></div>}
        {page === 'monitor' && <>
          <div className="page-heading"><div><div className="eyebrow"><span/> YOUR CONVERSATION, YOUR VOICE</div><h1>답장은 가볍게,<br className="mobile-break"/> 대화는 자연스럽게<span>.</span></h1><p>새 메시지를 확인하고, 내 말투에 맞는 답장 초안을 준비해요.</p></div><button className={`button ${activeCount ? 'secondary' : 'primary'}`} disabled={busy || dirty || !state.targets.length} onClick={() => action(activeCount ? 'stop' : 'start')}>{activeCount ? <Pause size={16}/> : <Play size={16}/>} {activeCount ? '전체 일시정지' : '전체 감지 시작'}</button></div>
          {dirty && <div className="notice"><span>변경한 설정을 저장하면 감지를 시작할 수 있어요.</span><button onClick={() => void save()}>설정 저장 <ChevronRight size={14}/></button></div>}
          <div className="stats-grid">
            <div className="stat-card"><div className={`stat-icon ${monitor.enabled ? 'green' : ''}`}><Radio size={21}/></div><div><span className="stat-label">선택한 대화 상태</span><strong className="status-value"><span className={`status-dot ${monitor.enabled && !connectionNeeded ? 'live' : ''}`}/>{monitor.phase === 'needs_attention' || monitor.phase === 'error' ? attentionLabel(monitor) : monitor.chatKind === 'self' && monitor.enabled ? '수신 확인 중' : phaseLabels[monitor.phase]}</strong></div></div>
            <div className="stat-card"><div className="stat-icon warm"><Clock3 size={21}/></div><div><span className="stat-label">메시지 모으기</span><strong>{monitor.chatKind === 'self' ? '버튼으로 실제 대화 초안 생성' : countdown !== null ? `${countdown}초 후 초안 작성` : '마지막 메시지 후 10초'}</strong></div></div>
            <div className="stat-card"><div className="stat-icon lilac"><Sparkles size={21}/></div><div><span className="stat-label">오늘 준비한 초안</span><strong>{today}<small>개</small></strong></div><span className="stat-corner">내 말투로, 자연스럽게</span></div>
          </div>
          {savedRoomsPanel}
          {state.notificationError && <p className="inline-warning" role="alert">{state.notificationError}</p>}
          {state.settings.room && <RoomParticipantsEditor key={state.settings.room} room={state.settings.room} group={monitor.chatKind === 'group'} value={roomTarget?.participants} messages={monitor.messages} busy={busy} onSave={participants => { void perform(async () => { setState(await window.replyNote.saveRoomParticipants(state.settings.room, participants)); }, '참여자 설정을 저장했습니다. 이 방의 감지를 다시 시작해주세요.'); }}/>}
          {state.settings.room && <PersonPromptsEditor key={`person-prompts:${state.settings.room}`} room={state.settings.room} group={monitor.chatKind === 'group'} participants={roomTarget?.participants} messages={monitor.messages} value={roomTarget?.personPrompts} busy={busy} onSave={async (name, prompt) => {
            let failed: unknown;
            await perform(async () => { try { setState(await window.replyNote.savePersonPrompt(state.settings.room, name, prompt)); } catch (error) { failed = error; throw error; } }, '개인 프롬프트를 저장했습니다. 이 방의 감지를 다시 시작해주세요.');
            if (failed) throw failed;
          }}/>}

          <div className="content-grid">
            <section className="panel conversation-panel">
              <div className="panel-heading"><h2><MessageCircle size={18}/> 연결된 대화</h2><span className="tiny-badge">{monitor.chatKind === 'self' ? '나와의 채팅' : monitor.chatKind === 'group' ? '단체방' : '1:1'}</span></div>
              {!state.settings.room ? <div className="room-empty"><div className="empty-symbol"><MessageCircle size={27}/><Plus size={13}/></div><h3>어떤 대화를 도와드릴까요?</h3><p>감지할 채팅방 이름을 입력하고<br/>카카오톡에서 해당 방을 열어주세요.</p></div> : <div className="contact-header"><div className="contact-avatar">{state.settings.room.slice(0, 1)}</div><div><strong>{state.settings.room}</strong><span><span className={`status-dot ${monitor.readerStatus === 'ready' ? 'live' : ''}`}/>{connectionLabel(monitor)}</span></div><span className="contact-count">최근 {monitor.messages.length}개</span></div>}
              {(monitor.messages.length > 0) && <div ref={conversationRef} className="conversation-scroll" aria-label="최근 대화" onScroll={event => { const element = event.currentTarget; conversationAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; }}>{monitor.messages.map((m, i) => <div key={`${m.id}-${i}`} className={`message ${m.direction}`}><span className="message-author">{m.direction === 'outgoing' ? '나' : m.direction === 'incoming' ? m.sender || '발신자 확인 필요' : '발신자 확인 필요'}{m.direction === 'outgoing' ? <ArrowUpRight size={12}/> : <ArrowDownLeft size={12}/>}</span>{m.text && <div className="bubble">{m.text}</div>}<MessageAttachments room={state.settings.room} message={m} contexts={state.questionContexts ?? []} drafts={state.drafts} busy={busy} canAcquire={state.platform === 'darwin'} onAction={operation => { void perform(async () => setState(await operation())); }}/>{m.direction === 'incoming' && m.sender && (!roomTarget?.participants || roomTarget.participants.questioners.includes(m.sender)) && <QuestionContextPanel room={state.settings.room} question={m} history={state.history ?? monitor.messages} contexts={state.questionContexts ?? []} recent={monitor.messages} busy={busy} running={state.draftTest.running} connected={monitor.readerStatus === 'ready'} onAction={operation => { void perform(async () => setState(await operation())); }}/> }<span className="message-time">{m.time}</span></div>)}</div>}
              <div className="connection-note"><span className={`status-dot ${monitor.readerStatus === 'ready' ? 'live' : ''}`}/><p>{monitor.detail}</p></div>
              {monitor.readerStatus === 'permission_required' && <button className="button secondary permission-button" onClick={() => action('permission')}>손쉬운 사용 설정 열기 <External size={14}/></button>}
              <div className="room-form-wrap">{roomForm}</div>
              <div className="panel-footer"><ShieldCheck size={13}/><span>감지 중인 저장 채팅방을 읽고, 상대에게 자동 전송하지 않아요.</span></div>
            </section>
            <div className="right-column">
              <section ref={draftPanelRef} className="panel draft-panel">
                <div className="panel-heading"><h2><Sparkles size={18}/> 답장 초안</h2><span className="subtle">{draft ? time(draft.createdAt) : '나만 볼 수 있어요'}</span></div>
                {(monitor.phase === 'generating' || state.draftTest.running) && <div className="generating-strip"><span className="spinner"/>{state.draftTest.running ? state.draftTest.source === 'conversation' ? '선택한 실제 대화로 Codex 초안을 작성하고 있어요…' : '가상 대화로 Codex 연결을 시험하고 있어요…' : 'Codex가 내 말투로 작성하고 있어요…'}</div>}
                {monitor.tasks?.some(task => task.phase === 'needs_materials') && <div className="context-media-warning" role="status">사진·파일 내용을 확인하기 전까지 새 초안 생성을 보류합니다. 아래에 초안이 보이면 이전에 생성된 내용입니다.</div>}
                {state.draftTest.error && <p className="inline-warning" role="alert">{state.draftTest.error}</p>}
                {monitor.phase === 'waiting' && <div className="generating-strip waiting"><Clock3 size={15}/> 연속 메시지를 모으고 있어요 · {countdown}초</div>}
                {!!monitor.tasks?.length && <div className="participant-tasks" aria-label="질문자별 처리 상태">{monitor.tasks.map(task => <div key={task.sender}><strong>{task.sender}</strong><span>{task.phase === 'waiting' ? `${Math.max(0, Math.ceil(((task.dueAt ?? tick) - tick) / 1000))}초 후 생성` : task.phase === 'generating' ? '초안 작성 중' : task.phase === 'needs_materials' ? '사진·파일 연결 필요' : task.detail || '생성 실패'}</span></div>)}</div>}
                {!!questionerDrafts.length && <div className="questioner-drafts" aria-label="질문자별 최신 초안">{questionerDrafts.map(d => <button key={d.id} className={draft?.id === d.id ? 'selected' : ''} onClick={() => selectDraft(d.id)}><strong>{d.targetSender}</strong><span>{d.teacherResponse ? '선생님 응답 있음' : '초안 준비됨'}</span><small>{d.targetMessages?.at(-1) ? messageLabel(d.targetMessages.at(-1)!) : ''}</small></button>)}</div>}
                {draft ? <><DraftContent draft={draft} text={draftEdits[draft.id] ?? draft.text} busy={busy || !!state.contactSending || (state.draftTest.running && state.draftTest.draftId === draft.id)} saveStatus={state.draftSaveStatus?.[draft.id]} onChange={text => editDraft(draft.id, text)} onFlush={() => { void window.replyNote.flushDrafts().catch(e => setError(e.message)); }} onCopy={() => perform(() => copyEditedDraft(draft.id, draftEdits[draft.id] ?? draft.text), '수정한 초안을 복사했습니다.')} onSend={() => perform(async () => { const text = draftEdits[draft.id] ?? draft.text; const result = await window.replyNote.sendDraft(draft.id, text); savedDraftText(draft.id, text); if (result.outcome !== 'sent') setError(result.detail); })} sendDisabled={state.platform !== 'darwin' || state.demo || state.settings.room !== draft.room || monitor.chatKind === 'group' || !!(draft.test && draft.testSource !== 'conversation') || !!state.contactSending || draft.contactSend?.outcome === 'sending' || draft.contactSend?.outcome === 'unknown' || (draft.contactSend?.outcome === 'sent' && draft.contactSend.text === (draftEdits[draft.id] ?? draft.text).replace(/\r\n?/g, '\n'))}/>{!(draft.test && draft.testSource !== 'conversation') && <DraftRewriteEditor instruction={rewriteInputs[draft.id] ?? ''} disabled={busy || dirty || state.draftTest.running || !!state.contactSending || state.settings.room !== draft.room || !roomTarget} running={state.draftTest.running && state.draftTest.source === 'rewrite' && state.draftTest.draftId === draft.id} onChange={text => setRewriteInputs(current => ({ ...current, [draft.id]: text }))} onCancel={() => { void action('cancel-draft'); }} onRewrite={() => perform(async () => { const text = draftEdits[draft.id] ?? draft.text; setState(await window.replyNote.rewriteDraft(draft.id, text, rewriteInputs[draft.id] ?? '')); savedDraftText(draft.id, text); })}/>}</> : <div className="draft-empty"><div className="paper-illustration"><div className="paper-fold"/><Sparkles size={22}/><i/><i/><i/><span className="paper-spark">✦</span></div><h3>다음 답장을 위한 작은 여유</h3><p>새 메시지가 오면 최근 대화를 참고해<br/>여기에 답장 초안을 준비해둘게요.</p><span className="empty-caption">답장을 보내는 건 언제나 나의 선택</span></div>}
                <div className="draft-test-box"><div><strong>선택한 실제 대화로 초안 만들기</strong><p>버튼을 누른 시점의 최근 대화 20개와 공통·개인 프롬프트를 Codex에 전달해요. 결과는 앱에만 표시해요.{monitor.chatKind === 'self' ? ' 나와의 채팅은 마지막 메시지를 상대가 보낸 것으로 가정해요.' : ''}</p></div><button className="button secondary small" disabled={busy || dirty || state.draftTest.running || state.demo || !state.settings.room || monitor.readerStatus !== 'ready' || (!settings.model && state.modelCatalog.loading)} onClick={() => startDraftTest('conversation')}><Sparkles size={14}/>{state.draftTest.running && state.draftTest.source === 'conversation' ? '초안 작성 중…' : '실제 대화 초안 만들기'}</button></div>
                <div className="draft-bottom"><div><ShieldCheck size={14}/>{draft?.testSource === 'conversation' ? '수동 초안은 앱에만 보관해요' : state.settings.delivery === 'kakao' ? '자동 초안을 나와의 채팅에도 전달해요' : '앱에서 확인하고 직접 복사해요'}</div><button onClick={() => setPage('settings')}>전달 설정 <ChevronRight size={13}/></button></div>
              </section>
              <section className="panel prompt-preview"><div className="panel-heading"><h2><FileText size={17}/> 나의 답장 스타일</h2><button onClick={() => setPage('prompt')}>수정하기 <External size={13}/></button></div><p>{state.settings.prompt.split('\n').slice(0, 2).join(' ') || '공통 프롬프트를 작성해주세요.'}</p><div className="prompt-tags"><span>공통 프롬프트</span><span>방별 최근 대화 20개</span><span className="active-model-tag"><Terminal size={10}/> {activeModel}</span>{activeEffort && <span>effort · {activeEffort}</span>}<span>텍스트·사진·파일 메시지</span></div></section>
            </div>
          </div>
          {state.drafts.length > 0 && <section className="history"><div className="section-heading"><h2>최근 초안 <span>{state.drafts.length}</span></h2><span>최대 20개 보관</span></div><div className="history-grid">{state.drafts.slice(0, 6).map(d => <button key={d.id} className={`history-card ${draft?.id === d.id ? 'selected' : ''}`} onClick={() => selectDraft(d.id)}><div><span>{d.room}{d.targetSender ? ` · ${d.targetSender}` : ''}</span><time>{time(d.createdAt)}</time></div><p>{d.text}</p>{d.teacherResponse && <span className="response-badge">선생님 응답 있음</span>}<span className="history-model">{d.model || '모델 정보 없음'}{d.effort ? ` · ${d.effort}` : ''}</span><span className="history-label">{d.delivery === 'sent' ? '나와의 채팅 전달됨' : d.delivery === 'failed' ? '앱에 보관됨 · 전달 실패' : '앱에 보관됨'}<ChevronRight size={13}/></span></button>)}</div></section>}
          {state.demo && <div className="demo-controls"><strong>처리 흐름 테스트</strong>{monitor.chatKind === 'group' ? <><button className="button small secondary" disabled={!monitor.enabled} onClick={() => action('demo-student-a')}>민수 메시지 추가</button><button className="button small secondary" disabled={!monitor.enabled} onClick={() => action('demo-student-b')}>지우 메시지 추가</button><button className="button small secondary" disabled={!monitor.enabled} onClick={() => action('demo-photo')}>사진 메시지 추가</button><button className="button small secondary" disabled={!monitor.enabled} onClick={() => action('demo-file')}>파일 메시지 추가</button><button className="button small secondary" disabled={!monitor.enabled} onClick={() => action('demo-teacher')}>선생님 메시지 · 전체 취소</button></> : <><button className="button small secondary" disabled={!monitor.enabled} onClick={() => action('demo-incoming')}>상대 메시지 추가</button><button className="button small secondary" disabled={!monitor.enabled} onClick={() => action('demo-outgoing')}>내 답장 추가 · 취소</button></>}</div>}
          <footer className="page-footer"><span><ShieldCheck size={13}/> 대화는 내 PC에, 답장은 내 손으로.</span><span>{monitor.lastCheckedAt ? `마지막 확인 ${time(monitor.lastCheckedAt)}` : '감지를 시작하면 연결을 확인합니다.'}</span></footer>
        </>}
        {page === 'prompt' && <>
          <div className="page-heading"><div><div className="eyebrow"><span/> WRITE LIKE YOU</div><h1>내 말투를 담아두세요<span>.</span></h1><p>모든 답장에 사용할 공통 프롬프트를 저장해요.</p></div><button className="button primary" onClick={() => void save()} disabled={busy || !dirty}><Check size={16}/> 저장하기</button></div>
          <section className="panel editor-panel"><div className="panel-heading"><h2><FileText size={18}/> 공통 프롬프트</h2><span className="tiny-badge">모든 대화에 적용</span></div><label className="sr-only" htmlFor="prompt">공통 프롬프트 내용</label><textarea id="prompt" className="prompt-editor" value={settings.prompt} onChange={e => patch('prompt', e.target.value)} maxLength={20_000} spellCheck={false}/><div className="editor-footer"><span>말투, 답장 길이, 피하고 싶은 표현을 적어주세요.</span><span>{settings.prompt.length.toLocaleString()} / 20,000</span></div></section>
          <div className="info-grid"><InfoCard icon={<MessageCircle size={20}/>} title="대화의 흐름도 함께" text="저장한 프롬프트에 최근 텍스트 대화 최대 20개를 함께 전달해요."/><InfoCard icon={<ShieldCheck size={20}/>} title="마지막 결정은 내가" text="만들어진 초안은 나에게만 보여요. 상대에게 자동으로 보내지 않아요."/></div>
          <div className="notice quiet"><ShieldCheck size={17}/><span>Codex는 PC에서 실행하지만, 초안 생성에 필요한 대화 내용은 OpenAI로 전송됩니다.</span></div>
        </>}
        {page === 'settings' && <>
          <div className="page-heading"><div><div className="eyebrow"><span/> MAKE IT YOURS</div><h1>연결은 한 번, 편안함은 계속<span>.</span></h1><p>대화 읽기와 초안 전달 방식을 설정해요.</p></div><button className="button primary" onClick={() => void save()} disabled={busy || !dirty}><Check size={16}/> 설정 저장</button></div>
          {savedRoomsPanel}
          {state.notificationError && <p className="inline-warning" role="alert">{state.notificationError}</p>}<div className="settings-grid"><div>
            <section className="panel settings-panel"><div className="panel-heading"><h2><MessageCircle size={18}/> 카카오톡 대화 연결</h2><span className="tiny-badge">{state.platform === 'darwin' ? 'Mac' : state.platform === 'win32' ? 'Windows · 시험 지원' : '미지원'}</span></div>{roomForm}
              <div className="setup-step"><span>01</span><div><strong>카카오톡에서 채팅방을 별도 창으로 열어주세요</strong><p>{state.platform === 'win32' ? '채팅방을 닫거나 최소화하지 말고 다른 창 뒤에 두세요. 화면 앞으로 가져오거나 입력을 조작하지 않아요.' : '채팅방 창을 닫거나 최소화하지 말고, 카카오톡 앱을 숨겨주세요.'}</p></div></div>
              <div className="setup-step"><span>02</span><div><strong>{state.platform === 'win32' ? '카카오톡과 같은 사용자 권한으로 실행해주세요' : '손쉬운 사용 접근을 허용해주세요'}</strong><p>{state.platform === 'win32' ? 'Windows UI Automation으로 읽어요. 카카오톡과 Reply Note 모두 일반 실행을 권장해요. WSL 대신 Windows용 Codex CLI가 필요해요.' : 'Reply Note가 선택한 채팅방의 텍스트를 읽는 데 필요해요.'}</p>{state.platform === 'darwin' && <button className="text-link" onClick={() => action('permission')}>시스템 설정 열기 <External size={13}/></button>}</div></div>
              <div className="setup-step"><span>03</span><div><strong>감지 시작을 눌러주세요</strong><p>처음 읽은 대화는 문맥으로만 저장하고, 새 메시지부터 초안을 만들어요.</p></div></div>
              {state.platform === 'win32' && <><p className="inline-warning">Windows 카카오톡 실기 검증 전인 시험 지원입니다. 접근성에서 참여자 수·본문·발신자를 확인하지 못하면 생성을 멈춥니다. 발신자 구분도 실제 대화로 확인해주세요.</p><button className="button secondary small" disabled={busy || !state.settings.room || state.demo} onClick={() => action('windows-diagnostic')}>Windows 구조 진단 저장</button><p className="field-note">진단에는 대화 본문·이름·채팅방 제목·화면 이미지가 포함되지 않아요. 파일만 저장하며 자동 전송하지 않아요.</p></>}
            </section>
            <section className="panel settings-panel"><div className="panel-heading"><h2><Terminal size={18}/> Codex 연결</h2>{state.codexAvailable !== null && <span className={`tiny-badge ${state.codexAvailable ? '' : 'warn'}`}>{state.codexAvailable ? '실행 가능' : '확인 필요'}</span>}</div><label htmlFor="codex-path">Codex 실행 파일 경로</label><input id="codex-path" value={settings.codexPath} onChange={e => patch('codexPath', e.target.value)} placeholder="비워두면 자동으로 찾습니다"/><p className="field-note">설치된 Codex CLI와 기존 로그인 정보를 사용합니다.</p><label htmlFor="model">답장 생성 모델</label>
              <div className="model-picker-row"><select id="model" value={showCustomModel ? '__custom__' : chosenModel?.id || settings.model} disabled={busy || state.demo} onChange={event => { const value = event.target.value; if (value === '__custom__') setCustomModelMode(true); else { setCustomModelMode(false); patch('model', value); patch('effort', ''); } }}>
                <option value="">Codex 기본값{defaultModel ? ` · ${defaultModel.name}` : ''}</option>
                {settings.model && !chosenModel && !showCustomModel && <option value={settings.model}>{settings.model} (저장된 모델)</option>}
                {state.modelCatalog.items.map(model => <option key={model.id} value={model.id}>{model.name}{model.isDefault ? ' · 기본' : ''}</option>)}
                <option value="__custom__">모델 ID 직접 입력…</option>
              </select><button className="icon-button bordered" aria-label="모델 목록 새로고침" title="Codex 모델 목록 새로고침" disabled={busy || dirty || state.modelCatalog.loading || state.demo} onClick={() => action('refresh-models')}><RefreshCw size={15}/></button></div>
              {showCustomModel && <div className="custom-model"><label htmlFor="custom-model">직접 사용할 모델 ID</label><input id="custom-model" value={settings.model} onChange={event => { patch('model', event.target.value); patch('effort', ''); }} placeholder="사용할 모델의 정확한 ID" maxLength={100}/></div>}
              <p className="field-note model-id-note">선택: <code>{chosenModel?.id || settings.model || defaultModel?.id || 'Codex 기본값 · 목록 확인 전'}</code></p>
              {state.modelCatalog.loading ? <p className="field-note"><span className="spinner tiny"/> Codex 모델 목록을 불러오고 있어요.</p> : state.modelCatalog.error ? <p className="inline-warning" role="alert">{state.modelCatalog.error}</p> : <p className="field-note">현재 Codex 로그인에서 표시하는 모델입니다. 같은 공통 프롬프트로 초안을 테스트해 비교해보세요.</p>}
<label htmlFor="effort">추론 강도 · effort</label>
              <div className="model-picker-row"><select id="effort" value={settings.effort || ''} disabled={busy || state.demo} onChange={event => patch('effort', event.target.value)}>
                <option value="">모델 기본값{effortModel?.defaultEffort ? ` · ${effortLabel(effortModel.defaultEffort)}` : ''}</option>
                {!!settings.effort && !availableEfforts.some(option => option.id === settings.effort) && <option value={settings.effort} disabled>{settings.effort} · 지원 확인 필요</option>}
                {availableEfforts.map(option => <option key={option.id} value={option.id}>{effortLabel(option.id)}</option>)}
              </select></div>
              <p className="field-note">{availableEfforts.length ? '선택한 모델이 지원하는 수준만 표시합니다. 높일수록 응답 시간과 사용량이 늘어날 수 있어요.' : '모델 목록에서 모델을 선택하면 지원하는 effort 수준을 확인할 수 있어요.'}</p>
              <div className="button-row"><button className="button secondary small" disabled={busy || dirty} onClick={() => action('check-codex')}>Codex 설치 확인</button><button className="button secondary small" disabled={busy || dirty || state.draftTest.running || state.demo || (!settings.model && state.modelCatalog.loading)} onClick={() => startDraftTest()}>가상 대화로 Codex 연결 시험</button></div><p className="field-note">처음 사용한다면 터미널에서 <code>codex login</code>을 완료해주세요.</p></section>
          </div><div>
            <section className="panel settings-panel"><div className="panel-heading"><h2><Send size={18}/> 초안 전달</h2></div><p className="field-note">자동·수동 초안이 완성되면 데스크톱 알림과 기본 알림음으로 알려드려요. 알림을 누르면 해당 초안이 열려요.</p><button className="button secondary small" disabled={busy} onClick={() => action('test-notification')}>데스크톱 알림 테스트</button><p className="field-note">알림이 보이지 않으면 시스템 설정에서 Reply Note 알림 허용과 집중 모드를 확인해주세요.</p>{state.notificationError && <p className="inline-warning" role="alert">{state.notificationError}</p>}<label className={`radio-card ${settings.delivery === 'app' ? 'chosen' : ''}`}><input type="radio" name="delivery" value="app" checked={settings.delivery === 'app'} onChange={() => patch('delivery', 'app')}/><div><strong>앱에서 확인</strong><p>앱 알림을 받고 초안을 직접 복사해요.</p></div></label><label className={`radio-card ${settings.delivery === 'kakao' ? 'chosen' : ''}`}><input type="radio" name="delivery" value="kakao" checked={settings.delivery === 'kakao'} disabled={!state.tokenSaved || state.demo} onChange={() => patch('delivery', 'kakao')}/><div><strong>카카오톡 나와의 채팅에도 전달</strong><p>카카오 API 인증을 연결하면 사용할 수 있어요.</p></div></label><div className="token-section"><div className="token-title"><strong>카카오 API 인증</strong><span className="tiny-badge">{state.tokenSaved ? '저장됨' : '미연결'}</span></div><p className="field-note">PC 카카오톡 로그인과 별개입니다. 카카오디벨로퍼스에서 메시지 전송 동의(talk_message)를 받은 사용자 액세스 토큰을 준비해주세요.</p><label htmlFor="kakao-token">사용자 액세스 토큰</label><input type="password" id="kakao-token" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder={state.tokenSaved ? '새 토큰을 입력하면 교체됩니다' : '액세스 토큰 입력'} disabled={state.demo}/><div className="button-row"><button className="button secondary small" disabled={!token.trim() || busy || !state.secureStorage || state.demo} onClick={() => perform(async () => { setState(await window.replyNote.saveToken(token)); setToken(''); }, '토큰을 안전하게 저장했습니다.')}>토큰 저장</button>{state.tokenSaved && <button className="text-link muted" disabled={busy} onClick={() => perform(async () => { const s = await window.replyNote.deleteToken(); setState(s); setSettings(s.settings); }, '카카오 API 연결을 해제했습니다.')}>연결 해제</button>}</div><p className="field-note"><ShieldCheck size={12}/> 토큰은 운영체제의 보호 기능으로 암호화해 저장해요.</p><p className="field-note">긴 초안은 카카오 메시지 길이에 맞게 일부만 표시되며, 전체 내용은 앱에 보관돼요. 토큰 만료 시 새 토큰을 저장해야 합니다.</p></div></section>
            <section className="panel settings-panel update-panel"><div className="panel-heading"><h2><RefreshCw size={18}/> 앱 업데이트</h2><span className="tiny-badge">v{state.update.currentVersion}</span></div><p className="update-status" role="status">{state.demo ? '데모에서는 업데이트를 조회하지 않습니다.' : state.update.message}</p>{state.update.checkedAt && <p className="field-note">마지막 확인 · {new Date(state.update.checkedAt).toLocaleString('ko-KR')}</p>}<div className="button-row"><button className="button secondary small" disabled={busy || state.demo || state.update.status === 'checking'} onClick={() => action('check-updates')}><RefreshCw size={13}/>{state.update.status === 'checking' ? '확인 중…' : '업데이트 확인'}</button>{state.update.status === 'available' && <button className="button primary small" disabled={busy} onClick={() => action('download-update')}>v{state.update.latestVersion} 다운로드 <External size={12}/></button>}</div>{state.update.latestVersion && state.update.notes && <details className="update-notes"><summary>v{state.update.latestVersion} 변경 내용</summary><pre>{state.update.notes}</pre></details>}<p className="field-note">실행할 때 새 버전을 확인해요. 다운로드는 기본 브라우저에서 열립니다. 자동 설치는 하지 않으며, 설정과 기록은 유지됩니다.</p><p className="field-note">{state.platform === 'darwin' ? 'Mac: 메뉴 막대에서 앱을 종료하고, 새 ZIP을 풀어 응용 프로그램의 기존 앱을 대치해주세요. 손쉬운 사용 권한을 다시 요청할 수 있어요.' : state.platform === 'win32' ? 'Windows: 트레이에서 앱을 종료한 다음 새 설치 파일을 실행해 기존과 같은 위치에 설치해주세요.' : '이 운영체제용 배포 파일이 있는 경우에만 다운로드를 제공합니다.'}</p></section>
            <section className="panel settings-panel retention-panel"><div className="panel-heading"><h2><ShieldCheck size={18}/> 대화와 기록</h2><span className="tiny-badge">로컬 저장</span></div><p>방별 최근 대화 20개를 표시하고, 수집된 텍스트를 최대 500개·20만 자까지 보관합니다. 전체 초안은 최대 20개입니다. 앱을 다시 켜면 감지는 일시정지 상태로 시작합니다.</p><p>직접 연결한 사진·문서와 원문은 초안에 참고합니다. 읽음 처리될 수 있으며, 상대에게 답장을 자동 전송하지 않습니다.</p><button className="text-link danger" onClick={() => setConfirmClear(true)}><Trash2 size={14}/> 대화 및 초안 기록 삭제</button></section>
          </div></div>
        </>}
      </main>
    </div>
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}</div>}
    {confirmClear && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="clear-title" className="modal"><div className="stat-icon warm"><Trash2 size={23}/></div><h2 id="clear-title">저장된 기록을 삭제할까요?</h2><p>최근 대화와 초안을 이 PC에서 삭제하고 감지를 중지합니다. 설정과 프롬프트는 유지됩니다.</p><div className="button-row"><button className="button secondary" onClick={() => setConfirmClear(false)}>취소</button><button className="button danger-button" onClick={() => perform(async () => { setState(await window.replyNote.action('clear')); selectDraft(undefined); setConfirmClear(false); }, '저장된 기록을 삭제했습니다.')}>기록 삭제</button></div></section></div>}
    {removeTarget && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="remove-title" className="modal"><div className="stat-icon warm"><MessageCircle size={23}/></div><h2 id="remove-title">채팅방을 목록에서 제거할까요?</h2><p>‘{removeTarget}’의 감지와 생성 중인 초안을 취소하고, 이 앱에 저장한 해당 방의 최근 대화를 삭제합니다.</p><div className="button-row"><button className="button secondary" onClick={() => setRemoveTarget(null)}>취소</button><button className="button danger-button" onClick={() => perform(async () => { setState(await window.replyNote.removeRoom(removeTarget)); setRemoveTarget(null); selectDraft(undefined); }, '채팅방을 목록에서 제거했습니다.')}>목록에서 제거</button></div></section></div>}
  </div>;
}
function DraftContent({ draft, text, busy, saveStatus, onChange, onFlush, onCopy, onSend, sendDisabled }: { draft: Draft; text: string; busy: boolean; saveStatus?: 'saving' | 'error'; onChange: (text: string) => void; onFlush: () => void; onCopy: () => void; onSend: () => void; sendDisabled: boolean }) {
  const dirty = text !== draft.text;
  const canSend = !busy && !sendDisabled && !!text.trim();
  return <div className="draft-content">
    <div className="draft-kicker"><span/><span>{draft.test ? draft.testSource === 'conversation' ? `${draft.room} · 실제 대화로 생성한 수동 초안` : '가상 대화로 생성한 테스트 초안' : `${draft.targetSender || draft.room}님에게 보낼 답장${draft.targetSender ? ` · ${draft.room}` : ''}`}</span><span className="draft-version">{draft.revision ? '재작성' : draft.editedAt ? '수정본' : draft.test ? '테스트' : '초안'}</span></div>
    {draft.revision && <p className="draft-revision-note"><RefreshCw size={13}/> 재작성 지시 · {draft.revision.instruction}</p>}
    {draft.teacherResponse && <div className="teacher-response" role="status"><CheckCheck size={15}/><span>선생님 응답 있음 · {draft.teacherResponse.sender} · {time(draft.teacherResponse.at)}<small>{draft.revision ? '원본 초안 생성 이후 선생님 메시지가 도착했습니다.' : '초안 생성 이후 선생님 메시지가 도착했습니다.'}</small></span></div>}
    {!!draft.targetMessages?.length && <div className="draft-target"><strong>{draft.targetSender}님의 대상 메시지</strong>{draft.targetMessages.map(m => <blockquote key={m.id}>{messageLabel(m)}<small>{m.time}</small></blockquote>)}</div>}
    {!!draft.contexts?.length && <details className="draft-sources"><summary>이 초안에 사용한 원문·자료</summary>{draft.contexts.map(context => <div key={context.question.id}><strong>{context.question.sender}님의 질문</strong>{context.references.map(m => <blockquote key={m.id}>{m.sender}: {messageLabel(m)}</blockquote>)}{context.note && <p>{context.note}</p>}{context.attachments.map(file => <p key={file.id}><Paperclip size={12}/>{file.name}{file.warning && <small>{file.warning}</small>}</p>)}</div>)}</details>}
    <div className="draft-model"><Terminal size={12}/><span>생성 요청 모델</span><code>{draft.model || '모델 정보 없음'}</code><code>effort · {draft.effort || '미기록'}</code></div>
    <label className="draft-editor-label" htmlFor="reply-draft-editor">답장 내용 · 직접 수정할 수 있어요</label>
    <textarea id="reply-draft-editor" className="draft-editor" disabled={busy} value={text} onChange={event => onChange(event.target.value)} maxLength={20_000} spellCheck={false} placeholder="보낼 답장을 입력해주세요." onBlur={onFlush} aria-describedby="draft-keyboard-help" onKeyDown={event => handleDraftKeyDown(event, { canSend, send: onSend, flush: onFlush })}/>
    <p id="draft-keyboard-help" className="field-note">Enter로 카톡방에 전송 · Shift+Enter로 줄바꿈</p>
    <div className="draft-editor-status"><span role="status">{saveStatus === 'error' ? '자동 저장 실패 · 입력 내용 유지 중' : dirty || saveStatus === 'saving' ? '자동 저장 중…' : draft.editedAt ? '자동 저장됨' : '수정하면 자동으로 저장돼요'}</span><span>{text.length.toLocaleString()} / 20,000</span></div>
    <div className="draft-actions"><span><CheckCheck size={14}/>{draft.editedAt || dirty ? '수정해도 카카오톡으로 다시 전송하지 않아요' : draft.test ? draft.testSource === 'conversation' ? '실제 대화로 생성 · 앱에만 보관했어요' : '가상 대화로 Codex 연결을 시험했어요' : draft.delivery === 'sent' ? '생성 당시 초안을 나와의 채팅에 전달했어요' : '검토하고 자유롭게 수정해 보내세요'}</span><div className="draft-editor-buttons"><button className="button secondary small" disabled={!canSend} onClick={onSend} title={sendDisabled ? 'Mac의 실제 1:1 채팅방에서 전송할 수 있어요. 이전 전송 결과가 불확실하면 다시 보내지 않아요.' : `‘${draft.room}’에 현재 내용을 바로 전송하고 다시 최소화해요`}><Send size={14}/> 카톡방으로 전송</button><button className="button primary small" disabled={busy || !text.trim()} onClick={onCopy}><Clipboard size={14}/> 초안 복사</button></div></div>
    {draft.contactSend && <p className="contact-send-status" role="status">{draft.contactSend.outcome === 'sending' ? '카톡 전송 결과 확인 중…' : draft.contactSend.detail || (draft.contactSend.outcome === 'sent' ? '카톡방 전송 확인됨' : '카톡방에서 전송 결과를 확인해주세요.')}</p>}
    {draft.delivery === 'failed' && <p className="inline-warning" role="alert">{draft.deliveryError}</p>}
  </div>;
}
function InfoCard({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="info-card"><div className="stat-icon green">{icon}</div><div><h3>{title}</h3><p>{text}</p></div></div>; }
