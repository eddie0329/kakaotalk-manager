import Cocoa
import ApplicationServices

// Only original-saving actions are used here. No chat input, clipboard, upload, or send action.
func exportChatAttachment(_ request: Request) -> Response {
    let room = request.room ?? ""
    func result(_ detail: String, _ file: String? = nil) -> Response {
        var reply = Response(id: request.id, status: file == nil ? "error" : "ready", room: room, messages: [], detail: detail, capturedAt: Date().timeIntervalSince1970 * 1000, rooms: [], chatKind: nil)
        reply.exportedName = file; return reply
    }
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { return result("손쉬운 사용 권한을 허용한 뒤 다시 시도해주세요.") }
    guard let expected = request.expectedMessage, let rowId = request.rowId, expected.id == rowId,
          let attachmentId = request.attachmentId, let media = expected.attachments?.first(where: { $0.id == attachmentId }),
          expected.attachments?.count == 1, (media.count ?? 1) == 1, ["image", "file"].contains(media.kind),
          let destination = request.destination, destination.hasPrefix("/"),
          URL(fileURLWithPath: destination).lastPathComponent.hasPrefix("capture-") else { return result("가져올 메시지·첨부 또는 작업 폴더를 확인하지 못했습니다.") }
    let folder = URL(fileURLWithPath: destination, isDirectory: true)
    guard let initialFiles = try? FileManager.default.contentsOfDirectory(atPath: destination), initialFiles.isEmpty else { return result("빈 작업 폴더에서만 원본을 가져올 수 있습니다.") }
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.kakao.KakaoTalkMac").first else { return result("카카오톡을 실행해주세요.") }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    let deadline = Date().addingTimeInterval(35)
    let previousApp = NSWorkspace.shared.frontmostApplication
    var ownedPanel: AXUIElement?
    var createdViewer: AXUIElement?
    var touchedWindow: AXUIElement?
    var wasMinimized = false
    let wasHidden = running.isHidden
    func fresh() { clearAttributeCache() }
    func windows() -> [AXUIElement] { fresh(); return attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] }
    func active() -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier }
    func nested(_ window: AXUIElement) -> [AXUIElement] {
        let sheets = attribute(window, "AXSheets") as? [AXUIElement] ?? []
        return flatten(window, skipTables: true) + sheets.flatMap { flatten($0, skipTables: true) }
    }
    func element(_ identifier: String) -> AXUIElement? {
        for window in windows() { if let node = nested(window).first(where: { string($0, kAXIdentifierAttribute) == identifier }) { return node } }
        return nil
    }
    func waitFor(_ check: () -> Bool) -> Bool {
        while Date() < deadline { fresh(); if !active() { return false }; if check() { return true }; Thread.sleep(forTimeInterval: 0.08) }
        return false
    }
    func press(_ node: AXUIElement) -> Bool {
        guard active() else { return false }
        return AXUIElementPerformAction(node, kAXPressAction as CFString) == .success
    }
    func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) -> Bool {
        guard active(), let source = CGEventSource(stateID: .privateState), let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
        down.flags = flags; up.flags = flags; down.postToPid(running.processIdentifier); up.postToPid(running.processIdentifier); return true
    }
    func focused(_ node: AXUIElement, window: Bool = false) -> Bool {
        fresh()
        guard let value = attribute(app, window ? kAXFocusedWindowAttribute : kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
        return CFEqual(value, node)
    }
    func same(_ message: Message, _ expected: Message) -> Bool {
        guard message.id == expected.id, message.text == expected.text, message.sender == expected.sender, message.direction == expected.direction else { return false }
        let a = message.attachments ?? [], b = expected.attachments ?? []
        return a.count == b.count && zip(a, b).allSatisfy { $0.id == $1.id && $0.kind == $1.kind && ($0.name ?? "") == ($1.name ?? "") && ($0.count ?? 1) == ($1.count ?? 1) }
    }
    // Never take over a user-owned save dialog or an existing photo viewer.
    let beforeWindows = windows()
    guard !beforeWindows.contains(where: { role($0) == kAXSheetRole || string($0, kAXIdentifierAttribute) == "save-panel" || !((attribute($0, "AXSheets") as? [AXUIElement]) ?? []).isEmpty }) else { return result("카톡에 열려 있는 대화상자를 닫고 다시 시도해주세요.") }
    let matches = beforeWindows.filter { string($0, kAXTitleAttribute) == room }
    guard matches.count == 1 else { return result("대상 방을 고유한 제목의 별도 창으로 열어주세요.") }
    let window = matches[0]
    defer {
        fresh()
        if let ownedPanel, let cancel = flatten(ownedPanel).first(where: { string($0, kAXIdentifierAttribute) == "CancelButton" }), active() { _ = press(cancel) }
        if let createdViewer, active(), let close = attribute(createdViewer, kAXCloseButtonAttribute), CFGetTypeID(close) == AXUIElementGetTypeID() { _ = press(unsafeBitCast(close, to: AXUIElement.self)) }
        if let touchedWindow, wasMinimized { _ = AXUIElementSetAttributeValue(touchedWindow, kAXMinimizedAttribute as CFString, kCFBooleanTrue) }
        if active() { if wasHidden { running.hide() }; if let previousApp, previousApp.processIdentifier != running.processIdentifier { _ = previousApp.activate(options: []) } }
    }
    wasMinimized = (attribute(window, kAXMinimizedAttribute) as? Bool) == true
    touchedWindow = window
    guard restoreSendWindow(window, app: app, running: running, deadline: Date().addingTimeInterval(4)) else { return result("대상 채팅방을 활성화하지 못했습니다.") }
    fresh()
    let capture = respond(Request(id: request.id, op: "read", room: room))
    guard capture.status == "ready", let current = capture.messages.first(where: { $0.id == rowId }), same(current, expected),
          let table = flatten(window, skipTables: true).first(where: { role($0) == kAXTableRole }),
          let row = children(table).suffix(60).first(where: { role($0) == kAXRowRole && identity($0) == rowId }) else { return result("대화가 바뀌었거나 첨부가 최근 수집 범위를 벗어났습니다. 다시 감지해주세요.") }
    let nodes = flatten(row)
    if media.kind == "file" {
        let saveButtons = nodes.filter { role($0) == kAXButtonRole && [string($0, kAXTitleAttribute), string($0, kAXDescriptionAttribute)].contains("다른 이름으로 저장") }
        guard saveButtons.count == 1, press(saveButtons[0]) else { return result("이 파일 메시지의 ‘다른 이름으로 저장’을 확인하지 못했습니다.") }
    } else {
        guard !beforeWindows.contains(where: { string($0, kAXTitleAttribute).hasPrefix(room + ", ") }) else { return result("기존 사진 뷰어를 닫고 다시 시도해주세요.") }
        let images = nodes.filter { role($0) == kAXImageRole }
        guard images.count == 1, let bounds = frame(images[0]), let tableBounds = frame(table), let windowBounds = frame(window), bounds.width > 0, bounds.height > 0 else { return result("사진 위치를 고유하게 확인하지 못했습니다.") }
        let point = CGPoint(x: bounds.midX, y: bounds.midY)
        guard tableBounds.contains(point), windowBounds.contains(point), active(), let eventSource = CGEventSource(stateID: .privateState) else { return result("사진이 화면에 보이지 않습니다. 해당 메시지를 보이게 한 뒤 다시 시도해주세요.") }
        for click in 1...2 {
            guard active(), let down = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), let up = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { return result("사진을 열지 못했습니다.") }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(click)); up.setIntegerValueField(.mouseEventClickState, value: Int64(click)); down.postToPid(running.processIdentifier); up.postToPid(running.processIdentifier)
        }
        guard waitFor({
            let viewers = windows().filter { candidate in !beforeWindows.contains(where: { CFEqual($0, candidate) }) && string(candidate, kAXTitleAttribute).hasPrefix(room + ", ") }
            if viewers.count == 1 { createdViewer = viewers[0]; return true }; return false
        }), let viewer = createdViewer else { return result("선택한 메시지의 사진 뷰어를 확인하지 못했습니다.") }
        fresh()
        guard string(viewer, kAXTitleAttribute).hasPrefix(room + ", "), focused(viewer, window: true), key(1, .maskCommand) else { return result("사진 저장을 시작하지 못했습니다.") }
    }
    guard waitFor({ element("save-panel") != nil }), let panel = element("save-panel"), let nameField = element("saveAsNameTextField") else { return result("저장 대화상자가 열리지 않았습니다. 만료되었거나 저장할 수 없는 첨부일 수 있습니다.") }
    ownedPanel = panel
    let proposed = string(nameField, kAXValueAttribute).precomposedStringWithCanonicalMapping
    if media.kind == "file" {
        guard let expectedName = media.name?.precomposedStringWithCanonicalMapping,
              proposed == expectedName || proposed == (expectedName as NSString).deletingPathExtension else { return result("저장 대화상자의 파일 이름이 선택한 메시지와 다릅니다.") }
    } else if !proposed.hasPrefix("KakaoTalk_Photo_") { return result("사진 저장 파일 이름을 확인하지 못했습니다.") }
    _ = AXUIElementSetAttributeValue(nameField, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard focused(nameField), key(5, [.maskCommand, .maskShift]), waitFor({ element("PathTextField") != nil }), let pathField = element("PathTextField") else { return result("격리 저장 폴더를 지정하지 못했습니다.") }
    guard AXUIElementSetAttributeValue(pathField, kAXValueAttribute as CFString, destination as CFString) == .success else { return result("저장 폴더를 입력하지 못했습니다.") }
    _ = AXUIElementSetAttributeValue(pathField, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    fresh()
    guard string(pathField, kAXValueAttribute) == destination, focused(pathField), key(36), waitFor({ element("PathTextField") == nil && element("save-panel") != nil }) else { return result("저장 폴더 이동을 확인하지 못했습니다.") }
    fresh()
    guard let wherePopup = element("where popup"), string(wherePopup, kAXValueAttribute) == folder.lastPathComponent,
          let currentName = element("saveAsNameTextField"), string(currentName, kAXValueAttribute).precomposedStringWithCanonicalMapping == proposed, let save = element("OKButton"), press(save) else { return result("저장 위치를 검증하지 못했습니다. 파일을 저장하지 않았습니다.") }
    // Only accept exactly one file in this previously empty operation directory.
    var saved: String?
    var previousSize: UInt64 = 0
    guard waitFor({
        guard element("save-panel") == nil, let files = try? FileManager.default.contentsOfDirectory(atPath: destination), files.count == 1,
              let name = files.first, !name.hasPrefix("."),
              let attrs = try? FileManager.default.attributesOfItem(atPath: folder.appendingPathComponent(name).path), attrs[.type] as? FileAttributeType == .typeRegular,
              let size = attrs[.size] as? UInt64, size > 0 else { return false }
        if size == previousSize { saved = name; return true }; previousSize = size; return false
    }), let saved else { return result("저장된 원본을 작업 폴더에서 확인하지 못했습니다.") }
    ownedPanel = nil
    return result("선택한 첨부를 격리된 작업 폴더에 저장했습니다.", saved)
}
