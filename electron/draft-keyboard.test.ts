import { describe, expect, it, vi } from 'vitest';
import { handleDraftKeyDown } from '../src/draft-keyboard';
function fixture(overrides = {}) {
  const event = { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, nativeEvent: {}, preventDefault: vi.fn(), ...overrides };
  const actions = { canSend: true, send: vi.fn(), flush: vi.fn() };
  return { event, actions };
}
describe('draft keyboard sending', () => {
  it('sends on plain Enter and suppresses its newline', () => {
    const f = fixture(); handleDraftKeyDown(f.event, f.actions); expect(f.actions.send).toHaveBeenCalledOnce(); expect(f.event.preventDefault).toHaveBeenCalledOnce();
  });
  it('leaves Shift+Enter to the editor for a native newline', () => {
    const f = fixture({ shiftKey: true }); handleDraftKeyDown(f.event, f.actions); expect(f.actions.send).not.toHaveBeenCalled(); expect(f.event.preventDefault).not.toHaveBeenCalled();
  });
  it('never sends while committing IME text, including keyCode 229 fallback', () => {
    for (const nativeEvent of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
      const f = fixture({ nativeEvent }); handleDraftKeyDown(f.event, f.actions); expect(f.actions.send).not.toHaveBeenCalled(); expect(f.event.preventDefault).not.toHaveBeenCalled();
    }
  });
  it('does not send with a disabled button or a held Enter key', () => {
    const blocked = fixture(); blocked.actions.canSend = false; handleDraftKeyDown(blocked.event, blocked.actions);
    const repeated = fixture({ repeat: true }); handleDraftKeyDown(repeated.event, repeated.actions);
    expect(blocked.actions.send).not.toHaveBeenCalled(); expect(repeated.actions.send).not.toHaveBeenCalled();
    expect(blocked.event.preventDefault).toHaveBeenCalled(); expect(repeated.event.preventDefault).toHaveBeenCalled();
  });
  it('preserves explicit save shortcuts and leaves other modifiers alone', () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const f = fixture({ key: 's', ...modifier }); handleDraftKeyDown(f.event, f.actions); expect(f.actions.flush).toHaveBeenCalledOnce(); expect(f.actions.send).not.toHaveBeenCalled();
    }
    const f = fixture({ altKey: true }); handleDraftKeyDown(f.event, f.actions); expect(f.actions.send).not.toHaveBeenCalled(); expect(f.event.preventDefault).not.toHaveBeenCalled();
  });
});
