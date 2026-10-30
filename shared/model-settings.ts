import type { CodexModel, Settings } from './types';

export function findModel(value: string, models: CodexModel[]): CodexModel | undefined {
  if (!value.trim()) return undefined;
  const exact = models.find(model => model.id === value.trim());
  if (exact) return exact;
  const normalized = value.trim().toLowerCase();
  const matches = models.filter(model => model.id.toLowerCase() === normalized || model.name.toLowerCase() === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}
export function effectiveModelSettings(settings: Settings, models: CodexModel[]): Settings {
  const model = findModel(settings.model, models) ?? (!settings.model.trim() ? models.find(model => model.isDefault) : undefined);
  const effort = settings.effort?.trim() || model?.defaultEffort || '';
  if (settings.effort && model?.efforts && !model.efforts.some(option => option.id === settings.effort)) {
    throw new Error(`${model.name}에서 지원하지 않는 effort입니다. 연결 설정에서 지원되는 수준을 다시 선택해주세요.`);
  }
  return { ...settings, model: model?.id || settings.model.trim(), effort };
}
export function effortLabel(id: string): string {
  const labels: Record<string, string> = { none: '추론 없음', minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', ultra: 'Ultra' };
  return labels[id] ? `${labels[id]} (${id})` : id;
}
