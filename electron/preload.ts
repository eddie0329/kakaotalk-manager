import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppState, ReplyAPI, ReplyAction, Settings } from '../shared/types';
const api: ReplyAPI = {
  acquireChatAttachment: (room, source) => ipcRenderer.invoke('reply:attachment-acquire', room, source),
  saveQuestionContext: (room, questionId, references, note) => ipcRenderer.invoke('reply:question-context', room, questionId, references, note),
  pickQuestionFiles: (room, questionId, source) => ipcRenderer.invoke('reply:question-files', room, questionId, source),
  dropQuestionFiles: (room, questionId, files, source) => ipcRenderer.invoke('reply:question-drop', room, questionId, files.map(file => webUtils.getPathForFile(file)), source),
  linkQuestionFile: (room, questionId, id, source) => ipcRenderer.invoke('reply:question-file-link', room, questionId, id, source),
  removeQuestionFile: (room, questionId, id) => ipcRenderer.invoke('reply:question-file-remove', room, questionId, id),
  generateQuestionDraft: (room, questionId) => ipcRenderer.invoke('reply:question-generate', room, questionId),
  getState: () => ipcRenderer.invoke('reply:get'),
  saveSettings: (settings: Settings) => ipcRenderer.invoke('reply:settings', settings),
  addRoom: (room: string) => ipcRenderer.invoke('reply:room-add', room),
  savePersonPrompt: (room, name, prompt) => ipcRenderer.invoke('reply:person-prompt', room, name, prompt),
  saveRoomParticipants: (room, participants) => ipcRenderer.invoke('reply:room-participants', room, participants),
  selectRoom: (room: string) => ipcRenderer.invoke('reply:room-select', room),
  removeRoom: (room: string) => ipcRenderer.invoke('reply:room-remove', room),
  toggleRoom: (room: string, enabled: boolean) => ipcRenderer.invoke('reply:room-toggle', room, enabled),
  action: (action: ReplyAction) => ipcRenderer.invoke('reply:action', action),
  saveToken: (token: string) => ipcRenderer.invoke('reply:token', token),
  deleteToken: () => ipcRenderer.invoke('reply:token-delete'),
  copyDraft: (id: string, text?: string) => ipcRenderer.invoke('reply:copy', id, text),
  flushDrafts: () => ipcRenderer.invoke('reply:drafts-flush'),
  rewriteDraft: (id, text, instruction) => ipcRenderer.invoke('reply:draft-rewrite', id, text, instruction),
  sendDraft: (id: string, text: string) => ipcRenderer.invoke('reply:draft-send', id, text),
  updateDraft: (id: string, text: string) => ipcRenderer.invoke('reply:draft-edit', id, text),
  onState: (listener: (state: AppState) => void) => { const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state); ipcRenderer.on('reply:state', handler); return () => { ipcRenderer.removeListener('reply:state', handler); }; }
};
contextBridge.exposeInMainWorld('replyNote', api);
