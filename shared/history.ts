import type { ChatMessage } from './types';
export const HISTORY_LIMIT = 500;
export function mergeHistory(previous: ChatMessage[], recent: ChatMessage[]): ChatMessage[] {
  const history = new Map(previous.map(m => [m.id, m]));
  for (const m of recent) history.set(m.id, { ...m });
  const result = [...history.values()].slice(-HISTORY_LIMIT);
  let characters = 0;
  return result.reverse().filter(m => { characters += m.text.length; return characters <= 200_000; }).reverse();
}
