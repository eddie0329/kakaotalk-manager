import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { listCodexModels, parseModels, resolveModel } from './models';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
afterEach(() => vi.clearAllMocks());
describe('Codex model selection', () => {
  it('uses only reasoning levels and defaults advertised by each model', () => {
    const [model] = parseModels([{ model: 'example-effort-model', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }, { reasoningEffort: 'high', description: 'Deeper' }, { reasoningEffort: 'not a valid value' }] }]);
    expect(model.defaultEffort).toBe('low');
    expect(model.efforts?.map(option => option.id)).toEqual(['low', 'high']);
  });
  it('uses execution identifiers, omits hidden/non-text models, and does not hard-code a catalog', () => {
    expect(parseModels([
      { id: 'catalog-internal-id', model: 'example-alpha', displayName: 'Example Alpha', isDefault: true },
      { model: 'hidden-model', hidden: true },
      { model: 'image-only', inputModalities: ['image'] },
      { model: 'example-beta', inputModalities: ['text'] }
    ])).toEqual([
      { id: 'example-alpha', name: 'Example Alpha', description: '', isDefault: true },
      { id: 'example-beta', name: 'example-beta', description: '', isDefault: false }
    ]);
  });
  it('keeps an explicit model unchanged and only resolves auto from an advertised default', () => {
    const catalog = parseModels([{ model: 'example-default', isDefault: true }]);
    expect(resolveModel('my-custom-model', catalog)).toBe('my-custom-model');
    expect(resolveModel('', catalog)).toBe('example-default');
    expect(resolveModel('', [])).toBe('');
    expect(resolveModel('', parseModels([{ model: 'not-marked-default' }]))).toBe('');
  });
  it('initializes, follows pages, and never creates a conversation or sends chat data', async () => {
    const packets: any[] = [];
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        const packet = JSON.parse(line); packets.push(packet);
        if (packet.method === 'initialize') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: packet.id, result: {} }) + '\n'));
        if (packet.method === 'model/list') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: packet.id, result: packet.params.cursor
          ? { data: [{ model: 'example-beta' }], nextCursor: null }
          : { data: [{ model: 'example-alpha', isDefault: true }], nextCursor: 'page-2' } }) + '\n'));
      }
      callback();
    } });
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
    vi.mocked(spawn).mockReturnValueOnce(child);
    const result = await listCodexModels('/fake/codex');
    expect(result.map(model => model.id)).toEqual(['example-alpha', 'example-beta']);
    expect(packets.map(packet => packet.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
    expect(packets[2].params.includeHidden).toBe(false);
    expect(child.kill).toHaveBeenCalled();
  });
  it('reports a protocol error and shuts down without inventing a model list', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const packet = JSON.parse(chunk.toString());
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: packet.id, error: { message: 'unsupported' } }) + '\n')); callback();
    } });
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
    vi.mocked(spawn).mockReturnValueOnce(child);
    await expect(listCodexModels('/fake/codex')).rejects.toThrow('모델 목록을 조회하지 못했습니다');
    expect(child.kill).toHaveBeenCalled();
  });
});
