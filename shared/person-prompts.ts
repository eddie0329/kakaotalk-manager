import type { ChatMessage, Settings } from './types';
export type PersonPrompts = Record<string, string>;
export const PERSON_PROMPT_LIMIT = 5000;
export function validatePersonPrompt(name: unknown, prompt: unknown): { name: string; prompt: string } {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200 || /[\r\n\0]/.test(name)) throw new Error('카카오톡 표시 이름을 200자 이내로 입력해주세요.');
  if (typeof prompt !== 'string' || prompt.length > PERSON_PROMPT_LIMIT || prompt.includes('\0')) throw new Error('개인 프롬프트는 5,000자 이내로 입력해주세요.');
  return { name: name.trim(), prompt: prompt.trim() };
}
export function validPersonPrompts(input: unknown): PersonPrompts {
  const entries: Array<[string, string]> = [];
  if (input && typeof input === 'object' && !Array.isArray(input)) for (const [name, text] of Object.entries(input).slice(0, 100)) {
    try { const value = validatePersonPrompt(name, text); if (value.prompt) entries.push([value.name, value.prompt]); } catch { /* Preserve valid profiles and old conversation data. */ }
  }
  return Object.fromEntries(entries);
}
export function personPromptFor(messages: ChatMessage[], settings: Settings): { sender: string; prompt: string } | undefined {
  const sender = settings.replyTarget?.sender ?? (!settings.participants ? [...messages].reverse().find(m => m.direction === 'incoming')?.sender || settings.room : undefined);
  if (!sender) return;
  const prompts = settings.personPrompts;
  const exact = prompts && Object.hasOwn(prompts, sender) ? prompts[sender] : undefined;
  const fallback = !settings.participants && prompts && Object.hasOwn(prompts, settings.room) ? prompts[settings.room] : undefined;
  const prompt = exact || fallback;
  return prompt?.trim() ? { sender, prompt } : undefined;
}
