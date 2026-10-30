import { rewriteDraft, validateRewrite } from './core/rewrite-draft';
import { validatePersonPrompt } from '../shared/person-prompts';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, shell, Tray, systemPreferences } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ContactSender } from './contact-send';
import { DraftAutosave } from './draft-autosave';
import { acquireAttachment } from './attachment-acquisition';
import { assertMediaReady, sameMessage } from '../shared/media';
import type { AttachmentSource } from '../shared/types';
import { QuestionContexts, publicContext } from './question-context';
import { createContextDraft } from './core/context-draft';
import { Store, validateSettings, validateParticipants } from './store';
import { initialMonitorState } from './core/monitor';
import { RoomCollection } from './core/rooms';
import { createConversationDraft, createTestDraft } from './core/draft-test';
import { DemoReader, MacReader, UnsupportedReader, type Reader } from './reader';
import { WindowsReader } from './windows-reader';
import { checkCodex, generateDraft } from './codex';
import { listCodexModels } from './models';
import { effectiveModelSettings, findModel } from '../shared/model-settings';
import { DraftNotifications } from './notifications';
import { UpdateChecker, trustedDownload } from './updates';
import { sendToMyKakao } from './delivery';
import type { AppState, ChatMessage, Draft, ReplyAction, Settings, Snapshot } from '../shared/types';

app.setName('Reply Note');
if (process.platform === 'win32') app.setAppUserModelId('com.eddie.replynote');
const demo = process.argv.includes('--demo');
const demoDirectory = process.env.REPLY_NOTE_DEMO_DIRECTORY || path.join(os.tmpdir(), 'reply-note-demo');
if (demo) { mkdirSync(demoDirectory, { recursive: true }); app.setPath('userData', demoDirectory); }
const locked = app.requestSingleInstanceLock({ demo });
if (!locked) app.quit();
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let store: Store;
let questionContexts: QuestionContexts;
let draftAutosave: DraftAutosave;
let contactSender: ContactSender;
let reader: Reader;
let collection: RoomCollection;
let rooms: string[] = [];
let codexAvailable: boolean | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let pollBusy = false;
let savedMessages = '';
let testController: AbortController | null = null;
const draftTest: AppState['draftTest'] = { running: false, error: null };
const modelCatalog: AppState['modelCatalog'] = { items: [], loading: false, error: null };
let modelLoadVersion = 0;
let modelLoadController: AbortController | null = null;
let draftFocus: AppState['draftFocus'];
let focusRequest = 0;
const updates = new UpdateChecker({ version: app.getVersion(), platform: process.platform, arch: process.arch, changed });
const notifications = new DraftNotifications({
  supported: () => Notification.isSupported(),
  create: options => new Notification(options),
  changed,
  open: id => {
    const draft = store.value.drafts.find(item => item.id === id);
    if (draft) {
      if (collection.get(draft.room)) {
        if (store.value.settings.room !== draft.room) cancelTest();
        store.value.settings.room = draft.room; store.save();
      }
      draftFocus = { id: draft.id, request: ++focusRequest };
    }
    changed(); show();
  }
});

