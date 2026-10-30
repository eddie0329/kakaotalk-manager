import { expect, it } from 'vitest';
import { mergeHistory } from '../shared/history';
import type { ChatMessage } from '../shared/types';
const m = (id: number): ChatMessage => ({ id: String(id), text: `본문 ${id}`, sender: '학생', direction: 'incoming', time: '' });
it('accumulates older context beyond the live 20 messages without duplicating repeated polls', () => {
  let history = mergeHistory([], Array.from({ length: 20 }, (_, n) => m(n)));
  history = mergeHistory(history, Array.from({ length: 20 }, (_, n) => m(n + 10)));
  expect(history).toHaveLength(30); expect(history[0].id).toBe('0');
  expect(mergeHistory(history, history.slice(-20))).toEqual(history);
});
it('bounds retained messages and text size', () => {
  expect(mergeHistory([], Array.from({ length: 600 }, (_, n) => m(n)))).toHaveLength(500);
  const history = mergeHistory([], Array.from({ length: 30 }, (_, n) => ({ ...m(n), text: 'x'.repeat(20000) })));
  expect(history).toHaveLength(10);
});
