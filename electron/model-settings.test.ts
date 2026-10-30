import { describe, expect, it } from 'vitest';
import { effectiveModelSettings, findModel } from '../shared/model-settings';
import type { CodexModel, Settings } from '../shared/types';
const model: CodexModel = { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: '', isDefault: true, defaultEffort: 'medium', efforts: [{ id: 'low', description: '' }, { id: 'medium', description: '' }, { id: 'high', description: '' }] };
const settings: Settings = { room: '', prompt: '', codexPath: '', model: 'GPT-6.1-Sol', delivery: 'app' };
describe('model ID and effort compatibility', () => {
  it('maps an exact catalog display name or casing variant to its execution ID', () => {
    expect(findModel('GPT-6.1-Sol', [model])?.id).toBe('gpt-6.1-sol');
    expect(effectiveModelSettings(settings, [model])).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
  });
  it('preserves explicit effort and rejects levels the model did not advertise', () => {
    expect(effectiveModelSettings({ ...settings, effort: 'high' }, [model]).effort).toBe('high');
    expect(() => effectiveModelSettings({ ...settings, effort: 'ultra' }, [model])).toThrow('지원하지');
  });
  it('does not substitute a different model for unknown IDs or ambiguous display names', () => {
    expect(effectiveModelSettings({ ...settings, model: 'my-custom-model' }, [model]).model).toBe('my-custom-model');
    expect(findModel('Shared name', [{ ...model, name: 'Shared name' }, { ...model, id: 'other', name: 'Shared name' }])).toBeUndefined();
  });
});