function state(): AppState {
  return {
    history: store.value.archiveByRoom[store.value.settings.room] ?? [], questionContexts: questionContexts?.views(store.value.settings.room) ?? [],
    contactSending: contactSender?.busyDraftId, draftSaveStatus: draftAutosave?.status, settings: store.value.settings, update: updates.state,
    monitor: collection.get(store.value.settings.room)?.state ?? initialMonitorState(),
    targets: collection.views(), draftTest, modelCatalog, notificationError: notifications.error, draftFocus,
    drafts: store.value.drafts, rooms, tokenSaved: store.hasToken(),
    secureStorage: safeStorage.isEncryptionAvailable(), platform: process.platform, demo, codexAvailable
  };
}
function changed() {
  if (!store || !collection) return;
  const histories = collection.histories();
  const serialized = JSON.stringify(histories);
  if (serialized !== savedMessages) {
    store.value.messagesByRoom = histories;
    store.value.messages = histories[store.value.settings.room] ?? [];
    store.value.roomNames = [...collection.monitors.keys()];
    store.save(); savedMessages = serialized;
  }
  if (window && !window.isDestroyed()) window.webContents.send('reply:state', state());
  const enabled = collection.views().filter(r => r.monitor.enabled).length;
  tray?.setToolTip(`Reply Note · ${enabled ? `${enabled}개 대화 감지 중` : '일시정지'}`);
}
function show() { if (!window || window.isDestroyed()) createWindow(); if (window!.isMinimized()) window!.restore(); window!.show(); window!.focus(); }
async function downloadUpdate() {
  const url = updates.state.downloadUrl;
  if (updates.state.status !== 'available' || !trustedDownload(url)) throw new Error('먼저 사용 가능한 업데이트를 확인해주세요.');
  try { await shell.openExternal(url); }
  catch { throw new Error('다운로드를 열지 못했습니다. 기본 브라우저를 확인하고 다시 시도해주세요.'); }
}
async function checkUpdatesFromMenu() {
  show();
  if (demo) {
    await dialog.showMessageBox(window!, { type: 'info', message: '데모에서는 업데이트를 조회하지 않습니다.' }); return;
  }
  await updates.check();
  if (quitting || !window || window.isDestroyed()) return;
  const available = updates.state.status === 'available';
  const result = await dialog.showMessageBox(window, {
    type: updates.state.status === 'error' ? 'warning' : 'info', title: '답장노트 업데이트',
    message: updates.state.message,
    detail: `현재 버전 v${app.getVersion()}${available ? '\n\n다운로드한 파일로 직접 설치해주세요. 설정과 기록은 유지됩니다.\n\n' + updates.state.notes : ''}`,
    buttons: available ? ['다운로드', '나중에'] : ['확인'], defaultId: 0, cancelId: available ? 1 : 0,
  });
  if (available && result.response === 0) {
    try { await downloadUpdate(); }
    catch { await dialog.showMessageBox(window!, { type: 'warning', message: '다운로드를 열지 못했습니다. 기본 브라우저를 확인해주세요.' }); }
  }
}
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '답장노트', submenu: [
      { label: '답장노트 열기', click: show },
      { label: '업데이트 확인…', click: () => { void checkUpdatesFromMenu(); } },
      { type: 'separator' },
      ...(process.platform === 'darwin' ? [{ role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }] : []),
      { role: 'quit' },
    ] }, { role: 'editMenu' }, { role: 'windowMenu' },
  ]));
}
function createWindow() {
  window = new BrowserWindow({
    width: 1280, height: 900, minWidth: 980, minHeight: 700, title: '답장노트 · Reply Note',
    backgroundColor: '#f7f8f5', ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 22, y: 22 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window?.hide(); } });
  const dev = !app.isPackaged ? process.env.REPLY_NOTE_DEV_URL : undefined;
  if (dev === 'http://127.0.0.1:5173') void window.loadURL(dev);
  else void window.loadFile(path.join(__dirname, '../../dist/index.html'));
}
function createTray() {
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
    const border = (y < 11 && (x === 2 || x === 13 || y === 2 || y === 10)) || (y >= 11 && x === 4);
    if (border) { const i = (y * 16 + x) * 4; pixels[i] = 50; pixels[i + 1] = 95; pixels[i + 2] = 28; pixels[i + 3] = 255; }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16, scaleFactor: 1 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '답장노트 열기', click: show },
    { label: '전체 감지 일시정지', click: () => collection.stopAll() },
    { label: '업데이트 확인…', click: () => { void checkUpdatesFromMenu(); } },
    { type: 'separator' }, { label: '종료', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', show);
}
async function snapshot(room: string): Promise<Snapshot> {
  try { return await reader.read(room); }
  catch (e) { return { status: 'error', room, messages: [], capturedAt: Date.now(), detail: e instanceof Error ? e.message : '카카오톡 연결을 확인해주세요.' }; }
}
async function poll() {
  if (pollBusy) return;
  const active = [...collection.monitors].filter(([, monitor]) => monitor.state.enabled);
  if (!active.length) return;
  pollBusy = true;
  try {
    for (const [room, monitor] of active) {
      if (!monitor.state.enabled || collection.get(room) !== monitor) continue;
      const result = await snapshot(room);
      if (collection.get(room) === monitor) monitor.ingest(result);
    }
  } finally { pollBusy = false; }
}
async function refreshConnection(room = store.value.settings.room) {
  const monitor = collection.get(room);
  try {
    const result = await reader.list(); rooms = [...new Set(result.rooms)].filter(name => name !== 'Window');
    if (!monitor) { changed(); return; }
    const check = result.snapshot.status === 'ready' ? await snapshot(room) : { ...result.snapshot, room };
    if (collection.get(room) === monitor) monitor.inspect(check);
  } catch (e) {
    if (monitor && collection.get(room) === monitor) monitor.inspect({ status: 'error', room, messages: [], capturedAt: Date.now(), detail: e instanceof Error ? e.message : '연결 확인을 완료하지 못했습니다.' });
  }
  changed();
}
function cancelTest() { testController?.abort(); testController = null; draftTest.running = false; draftTest.error = null; draftTest.source = undefined; draftTest.draftId = undefined; }
function rememberDraft(draft: Draft) { store.value.drafts.unshift(draft); store.value.drafts = store.value.drafts.slice(0, 20); store.save(); changed(); }
async function generate(messages: ChatMessage[], settings: Settings, signal: AbortSignal) {
  const materialMessages = settings.materialMessages ?? messages;
  const targets = settings.replyTarget?.messages ?? materialMessages.slice(-1);
  const contexts = questionContexts.prepare(settings.room, targets, materialMessages);
  assertMediaReady(materialMessages, contexts, targets);
  settings = { ...settings, contexts };
  const sources = contexts.map(publicContext);
  if (!demo) {
    const effective = effectiveModelSettings(settings, modelCatalog.items);
    if (!effective.model) throw new Error('답장에 사용할 기본 모델을 확인하지 못했습니다. 연결 설정에서 모델 목록을 불러오거나 모델 ID를 직접 입력하고 저장해주세요.');
    return { text: await generateDraft(messages, effective, signal, path.join(store.directory, 'codex-work')), model: effective.model || undefined, effort: effective.effort || undefined, contexts: sources };
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, 1200);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('취소')); }, { once: true });
  });
  if (settings.rewrite) return { contexts: sources, text: `${settings.rewrite.previousText} (재작성 데모: ${settings.rewrite.instruction})`, model: 'demo' };
  if (settings.replyTarget) return { contexts: sources, text: `${settings.replyTarget.sender}님, 질문한 부분부터 차근차근 살펴볼게요. 먼저 문제에서 주어진 조건을 정리해보세요. ${contexts.length ? ` 연결된 자료 ${contexts.reduce((n, c) => n + c.attachments.length, 0)}개와 원문을 참고하는 데모입니다.` : ''} (데모 초안)`, model: 'demo' };
  return { contexts: sources, text: '좋아! 토요일 12시에 역 앞에서 보자 😊 맛있는 거 먹으러 가자!', model: 'demo' };
}
async function refreshModels() {
  if (demo) return;
  const version = ++modelLoadVersion;
  modelLoadController?.abort();
  const controller = new AbortController(); modelLoadController = controller;
  const executable = store.value.settings.codexPath;
  modelCatalog.loading = true; modelCatalog.error = null; changed();
  try {
    const items = await listCodexModels(executable, controller.signal);
    if (version === modelLoadVersion && executable === store.value.settings.codexPath) { modelCatalog.items = items; codexAvailable = true; }
  } catch (error) {
    if (version === modelLoadVersion) modelCatalog.error = error instanceof Error ? error.message : '모델 목록을 가져오지 못했습니다.';
  } finally { if (version === modelLoadVersion) { modelCatalog.loading = false; changed(); } }
}
async function runDraftTest(source: 'synthetic' | 'conversation' = 'synthetic') {
  if (draftTest.running) return;
  const controller = new AbortController(); testController = controller;
  draftTest.running = true; draftTest.error = null; draftTest.source = source; changed();
  try {
    const settings = { ...store.value.settings, participants: collection.participants.get(store.value.settings.room), personPrompts: collection.personPrompts.get(store.value.settings.room) };
    const draft = source === 'conversation'
      ? await createConversationDraft(settings, async () => {
        const result = await snapshot(settings.room);
        if (!controller.signal.aborted && collection.get(settings.room)) collection.get(settings.room)!.inspect(result);
        return result;
      }, generate, controller.signal)
      : await createTestDraft(settings, generate, controller.signal);
    if (testController === controller && !controller.signal.aborted) { rememberDraft(draft); notifications.draft(draft, controller.signal); }
  } catch (e) {
    if (testController === controller && !controller.signal.aborted) draftTest.error = e instanceof Error ? e.message : '초안 생성 테스트에 실패했습니다.';
  } finally {
    if (testController === controller) { testController = null; draftTest.running = false; changed(); }
  }
}
async function publish(draft: Draft, signal: AbortSignal) {
  if (signal.aborted) return;
  rememberDraft(draft);
  notifications.draft(draft, signal);
  if (store.value.settings.delivery === 'kakao' && !demo) {
    try {
      if (!store.hasToken()) throw new Error('카카오 인증 정보를 다시 저장해주세요.');
      const token = safeStorage.decryptString(readFileSync(store.tokenFile()));
      await sendToMyKakao(draft, token, signal); draft.delivery = 'sent';
    } catch (e) { draft.delivery = 'failed'; draft.deliveryError = e instanceof Error ? e.message : '카카오톡 전달에 실패했습니다.'; }
    store.save(); changed();
  }

}
function roomName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\r\n\0]/.test(value)) throw new Error('채팅방 이름을 1~200자로 입력해주세요.');
  return value.trim();
}
function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('허용되지 않은 요청입니다.');
}
function questionFor(room: string, id: unknown): ChatMessage {
  if (!collection.get(room) || typeof id !== 'string') throw new Error('저장된 채팅방의 질문을 선택해주세요.');
  const message = store.value.archiveByRoom[room]?.find(m => m.id === id) ?? questionContexts.views(room).find(c => c.question.id === id)?.question;
  if (!message || message.direction !== 'incoming' || !message.sender) throw new Error('발신자가 확인된 상대 메시지를 선택해주세요.');
  const participants = collection.participants.get(room);
  if (participants && !participants.questioners.includes(message.sender)) throw new Error('등록된 질문자의 메시지를 선택해주세요.');
  return message;
}
function attachmentSourceFor(room: string, value: unknown): AttachmentSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new Error('연결할 카톡 첨부를 선택해주세요.');
  const selection = value as Record<string, unknown>;
  if (typeof selection.messageId !== 'string' || typeof selection.attachmentId !== 'string') throw new Error('연결할 카톡 첨부를 선택해주세요.');
  const contexts = questionContexts.views(room);
  const message = store.value.archiveByRoom[room]?.find(m => m.id === selection.messageId)
    ?? contexts.flatMap(c => [c.question, ...c.references, ...c.attachments.flatMap(a => a.source ? [a.source.message] : [])]).find(m => m.id === selection.messageId);
  if (!message?.attachments?.some(a => a.id === selection.attachmentId)) throw new Error('해당 카톡 첨부를 확인하지 못했습니다. 대화를 새로 확인해주세요.');
  return { message: structuredClone(message), attachmentId: selection.attachmentId };
}
// A message's own attachment can be resolved regardless of who sent it (including self chat).
// Unbound question materials still require a registered questioner.
function materialQuestionFor(room: string, id: unknown, selection: unknown): ChatMessage {
  if (!collection.get(room)) throw new Error('저장된 채팅방을 선택해주세요.');
  const source = attachmentSourceFor(room, selection);
  if (source && source.message.id === id) return source.message;
  return questionFor(room, id);
}
function materialRemovalQuestionFor(room: string, id: unknown, fileId: unknown): ChatMessage {
  if (!collection.get(room) || typeof id !== 'string' || typeof fileId !== 'string') throw new Error('연결된 자료를 선택해주세요.');
  const context = questionContexts.views(room).find(c => c.question.id === id);
  const file = context?.attachments.find(f => f.id === fileId);
  if (context && file?.source?.message.id === id && sameMessage(context.question, file.source.message)) return context.question;
  return questionFor(room, id);
}
function invalidateMedia(room: string) {
  collection.get(room)?.invalidate();
  if (store.value.settings.room === room) cancelTest();
}
function invalidateQuestion(room: string, question: ChatMessage) {
  collection.get(room)?.invalidate(question.sender);
  if (store.value.settings.room === room) cancelTest();
}
async function runQuestionDraft(room: string, question: ChatMessage) {
  if (draftTest.running) throw new Error('진행 중인 초안이 완료된 뒤 다시 시도해주세요.');
  invalidateQuestion(room, question);
  const controller = new AbortController(); testController = controller;
  draftTest.running = true; draftTest.source = 'conversation'; draftTest.error = null; changed();
  try {
    const draft = await createContextDraft(question, { ...store.value.settings, room, participants: collection.participants.get(room), personPrompts: collection.personPrompts.get(room) }, () => snapshot(room), generate, controller.signal);
    if (testController === controller && !controller.signal.aborted && collection.get(room)) { rememberDraft(draft); notifications.draft(draft, controller.signal); }
  } catch (error) { if (testController === controller && !controller.signal.aborted) draftTest.error = error instanceof Error ? error.message : '초안을 만들지 못했습니다.'; }
  finally { if (testController === controller) { testController = null; draftTest.running = false; changed(); } }
}
async function runRewrite(source: Draft, input: { previousText: string; instruction: string }) {
  collection.get(source.room)?.invalidate(source.targetSender);
  const controller = new AbortController(); testController = controller;
  draftTest.running = true; draftTest.source = 'rewrite'; draftTest.draftId = source.id; draftTest.error = null; changed();
  try {
    const settings = { ...store.value.settings, room: source.room, participants: collection.participants.get(source.room), personPrompts: collection.personPrompts.get(source.room) };
    const result = await rewriteDraft(source, settings, input, () => snapshot(source.room), generate, controller.signal);
    if (testController === controller && !controller.signal.aborted && collection.get(source.room)) { rememberDraft(result); notifications.draft(result, controller.signal); }
  } catch (error) {
    if (testController === controller && !controller.signal.aborted) draftTest.error = error instanceof Error ? error.message : '초안을 다시 작성하지 못했습니다.';
  } finally {
    if (testController === controller) { testController = null; draftTest.running = false; draftTest.draftId = undefined; changed(); }
  }
}
function installIPC() {
  const handle = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => { assertSender(event); return fn(...args); });
  handle('reply:get', () => state());
  let acquiring = false;
  handle('reply:attachment-acquire', async (value: unknown, selection: unknown) => {
    if (acquiring) throw new Error('다른 원본을 가져오는 중입니다. 잠시 기다려주세요.');
    const room = roomName(value), monitor = collection.get(room), source = attachmentSourceFor(room, selection);
    if (!monitor || !source) throw new Error('저장된 방의 첨부를 선택해주세요.');
    const contextService = questionContexts;
    acquiring = true; invalidateMedia(room);
    try {
      await acquireAttachment({ reader, contexts: contextService, root: store.directory, room, source,
        valid: () => collection.get(room) === monitor && questionContexts === contextService && sameMessage(source.message, store.value.archiveByRoom[room]?.find(m => m.id === source.message.id)) });
      changed(); return state();
    } finally { acquiring = false; }
  });
  handle('reply:question-context', (value: unknown, id: unknown, ids: unknown, note: unknown) => {
    const room = roomName(value), question = questionFor(room, id);
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string') || typeof note !== 'string') throw new Error('연결할 원문을 확인해주세요.');
    const references = [...new Set(ids)].map(id => store.value.archiveByRoom[room]?.find(m => m.id === id) ?? questionContexts.views(room).flatMap(c => c.references).find(m => m.id === id));
    if (references.some(m => !m)) throw new Error('원문이 보관 범위를 벗어났습니다. 직접 입력으로 연결해주세요.');
    invalidateQuestion(room, question); questionContexts.save(room, question, references as ChatMessage[], note); changed(); return state();
  });
  handle('reply:question-files', async (value: unknown, id: unknown, selection: unknown) => {
    const room = roomName(value), question = materialQuestionFor(room, id, selection);
    const chosen = await dialog.showOpenDialog(window!, { title: `${question.sender}님의 질문에 연결할 자료`, properties: ['openFile', 'multiSelections'], filters: [{ name: '사진·문서', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'doc', 'docx', 'hwp', 'hwpx', 'txt', 'md', 'csv'] }] });
    if (!chosen.canceled) { materialQuestionFor(room, id, selection); const source = attachmentSourceFor(room, selection); invalidateMedia(room); await questionContexts.attach(room, question, chosen.filePaths, source); changed(); }
    return state();
  });
  handle('reply:question-drop', async (value: unknown, id: unknown, paths: unknown, selection: unknown) => {
    const room = roomName(value), question = materialQuestionFor(room, id, selection);
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) throw new Error('사진·파일을 다시 끌어놓아주세요.');
    const source = attachmentSourceFor(room, selection); invalidateMedia(room); await questionContexts.attach(room, question, paths, source); changed(); return state();
  });
  handle('reply:question-file-link', (value: unknown, id: unknown, fileId: unknown, selection: unknown) => {
    const room = roomName(value), question = questionFor(room, id);
    if (typeof fileId !== 'string') throw new Error('자료 파일을 선택해주세요.');
    const source = attachmentSourceFor(room, selection);
    invalidateMedia(room); questionContexts.link(room, question.id, fileId, source); changed(); return state();
  });
  handle('reply:question-file-remove', (value: unknown, id: unknown, attachmentId: unknown) => {
    const room = roomName(value), question = materialRemovalQuestionFor(room, id, attachmentId);
    if (typeof attachmentId !== 'string') throw new Error('연결된 파일을 선택해주세요.');
    invalidateMedia(room); questionContexts.remove(room, question.id, attachmentId); changed(); return state();
  });
  handle('reply:question-generate', (value: unknown, id: unknown) => {
    const room = roomName(value), question = questionFor(room, id);
    if (room !== store.value.settings.room) throw new Error('먼저 해당 채팅방을 선택해주세요.');
    if (draftTest.running) throw new Error('진행 중인 초안이 완료된 뒤 다시 시도해주세요.');
    void runQuestionDraft(room, question).catch(error => { draftTest.error = error instanceof Error ? error.message : '초안을 만들지 못했습니다.'; changed(); }); return state();
  });
  handle('reply:settings', async (input: unknown) => {
    const settings = validateSettings(input);
    settings.model = findModel(settings.model, modelCatalog.items)?.id || settings.model;
    effectiveModelSettings(settings, modelCatalog.items); // Reject unsupported model/effort combinations before starting any job.
    settings.room = store.value.settings.room; // Selection is separate from common prompt/settings edits.
    if (settings.delivery === 'kakao' && !store.hasToken()) throw new Error('카카오톡 전송을 사용하려면 먼저 액세스 토큰을 저장해주세요.');
    const pathChanged = settings.codexPath !== store.value.settings.codexPath;
    cancelTest(); store.value.settings = settings; collection.configure(settings); store.save(); changed();
    if (pathChanged) { modelCatalog.items = []; void refreshModels(); }
    await refreshConnection(); return state();
  });
  handle('reply:room-add', async (input: unknown) => {
    const room = roomName(input);
    if (collection.get(room)) throw new Error('이미 저장된 채팅방입니다. 목록에서 선택해주세요.');
    cancelTest(); collection.add(room); store.value.settings.room = room; store.value.roomNames = [...collection.monitors.keys()];
    changed(); store.save(); await refreshConnection(room); return state();
  });
  handle('reply:person-prompt', (input: unknown, name: unknown, prompt: unknown) => {
    const room = roomName(input);
    if (!collection.get(room)) throw new Error('저장된 채팅방을 선택해주세요.');
    const profile = validatePersonPrompt(name, prompt);
    const previous = Object.hasOwn(store.value.personPromptsByRoom, room) ? store.value.personPromptsByRoom[room] : undefined;
    const next = { ...previous };
    if (profile.prompt) Object.defineProperty(next, profile.name, { value: profile.prompt, enumerable: true, configurable: true, writable: true });
    else delete next[profile.name];
    if (Object.keys(next).length > 100) throw new Error('한 방에는 개인 프롬프트를 최대 100명까지 저장할 수 있습니다.');
    Object.defineProperty(store.value.personPromptsByRoom, room, { value: next, enumerable: true, configurable: true, writable: true });
    try { store.save(); } catch (error) { if (previous) store.value.personPromptsByRoom[room] = previous; else delete store.value.personPromptsByRoom[room]; throw error; }
    if (room === store.value.settings.room) cancelTest();
    collection.setPersonPrompts(room, next); changed(); return state();
  });
  handle('reply:room-participants', async (input: unknown, value: unknown) => {
    const room = roomName(input);
    if (!collection.get(room)) throw new Error('저장된 채팅방을 선택해주세요.');
    const participants = value === null ? undefined : validateParticipants(value);
    if (room === store.value.settings.room) cancelTest();
    collection.setParticipants(room, participants);
    store.value.participantsByRoom = Object.fromEntries(collection.participants);
    store.save(); changed(); await refreshConnection(room); return state();
  });
  handle('reply:room-select', async (input: unknown) => {
    const room = roomName(input); if (!collection.get(room)) throw new Error('저장된 채팅방을 선택해주세요.');
    if (store.value.settings.room !== room) cancelTest();
    store.value.settings.room = room; store.save(); changed(); await refreshConnection(room); return state();
  });
  handle('reply:room-remove', (input: unknown) => {
    const room = roomName(input); if (room === store.value.settings.room) cancelTest(); collection.remove(room); delete store.value.personPromptsByRoom[room]; questionContexts.removeRoom(room);
    if (store.value.settings.room === room) store.value.settings.room = [...collection.monitors.keys()][0] ?? '';
    store.value.roomNames = [...collection.monitors.keys()]; store.value.participantsByRoom = Object.fromEntries(collection.participants); changed(); store.save(); return state();
  });
  handle('reply:room-toggle', (input: unknown, enabled: unknown) => {
    const monitor = collection.get(roomName(input));
    if (!monitor || typeof enabled !== 'boolean') throw new Error('채팅방과 감지 상태를 확인해주세요.');
    if (enabled) { monitor.start(); void poll(); } else monitor.stop();
    changed(); return state();
  });
  handle('reply:token', (token: unknown) => {
    if (demo) throw new Error('데모에서는 인증 정보를 저장하지 않습니다.');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.~+/=-]{10,4096}$/.test(token.trim())) throw new Error('카카오 액세스 토큰 형식을 확인해주세요.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('운영체제의 안전한 저장소를 사용할 수 없어 토큰을 저장하지 않았습니다.');
    writeFileSync(store.tokenFile(), safeStorage.encryptString(token.trim()), { mode: 0o600 }); changed(); return state();
  });
  handle('reply:token-delete', () => {
    store.deleteToken(); store.value.settings.delivery = 'app'; collection.configure(store.value.settings); store.save(); changed(); return state();
  });
  handle('reply:copy', (id: unknown, text: unknown) => {
    if (text !== undefined) { const pending = draftAutosave.update(id, text); void pending.catch(() => {}); }
    draftAutosave.flush();
    const draft = store.value.drafts.find(d => d.id === id); if (!draft) throw new Error('초안을 찾을 수 없습니다.');
    if (!draft.text.trim()) throw new Error('복사할 초안 내용을 입력해주세요.');
    clipboard.writeText(draft.text);
  });
  handle('reply:draft-edit', (id: unknown, text: unknown) => draftAutosave.update(id, text));
  handle('reply:drafts-flush', () => draftAutosave.flush());
  handle('reply:draft-rewrite', (id: unknown, text: unknown, instruction: unknown) => {
    if (draftTest.running || contactSender.busyDraftId) throw new Error('진행 중인 생성·전송이 끝난 뒤 다시 시도해주세요.');
    const input = validateRewrite(text, instruction);
    const source = store.value.drafts.find(draft => draft.id === id);
    if (!source || source.room !== store.value.settings.room || !collection.get(source.room) || (source.test && source.testSource !== 'conversation')) throw new Error('선택한 실제 대화의 초안을 다시 작성해주세요.');
    draftAutosave.flush(); store.updateDraft(source.id, input.previousText);
    void runRewrite(structuredClone(source), input); return state();
  });
  handle('reply:draft-send', (id: unknown, text: unknown) => {
    if (demo || process.platform !== 'darwin') throw new Error('직접 전송은 현재 Mac 일반 실행에서만 지원합니다.');
    draftAutosave.flush(); return contactSender.send(id, text);
  });
  handle('reply:action', async (action: ReplyAction) => {
    switch (action) {
      case 'check-updates':
        if (demo) throw new Error('데모에서는 업데이트를 조회하지 않습니다.');
        void updates.check(); break;
      case 'download-update': await downloadUpdate(); break;
      case 'refresh': await refreshConnection(); break;
      case 'start':
        if (!collection.monitors.size) throw new Error('먼저 감지할 채팅방을 추가해주세요.');
        if (!store.value.settings.prompt.trim()) throw new Error('공통 프롬프트를 입력해주세요.');
        collection.startAll(); void poll(); break;
      case 'stop': collection.stopAll(); break;
      case 'permission':
        if (process.platform === 'darwin') { systemPreferences.isTrustedAccessibilityClient(true); await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); }
        break;
      case 'windows-diagnostic': {
        if (!(reader instanceof WindowsReader)) throw new Error('Windows에서만 구조 진단 파일을 저장할 수 있습니다.');
        const room = store.value.settings.room;
        if (!room) throw new Error('진단할 채팅방을 먼저 선택해주세요.');
        const report = await reader.diagnostic(room);
        const result = await dialog.showSaveDialog({ title: '메시지 본문 없는 Windows 구조 진단 저장', defaultPath: 'reply-note-windows-diagnostic.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!result.canceled && result.filePath) writeFileSync(result.filePath, JSON.stringify({ version: app.getVersion(), ...report }, null, 2), { mode: 0o600 });
        break;
      }
      case 'cancel-draft': cancelTest(); break;
      case 'test-notification': notifications.test(); break;
      case 'check-codex': codexAvailable = demo || await checkCodex(store.value.settings.codexPath); break;
      case 'refresh-models': if (!modelCatalog.loading) void refreshModels(); break;
      case 'draft-conversation':
      case 'test-draft':
        if (demo) throw new Error('실제 Codex 연결 시험은 일반 모드에서 사용할 수 있습니다.');
        if (!store.value.settings.prompt.trim()) throw new Error('공통 프롬프트를 먼저 저장해주세요.');
        if (action === 'draft-conversation' && !collection.get(store.value.settings.room)) throw new Error('먼저 실제 채팅방을 추가하고 선택해주세요.');
        void runDraftTest(action === 'draft-conversation' ? 'conversation' : 'synthetic'); break;
      case 'clear': cancelTest(); collection.forgetAll(); questionContexts.clear(); store.value.archiveByRoom = {}; store.value.messagesByRoom = {}; store.value.messages = []; store.value.drafts = []; store.save(); changed(); break;
      case 'demo-photo': case 'demo-file':
        if (!(reader instanceof DemoReader)) throw new Error('데모에서만 사용할 수 있습니다.');
        reader.appendMedia(action === 'demo-photo' ? 'image' : 'file'); await poll(); break;
      case 'demo-student-a': case 'demo-student-b': case 'demo-teacher':
        if (!(reader instanceof DemoReader)) throw new Error('데모에서만 사용할 수 있습니다.');
        reader.appendGroup(action === 'demo-teacher' ? '김선생님' : action === 'demo-student-a' ? '민수' : '지우'); await poll(); break;
      case 'demo-incoming': case 'demo-outgoing':
        if (!(reader instanceof DemoReader)) throw new Error('데모에서만 사용할 수 있습니다.');
        reader.append(action === 'demo-incoming' ? 'incoming' : 'outgoing'); await poll(); break;
      default: throw new Error('지원하지 않는 동작입니다.');
    }
    changed(); return state();
  });
}
if (locked) {
  app.on('second-instance', show);
  void app.whenReady().then(() => {
    store = new Store(demo ? demoDirectory : app.getPath('userData'));
    questionContexts = new QuestionContexts(store.directory);
    draftAutosave = new DraftAutosave(store, changed);
    if (demo) {
      store.value.settings.room = '수학 수업방'; store.value.settings.delivery = 'app'; store.value.roomNames = ['수학 수업방', '테스트 친구'];
      store.value.participantsByRoom['수학 수업방'] ??= { questioners: ['민수', '지우'], teachers: ['김선생님', '나'] };
    }
    const binary = app.isPackaged ? path.join(process.resourcesPath, 'native/chat-reader.node') : path.join(app.getAppPath(), 'native/bin/chat-reader.node');
    const windowsScript = app.isPackaged ? path.join(process.resourcesPath, 'native/windows/chat-reader.ps1') : path.join(app.getAppPath(), 'native/windows/chat-reader.ps1');
    reader = demo ? new DemoReader() : process.platform === 'darwin' ? new MacReader(binary) : process.platform === 'win32' ? new WindowsReader(windowsScript) : new UnsupportedReader();
    collection = new RoomCollection(store.value.settings, room => ({ changed, materials: () => questionContexts.views(room), recheck: () => snapshot(room), generate, publish, teacherResponded: (sender, at) => { if (store.value.settings.room === room && (draftTest.source === 'conversation' || draftTest.source === 'rewrite')) cancelTest(); store.markTeacherResponse(room, sender, at); changed(); } }));
    contactSender = new ContactSender(store, (room, text) => { if (!(reader instanceof MacReader)) throw new Error('Mac 전송 모듈이 필요합니다.'); return reader.send(room, text); }, room => store.value.settings.room === room && !!collection.get(room) && collection.get(room)!.state.chatKind !== 'group', room => { cancelTest(); const monitor = collection.get(room); if (monitor?.state.enabled) monitor.start(); }, changed);
    for (const room of store.value.roomNames) collection.add(room, store.value.messagesByRoom[room], store.value.participantsByRoom[room], store.value.personPromptsByRoom[room]);
    savedMessages = JSON.stringify(collection.histories());
    installIPC(); createMenu(); createTray(); createWindow(); void refreshConnection(); void refreshModels();
    if (app.isPackaged && !demo) {
      void updates.check();
      updateInterval = setInterval(() => { void updates.check(); }, 6 * 60 * 60 * 1000);
    }
    interval = setInterval(() => { void poll(); }, 2000);
    powerMonitor.on('suspend', () => {
      for (const [room, monitor] of collection.monitors) if (monitor.state.enabled) monitor.ingest({ status: 'error', room, messages: [], capturedAt: Date.now(), detail: '절전으로 감지를 멈췄습니다. 깨어나면 대화를 다시 연결합니다.' });
    });
    powerMonitor.on('resume', () => { void poll(); });
    app.on('activate', show);
  });
}
app.on('before-quit', () => { try { draftAutosave?.flush(); } catch { /* error state was already reported */ } quitting = true; updates.close(); if (updateInterval) clearInterval(updateInterval); if (interval) clearInterval(interval); modelLoadController?.abort(); cancelTest(); collection?.stopAll(); reader?.close(); notifications.close(); tray?.destroy(); tray = null; });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
