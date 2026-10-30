import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CodexModel } from '../shared/types';
import { codexExecutable } from './codex';
import { stopProcessTree } from './process-tree';
import { findModel } from '../shared/model-settings';

export function parseModels(data: unknown): CodexModel[] {
  if (!Array.isArray(data)) throw new Error('Codex 모델 목록 형식을 확인하지 못했습니다.');
  const result = new Map<string, CodexModel>();
  for (const item of data) {
    if (!item || typeof item !== 'object' || item.hidden === true) continue;
    const id = typeof item.model === 'string' ? item.model : item.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 100) continue;
    if (Array.isArray(item.inputModalities) && !item.inputModalities.includes('text')) continue;
    const model: CodexModel = { id, name: typeof item.displayName === 'string' ? item.displayName : id, description: typeof item.description === 'string' ? item.description : '', isDefault: item.isDefault === true };
    if (Array.isArray(item.supportedReasoningEfforts)) model.efforts = item.supportedReasoningEfforts.filter((option: any) => option && typeof option.reasoningEffort === 'string' && /^[a-z_]{1,30}$/.test(option.reasoningEffort)).map((option: any) => ({ id: option.reasoningEffort, description: typeof option.description === 'string' ? option.description : '' }));
    if (typeof item.defaultReasoningEffort === 'string' && /^[a-z_]{1,30}$/.test(item.defaultReasoningEffort)) model.defaultEffort = item.defaultReasoningEffort;
    result.set(id, model);
  }
  return [...result.values()];
}

/** A short-lived, metadata-only app-server connection. Never creates a thread or sends a prompt. */
export async function listCodexModels(configuredPath: string, signal?: AbortSignal): Promise<CodexModel[]> {
  if (signal?.aborted) throw new Error('모델 목록 조회를 취소했습니다.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reply-note-models-'));
  const child = spawn(codexExecutable(configuredPath), ['app-server', '--listen', 'stdio://'], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
  try {
    return await new Promise<CodexModel[]>((resolve, reject) => {
      let settled = false;
      let listId = 2;
      let pageCount = 0;
      const models = new Map<string, CodexModel>();
      const cursors = new Set<string>();
      const fail = (message: string) => { if (!settled) { settled = true; reject(new Error(message)); } };
      onAbort = () => { stopProcessTree(child); fail('모델 목록 조회를 취소했습니다.'); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const send = (packet: object) => { if (!settled) child.stdin.write(JSON.stringify(packet) + '\n'); };
      timer = setTimeout(() => fail('모델 목록을 가져오는 시간이 초과됐습니다. Codex 연결을 확인하고 다시 불러와주세요.'), 20_000);
      child.once('error', () => fail('Codex를 실행하지 못했습니다. 실행 파일 경로와 설치 상태를 확인해주세요.'));
      child.once('close', () => fail('모델 목록을 받기 전에 Codex 연결이 종료됐습니다.'));
      lines.on('line', line => {
        if (settled) return;
        let packet;
        try { packet = JSON.parse(line); } catch { return; }
        if (packet.id !== 1 && packet.id !== listId) return;
        if (packet.error) { fail('Codex에서 모델 목록을 조회하지 못했습니다. Codex 로그인과 CLI 버전을 확인해주세요.'); return; }
        if (packet.id === 1) {
          send({ method: 'initialized' });
          send({ id: listId, method: 'model/list', params: { limit: 100, includeHidden: false } });
          return;
        }
        try {
          for (const model of parseModels(packet.result?.data)) models.set(model.id, model);
          const cursor = packet.result?.nextCursor;
          if (cursor !== null && cursor !== undefined && typeof cursor !== 'string') throw new Error('모델 목록의 다음 페이지 정보를 확인하지 못했습니다.');
          if (cursor) {
            if (++pageCount >= 10 || cursors.has(cursor)) throw new Error('모델 목록을 완전히 읽지 못했습니다. 다시 불러와주세요.');
            cursors.add(cursor); listId++;
            send({ id: listId, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } });
          } else {
            if (!models.size) throw new Error('Codex가 표시할 모델을 반환하지 않았습니다. 로그인 상태를 확인하거나 모델 ID를 직접 입력해주세요.');
            settled = true; resolve([...models.values()]);
          }
        } catch (e) { fail(e instanceof Error ? e.message : '모델 목록을 읽지 못했습니다.'); }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'reply_note', title: 'Reply Note', version: '0.4.3' } } });
      if (signal?.aborted) onAbort();
    });
  } finally {
    clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); lines.close(); child.stdin.end(); stopProcessTree(child);
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(resolve => { forceTimer = setTimeout(() => { stopProcessTree(child, 'SIGKILL'); resolve(); }, 1000); })]);
    clearTimeout(forceTimer);
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export function resolveModel(selected: string, models: CodexModel[]): string {
  return findModel(selected, models)?.id || selected.trim() || models.find(model => model.isDefault)?.id || '';
}
