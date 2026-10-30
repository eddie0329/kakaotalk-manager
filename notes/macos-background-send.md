# macOS background-send investigation — 2026-10-25

The send-to-contact feature is not implemented in Reply Note 0.4.4. These are manual feasibility checks, not application integration tests.

With the user's explicit authorization, tested one already-open 1:1 KakaoTalk window while it remained minimized. The compose field started empty, and the authorized test text was entered through Accessibility. Only that chat window was exposed by the target process's AX window list. The foreground application was a separate terminal app throughout the background test.

Observed:

- Compose `AXValue` is writable while minimized; writing the text does not restore or activate the chat.
- `CGPreflightPostEventAccess()` returned true. A private-source Return key down/up pair posted only to the KakaoTalk PID with `CGEvent.postToPid` did not clear the input or append a row.
- Setting the compose field's `AXFocused` attribute returned without error but the field remained unfocused while minimized. The process exposed no AX focused/main window in this state.
- The footer button exposes `AXPress` and becomes enabled when the input has text. Calling `AXPress` while minimized did not clear the input or append a row.
- The window remained minimized and the foreground app did not change. At the end the exact, still-unsent test text was removed, returning the compose field to empty. No background message send was observed.

An earlier, separately authorized foreground test cleared the input and increased the row count after an actual Return key event with the exact target window and field focused. AXPress did not provide that effect, even when focused. That earlier exact-text System Events check was inconclusive because its recursive script did not traverse rows correctly; it is not evidence that native AX row contents are unavailable.

Conclusions are limited to these routes and this environment. A PID-targeting API does not establish that a minimized window can receive a key, nor that the correct chat can be selected without focus. Hidden-app mode and minimized-window mode are different and have not been established as equivalent. Do not claim minimized/background contact sending is supported, blindly retry an uncertain send, use process-wide global Return input, or expose a functional send button based solely on these checks. Any further live-message experiment needs its own explicit recipient/content authorization.


Later foreground/native validation (0.4.5): a separately authorized single message was passed through MacReader.send/sendAndMinimize in the signed application process. The native sender confirmed a new outgoing message matching the approved full body and an empty composer. An independent System Events read confirmed AXMinimized=true. The original sender checked AXMinimized too soon and returned minimized=false before the asynchronous Dock animation completed. Version 0.4.6 waits up to 1.2 seconds for this flag. No extra live message was sent for that timing-only correction. This validates restore/send/minimize behavior, not continuous-minimization background sending; the persisted ContactSender/UI transaction is covered by automatic tests rather than by that direct native test invocation.
