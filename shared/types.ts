export interface ChatAttachment { id: string; kind: 'image' | 'file' | 'unknown'; name?: string; count?: number; }
export interface AttachmentSelection { messageId: string; attachmentId: string; }
export interface AttachmentSource { message: ChatMessage; attachmentId: string; }
export interface AttachmentInfo { source?: AttachmentSource; id: string; name: string; kind: 'image' | 'pdf' | 'document' | 'text'; size: number; imageCount: number; excerpt: string; warning?: string; }
export interface QuestionContext { question: ChatMessage; references: ChatMessage[]; note: string; attachments: AttachmentInfo[]; updatedAt: number; }
export interface PreparedContext extends QuestionContext { documents: { name: string; text: string }[]; images: { name: string; path: string }[]; }
export interface RoomParticipants { questioners: string[]; teachers: string[]; }
export interface ReplyTarget { sender: string; messages: ChatMessage[]; }
export interface ParticipantTask { sender: string; phase: 'waiting' | 'generating' | 'needs_materials' | 'error'; dueAt: number | null; detail?: string; }
export type Direction = 'incoming' | 'outgoing' | 'unknown';
export interface ChatMessage { attachments?: ChatAttachment[]; id: string; text: string; direction: Direction; sender: string; time: string; }
export type ReaderStatus = 'ready' | 'permission_required' | 'not_running' | 'room_closed' | 'unsupported_room' | 'ambiguous_room' | 'unsupported_platform' | 'error';
export interface Snapshot { status: ReaderStatus; room: string; messages: ChatMessage[]; detail?: string; capturedAt: number; chatKind?: 'direct' | 'self' | 'group'; }
export interface Settings { materialMessages?: ChatMessage[]; rewrite?: { previousText: string; instruction: string }; personPrompts?: Record<string, string>; room: string; prompt: string; codexPath: string; model: string; effort?: string; delivery: 'app' | 'kakao'; participants?: RoomParticipants; replyTarget?: ReplyTarget; contexts?: PreparedContext[]; }
export interface ContactSendResult { outcome: 'sent' | 'failed' | 'unknown'; detail: string; minimized: boolean; }
export interface ContactSendAttempt { outcome: 'sending' | 'sent' | 'failed' | 'unknown'; text: string; at: number; detail?: string; }
export interface Draft { revision?: { parentId: string; instruction: string }; contexts?: QuestionContext[]; contactSend?: ContactSendAttempt; targetSender?: string; targetMessages?: ChatMessage[]; teacherResponse?: { sender: string; at: number }; id: string; room: string; text: string; originalText?: string; editedAt?: number; createdAt: number; delivery: 'local' | 'sent' | 'failed'; deliveryError?: string; test?: boolean; testSource?: 'synthetic' | 'conversation'; model?: string; effort?: string; }
export interface GeneratedReply { text: string; model?: string; effort?: string; contexts?: QuestionContext[]; }
export interface EffortOption { id: string; description: string; }
export interface CodexModel { id: string; name: string; description: string; isDefault: boolean; efforts?: EffortOption[]; defaultEffort?: string; }
export interface ModelCatalog { items: CodexModel[]; loading: boolean; error: string | null; }
export type Phase = 'paused' | 'connecting' | 'watching' | 'waiting' | 'generating' | 'needs_attention' | 'needs_materials' | 'error';
export interface MonitorState { enabled: boolean; phase: Phase; detail: string; readerStatus: ReaderStatus | null; messages: ChatMessage[]; dueAt: number | null; lastCheckedAt: number | null; chatKind: 'direct' | 'self' | 'group' | null; tasks?: ParticipantTask[]; }
export interface SavedRoom { personPrompts?: Record<string, string>; room: string; monitor: MonitorState; participants?: RoomParticipants; }
export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'unavailable' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: number | null;
  notes: string;
  downloadUrl: string | null;
  message: string;
}
export interface AppState { history?: ChatMessage[]; questionContexts?: QuestionContext[]; contactSending?: string | null; draftSaveStatus?: Record<string, 'saving' | 'error'>; update: UpdateState; notificationError?: string | null; draftFocus?: { id: string; request: number }; settings: Settings; monitor: MonitorState; targets: SavedRoom[]; draftTest: { running: boolean; error: string | null; source?: 'synthetic' | 'conversation' | 'rewrite'; draftId?: string }; modelCatalog: ModelCatalog; drafts: Draft[]; rooms: string[]; tokenSaved: boolean; secureStorage: boolean; platform: string; demo: boolean; codexAvailable: boolean | null; }
export type ReplyAction = 'cancel-draft' | 'check-updates' | 'download-update' | 'refresh' | 'start' | 'stop' | 'permission' | 'windows-diagnostic' | 'clear' | 'check-codex' | 'refresh-models' | 'test-notification' | 'test-draft' | 'draft-conversation' | 'demo-incoming' | 'demo-outgoing' | 'demo-student-a' | 'demo-student-b' | 'demo-teacher' | 'demo-photo' | 'demo-file';
export interface ReplyAPI {
  acquireChatAttachment(room: string, source: AttachmentSelection): Promise<AppState>;
  getState(): Promise<AppState>;
  saveQuestionContext(room: string, questionId: string, referenceIds: string[], note: string): Promise<AppState>;
  pickQuestionFiles(room: string, questionId: string, source?: AttachmentSelection): Promise<AppState>;
  dropQuestionFiles(room: string, questionId: string, files: File[], source?: AttachmentSelection): Promise<AppState>;
  linkQuestionFile(room: string, questionId: string, attachmentId: string, source?: AttachmentSelection): Promise<AppState>;
  removeQuestionFile(room: string, questionId: string, attachmentId: string): Promise<AppState>;
  generateQuestionDraft(room: string, questionId: string): Promise<AppState>;
  saveSettings(settings: Settings): Promise<AppState>;
  addRoom(room: string): Promise<AppState>;
  savePersonPrompt(room: string, name: string, prompt: string): Promise<AppState>;
  saveRoomParticipants(room: string, participants: RoomParticipants | null): Promise<AppState>;
  selectRoom(room: string): Promise<AppState>;
  removeRoom(room: string): Promise<AppState>;
  toggleRoom(room: string, enabled: boolean): Promise<AppState>;
  action(action: ReplyAction): Promise<AppState>;
  saveToken(token: string): Promise<AppState>;
  deleteToken(): Promise<AppState>;
  copyDraft(id: string, text?: string): Promise<void>;
  flushDrafts(): Promise<void>;
  rewriteDraft(id: string, text: string, instruction: string): Promise<AppState>;
  sendDraft(id: string, text: string): Promise<ContactSendResult>;
  updateDraft(id: string, text: string): Promise<void>;
  onState(listener: (state: AppState) => void): () => void;
}
export const DEFAULT_PROMPT = '상대방과 나의 최근 대화를 읽고, 내가 보낼 자연스러운 한국어 답장 초안을 작성해줘.\n내 말투와 상대방과의 관계를 참고하고, 짧고 편안하게 답해줘.\n대화에 없는 사실이나 약속은 만들어내지 마.\n답장 본문만 출력해줘.';
