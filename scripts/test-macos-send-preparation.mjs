// Live macOS check: restores the named open window, checks read/focus readiness,
// and restores its original minimized state and previous foreground app.
// Never calls sendAndMinimize, changes input text, or posts keyboard events.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if (process.platform !== 'darwin' || !process.argv[2]) throw new Error('Usage on macOS: node scripts/test-macos-send-preparation.mjs "open room title"');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'reply-note-send-preparation-'));
try {
  const main = path.join(temporary, 'main.swift');
  writeFileSync(main, String.raw`
import Cocoa
import ApplicationServices
func readAX(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
struct CheckError: Error { let message: String }
func require(_ condition: Bool, _ message: String) throws { if !condition { throw CheckError(message: message) } }
func runChecks() throws {
    try require(AXIsProcessTrusted(), "Terminal accessibility permission is required; no actions performed.")
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.kakao.KakaoTalkMac").first else { throw CheckError(message: "KakaoTalk is not running.") }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    let room = CommandLine.arguments[1]
    let windows = (readAX(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter { (readAX($0, kAXTitleAttribute) as? String) == room }
    try require(windows.count == 1, "Expected one matching open window.")
    let window = windows[0]
    guard let originalMinimized = readAX(window, kAXMinimizedAttribute) as? Bool else { throw CheckError(message: "Cannot read minimized state.") }
    let previous = NSWorkspace.shared.frontmostApplication
    defer {
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, originalMinimized ? kCFBooleanTrue : kCFBooleanFalse)
        _ = previous?.activate(options: [])
    }
    for cycle in 1...2 {
        try require(AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue) == .success, "Cannot minimize target.")
        let deadline = Date().addingTimeInterval(2)
        while (readAX(window, kAXMinimizedAttribute) as? Bool) != true && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        try require((readAX(window, kAXMinimizedAttribute) as? Bool) == true, "Minimization did not complete.")
        let restoreStarted = ProcessInfo.processInfo.systemUptime
        let restored = restoreSendWindow(window, app: app, running: running, deadline: Date().addingTimeInterval(3))
        if !restored {
            let focused = readAX(app, kAXFocusedWindowAttribute)
            print("Diagnostic: minimized=\(String(describing: readAX(window, kAXMinimizedAttribute))) frontmostMatch=\(NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier) active=\(running.isActive) focusedWindowMatch=\(focused.map { CFEqual($0, window) } ?? false)")
        }
        try require(restored, "Restoration/focused-window readiness failed.")
        let restoreMS = (ProcessInfo.processInfo.systemUptime - restoreStarted) * 1000
        let readStarted = ProcessInfo.processInfo.systemUptime
        let sendPath = CommandLine.arguments.contains("--send-path")
        var sendContext: SendContext?
        var baseline = SendBaseline([])
        func readResponse(op: String = "read") throws -> [String: Any] {
            let request = try JSONSerialization.data(withJSONObject: ["id": cycle, "op": op, "room": room])
            let response = String(data: request, encoding: .utf8)!.withCString { replyNoteRead($0) }
            guard let response else { throw CheckError(message: "No native read response.") }
            let data = Data(String(cString: response).utf8); free(response)
            return try JSONSerialization.jsonObject(with: data) as! [String: Any]
        }
        if sendPath {
            // A new production request clears its AX cache and starts a fresh deadline.
            _ = try readResponse(op: "list")
            sendContext = inspectSendWindow(window, app: app, room: room)
            try require(sendContext != nil, "Send context is not ready.")
            guard let captured = sendBaseline(sendContext!) else { throw CheckError(message: "Cannot capture existing rows.") }
            baseline = captured
        } else {
            let result = try readResponse()
            try require(result["status"] as? String == "ready", "Restored room is not readable: \(result["status"] ?? "missing")")
        }
        let readMS = (ProcessInfo.processInfo.systemUptime - readStarted) * 1000
        let focusStarted = ProcessInfo.processInfo.systemUptime
        let inputs = sendContext.map { [$0.input] } ?? flatten(window, skipTables: true).filter { role($0) == kAXTextAreaRole && string($0, kAXDescriptionAttribute) == "메시지 입력" }
        try require(inputs.count == 1, "Input is not unique.")
        _ = AXUIElementSetAttributeValue(inputs[0], kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let focusDeadline = Date().addingTimeInterval(1)
        var focused = false
        repeat {
            if let value = readAX(app, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() { focused = CFEqual(value, inputs[0]) }
            if focused { break }; Thread.sleep(forTimeInterval: 0.05)
        } while Date() < focusDeadline
        try require(focused, "Input focus did not settle.")
        let focusMS = (ProcessInfo.processInfo.systemUptime - focusStarted) * 1000
        print(String(format: "Cycle %d: restore=%.0fms nativeRead=%.0fms inputFocus=%.0fms preparationTotal=%.0fms; no text or key events sent.", cycle, restoreMS, readMS, focusMS, restoreMS + readMS + focusMS))
        if let context = sendContext {
            // Read existing history only for assertions, outside the preparation timing.
            let history = try readResponse()["messages"] as? [[String: Any]] ?? []
            if let outgoing = history.last(where: { $0["direction"] as? String == "outgoing" }),
               let id = outgoing["id"] as? String, let text = outgoing["text"] as? String {
                _ = try readResponse(op: "list")
                let verificationStarted = ProcessInfo.processInfo.systemUptime
                try require(!newOutgoingMatches(context, previousRows: baseline, payload: text), "Old identical outgoing falsely matched.")
                let simulatedNew = SendBaseline(baseline.rows.filter { identity($0) != id })
                _ = try readResponse(op: "list")
                try require(newOutgoingMatches(context, previousRows: simulatedNew, payload: text), "Known outgoing row not recognized.")
                _ = try readResponse(op: "list")
                try require(!newOutgoingMatches(context, previousRows: simulatedNew, payload: text + "__mismatch__"), "Different body falsely matched.")
                print(String(format: "Fresh-cache verification assertions total=%.0fms", (ProcessInfo.processInfo.systemUptime - verificationStarted) * 1000))
            } else { throw CheckError(message: "Need an existing outgoing row for non-sending assertions.") }
            if let incoming = history.last(where: { $0["direction"] as? String == "incoming" }),
               let id = incoming["id"] as? String, let text = incoming["text"] as? String {
                let simulatedNew = SendBaseline(baseline.rows.filter { identity($0) != id })
                _ = try readResponse(op: "list")
                try require(!newOutgoingMatches(context, previousRows: simulatedNew, payload: text), "Incoming row falsely recognized as outgoing.")
            }
            print("Verification assertions passed: existing duplicate rejected, outgoing recognized, wrong body/incoming rejected. No messages sent.")
        }
    }
}
// Match the Node-API worker: run AX work off-main while the app event loop updates
// NSWorkspace/NSRunningApplication activation notifications on the main thread.
let cocoaApp = NSApplication.shared
cocoaApp.setActivationPolicy(.prohibited)
DispatchQueue.global().async {
    do { try runChecks() } catch { print("Preparation check failed: \(error)"); exit(1) }
    exit(0)
}
cocoaApp.run()
`);
  // Optional experimental read limit changes only a temporary native source copy.
  // It measures AX traversal cost; it must not change production conversation parsing.
  const probe = process.argv.find(arg => arg.startsWith('--recent-rows='));
  let nativeSource = 'native/macos/ChatReader.swift';
  if (probe) {
    const rows = Number(probe.split('=')[1]);
    if (!Number.isInteger(rows) || rows < 1 || rows > 60) throw new Error('Expected recent rows in 1..60');
    const source = readFileSync(nativeSource, 'utf8');
    if (!source.includes('children(table).suffix(60)')) throw new Error('Native reader changed; review probe first');
    nativeSource = path.join(temporary, 'ChatReader.swift');
    writeFileSync(nativeSource, source.replace('children(table).suffix(60)', `children(table).suffix(${rows})`));
    console.log(`Experimental temporary read probe: ${rows} recent rows (production unchanged).`);
  }
  const binary = path.join(temporary, 'preparation-checks');
  execFileSync('swiftc', ['-O', nativeSource, 'native/macos/MessageParsing.swift', main, '-o', binary, '-framework', 'Cocoa', '-framework', 'ApplicationServices'], { stdio: 'inherit' });
  execFileSync(binary, [process.argv[2], ...(process.argv.includes('--send-path') ? ['--send-path'] : [])], { stdio: 'inherit', timeout: 35_000 });
} finally { rmSync(temporary, { recursive: true, force: true }); }
