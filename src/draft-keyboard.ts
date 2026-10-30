interface DraftKeyEvent {
  key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
  preventDefault(): void;
}
export function handleDraftKeyDown(event: DraftKeyEvent, actions: { canSend: boolean; send(): void; flush(): void }) {
  // Enter may merely commit Korean/Japanese/Chinese text. Chromium on Windows/macOS
  // can expose this as isComposing or the legacy IME keyCode 229.
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); actions.flush(); return;
  }
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (!event.repeat && actions.canSend) actions.send();
}
