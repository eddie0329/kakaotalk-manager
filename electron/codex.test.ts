import { describe, expect, it } from 'vitest';
import { codexArguments, codexFailure, promptFor } from './codex';
describe('Codex execution configuration and diagnostics', () => {
  it('passes model and effort as separate exec arguments, with prompt input kept on stdin', () => {
    const args = codexArguments({ room: '친구', prompt: '실제 대화가 아닌 테스트', codexPath: '', model: 'example-model', effort: 'high', delivery: 'app' }, '/tmp/work', '/tmp/reply');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'example-model']);
    expect(args).toContain('model_reasoning_effort="high"'); expect(args.at(-1)).toBe('-');
    expect(args.join(' ')).not.toContain('실제 대화');
  });
  it('does not diagnose a rejected display name as a login failure', () => {
    const error = '{"status":400,"error":{"message":"The GPT-6.1-Sol model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}';
    expect(codexFailure(error, 'GPT-6.1-Sol')).toContain('실행 ID');
    expect(codexFailure(error, 'GPT-6.1-Sol')).not.toContain('만료');
  });
  it('distinguishes effort, usage, and authentication errors without exposing raw error contents', () => {
    expect(codexFailure('unsupported reasoning effort', '', 'high')).toContain('effort');
    expect(codexFailure('usage_limit_reached')).toContain('사용 한도');
    expect(codexFailure('401 unauthorized')).toContain('로그인');
    expect(codexFailure('private arbitrary server error: sk-secret', 'sk-secret')).not.toContain('sk-secret');
  });
});

it('preserves distinct group speakers and targets an earlier questioner rather than the final speaker', () => {
  const messages = [
    { id: 'a', sender: '학생 A', text: '첫 질문', direction: 'incoming' as const, time: '' },
    { id: 'b', sender: '학생 B', text: '별개 질문', direction: 'incoming' as const, time: '' }
  ];
  const prompt = promptFor(messages, { room: '수학방', prompt: '', model: '', codexPath: '', delivery: 'app', replyTarget: { sender: '학생 A', messages: [messages[0]] } });
  expect(prompt).toContain('"speaker":"학생 A"'); expect(prompt).toContain('"speaker":"학생 B"');
  expect(prompt).toContain('[답변 대상 · JSON 데이터]'); expect(prompt).not.toContain('마지막 상대 메시지에 이어질');
});

it('supplies source text, missing-content warnings and global image order without exposing managed paths in the prompt', () => {
  const question = { id: 'q', sender: '학생', text: '설명해주세요', direction: 'incoming' as const, time: '' };
  const context = { question, references: [{ ...question, id: 'original', sender: '선생님', text: '이전 설명' }], note: '사용자가 연결한 원문', attachments: [{ id: 'file', name: '문제.hwp', kind: 'document' as const, size: 1, imageCount: 0, excerpt: '', warning: '수식은 누락될 수 있습니다.' }], updatedAt: 1, documents: [{ name: '문제.hwp', text: '문서 본문' }], images: [{ name: '사진.png', path: '/private/material/image.png' }] };
  const settings = { room: '수학방', prompt: '', codexPath: '', model: '', delivery: 'app' as const, contexts: [context, { ...context, question: { ...question, id: 'q2' } }] };
  const prompt = promptFor([question], settings);
  for (const text of ['이전 설명', '문서 본문', '사용자가 연결한 원문', '수식은 누락', '"order":1', '"order":2']) expect(prompt).toContain(text);
  expect(prompt).not.toContain('/private/material');
  const args = codexArguments(settings, '/temp', '/temp/reply', ['/temp/image-1.png', '/temp/image-2.png']);
  expect(args.filter(arg => arg === '--image')).toHaveLength(2); expect(args).toContain('/temp/image-2.png');
});

it('rejects unread media before building a prompt and includes known attachment metadata when content is linked', () => {
  const photo = { id: 'photo', sender: '학생', direction: 'incoming' as const, text: '', time: '', attachments: [{ id: 'media-0', kind: 'image' as const }] };
  const settings = { room: '수학방', prompt: '', codexPath: '', model: '', delivery: 'app' as const };
  expect(() => promptFor([photo], settings)).toThrow('내용 확인');
  const context = { question: photo, references: [], note: '', updatedAt: 1, attachments: [{ id: 'file', name: '문제.png', kind: 'image' as const, size: 10, imageCount: 1, excerpt: '', source: { message: photo, attachmentId: 'media-0' } }], documents: [], images: [{ name: '문제.png', path: '/managed/image.png' }] };
  const prompt = promptFor([photo], { ...settings, contexts: [context] }); expect(prompt).toContain('"attachments"'); expect(prompt).toContain('"kind":"image"');
});
