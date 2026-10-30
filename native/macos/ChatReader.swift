import Cocoa
import ApplicationServices

private var requestDeadline = Date.distantFuture
private final class AttributeCache {
    let element: AXUIElement
    var values: [String: CFTypeRef] = [:]
    var missing: Set<String> = []
    init(_ element: AXUIElement) { self.element = element }
}
private var attributeCache: [CFHashCode: [AttributeCache]] = [:]
func clearAttributeCache() { attributeCache.removeAll(keepingCapacity: true) }

// Read-only accessibility helper. No AX actions, keyboard, mouse, pasteboard, or app activation.
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    guard Date() < requestDeadline else { return nil }
    let key = CFHash(element)
    let cached: AttributeCache
    if let found = attributeCache[key]?.first(where: { CFEqual($0.element, element) }) { cached = found }
    else {
        cached = AttributeCache(element)
        attributeCache[key, default: []].append(cached)
        AXUIElementSetMessagingTimeout(element, 0.3)
    }
    if let value = cached.values[name] { return value }
    if cached.missing.contains(name) { return nil }
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success, let result else { cached.missing.insert(name); return nil }
    cached.values[name] = result
    return result
}
func string(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func role(_ element: AXUIElement) -> String { string(element, kAXRoleAttribute) }
func frame(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, kAXPositionAttribute), let s = attribute(element, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func flatten(_ root: AXUIElement, depth: Int = 0, skipTables: Bool = false) -> [AXUIElement] {
    guard depth < 12 && Date() < requestDeadline else { return [] }
    let kind = role(root)
    if skipTables && kind == kAXTableRole { return [root] }
    if [kAXImageRole, kAXStaticTextRole, kAXTextAreaRole, kAXTextFieldRole, kAXButtonRole].contains(kind) { return [root] }
    return [root] + children(root).flatMap { flatten($0, depth: depth + 1, skipTables: skipTables) }
}
func label(_ element: AXUIElement) -> String {
    [string(element, kAXTitleAttribute), string(element, kAXDescriptionAttribute), string(element, kAXValueAttribute)].filter { !$0.isEmpty }.joined(separator: " ")
}
struct Request: Decodable { let id: Int; let op: String; let room: String?; var text: String? = nil; var rowId: String? = nil; var attachmentId: String? = nil; var destination: String? = nil; var expectedMessage: Message? = nil }
struct Message: Codable { let id: String; let text: String; let direction: String; let sender: String; let time: String; var attachments: [MessageAttachment]? = nil }
struct Response: Encodable {
    let id: Int; let status: String; let room: String; let messages: [Message]; let detail: String?; let capturedAt: Double; let rooms: [String]; let chatKind: String?; var sendOutcome: String? = nil; var minimized: Bool? = nil; var exportedName: String? = nil
}
func isSelfChat(_ room: String, _ windows: [AXUIElement]) -> Bool {
    guard let main = windows.first(where: { string($0, kAXIdentifierAttribute) == "Main Window" || string($0, kAXTitleAttribute) == "카카오톡" }) else { return false }
    let tables = flatten(main, skipTables: true).filter { role($0) == kAXTableRole }
    for table in tables {
        for row in children(table).prefix(30) where role(row) == kAXRowRole {
            // Only names and image descriptions in the main list; never reads preview text areas.
            let metadata = flatten(row).filter { role($0) != kAXTextAreaRole }
            let ownBadge = metadata.contains { role($0) == kAXImageRole && label($0).contains("badge me") }
            if ownBadge && metadata.contains(where: { label($0) == room || label($0).hasPrefix(room + " ") }) { return true }
        }
    }
    return false
}
var identities: [(AXUIElement, String)] = []
var nextIdentity = 0
func identity(_ element: AXUIElement) -> String {
    if let existing = identities.first(where: { CFEqual($0.0, element) }) { return existing.1 }
    nextIdentity += 1
    let result = "row-\(nextIdentity)"
    identities.append((element, result))
    if identities.count > 2000 { identities.removeFirst(500) }
    return result
}
func respond(_ request: Request) -> Response {
    let room = request.room ?? ""
    func reply(_ status: String, _ detail: String? = nil, _ messages: [Message] = [], _ rooms: [String] = [], _ chatKind: String? = nil) -> Response {
        Response(id: request.id, status: status, room: room, messages: messages, detail: detail, capturedAt: Date().timeIntervalSince1970 * 1000, rooms: rooms, chatKind: chatKind)
    }
    guard AXIsProcessTrusted() else { return reply("permission_required", "시스템 설정의 손쉬운 사용에서 Reply Note의 접근을 허용해주세요.") }
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.kakao.KakaoTalkMac").first else {
        return reply("not_running", "카카오톡을 실행하고 로그인해주세요.")
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 2)
    guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else {
        return reply("error", "카카오톡 창 정보를 읽지 못했습니다. 카카오톡의 로그인 상태를 확인해주세요.")
    }
    // Listing returns only open window titles; never reads every conversation's contents.
    let names = windows.map { string($0, kAXTitleAttribute) }.filter { !$0.isEmpty && $0 != "카카오톡" && $0 != "로그인" }
    if request.op == "list" { return reply("ready", nil, [], names) }
    let matches = windows.filter { string($0, kAXTitleAttribute) == room }
    guard !matches.isEmpty else { return reply("room_closed", "카카오톡에서 ‘\(room)’ 채팅방을 직접 열어주세요. 연결되면 숨겨도 됩니다.", [], names) }
    guard matches.count == 1 else { return reply("ambiguous_room", "동일한 이름의 창이 여러 개입니다. 대상 채팅방 이름을 고유하게 바꿔주세요.", [], names) }
    // Inspect window controls without walking every historical message first.
    let elements = flatten(matches[0], skipTables: true)
    guard elements.contains(where: { role($0) == kAXTextAreaRole && (label($0).contains("메시지 입력") || string($0, kAXPlaceholderValueAttribute).contains("메시지 입력")) }) else {
        return reply("error", "메시지 입력 영역을 확인하지 못했습니다. 채팅방이 잠겨 있거나 카카오톡 구조가 변경됐을 수 있습니다.")
    }
    let controls = elements.filter { role($0) == kAXButtonRole }.map { label($0) }
    let participants = controls.first { $0.contains("대화상대") }
    // Own-chat has a drawer but no participant/call controls. Inspect that window directly;
    // the main app can be on Friends, filtered, scrolled, or hidden independently.
    // This fallback only grants reception-only mode; it never enables automatic generation.
    let ownChatControls = controls.contains { $0.contains("채팅방 서랍") } && !controls.contains { $0.contains("보이스톡") || $0.contains("페이스톡") }
    let selfChat = participants == nil && (ownChatControls || isSelfChat(room, windows))
    let count = chatParticipantCount(participants)
    guard selfChat || (count ?? 0) >= 2 else {
        return reply("unsupported_room", "일반 채팅방의 참여자 수를 확인하지 못했습니다. 채팅방을 별도 창으로 열어주세요.", [], names)
    }
    let groupChat = (count ?? 0) > 2
    guard let table = elements.first(where: { role($0) == kAXTableRole }), let tableFrame = frame(table), tableFrame.width > 0 else {
        return reply("error", "대화 목록 위치를 읽지 못했습니다. 채팅방을 최소화하지 말고 카카오톡 앱을 숨겨주세요.")
    }
    var result: [Message] = []
    var previousSender = ""
    // Walk a bounded chronological slice so name-less continuation bubbles can inherit
    // only the immediately preceding incoming sender. Never use the room title as a group sender.
    for row in children(table).suffix(60) where role(row) == kAXRowRole {
        let nodes = flatten(row)
        var currentTime = ""
        for node in nodes where role(node) == kAXStaticTextRole {
            let help = string(node, kAXHelpAttribute)
            let value = string(node, kAXValueAttribute)
            if !help.isEmpty && (value.contains("오전") || value.contains("오후")) { currentTime = "\(help) \(value)" }
        }
        let fields = nodes.filter { role($0) == kAXTextAreaRole }
        let text = fields.map { string($0, kAXValueAttribute) }.filter { !$0.isEmpty && $0 != "메시지 입력" }.joined(separator: "\n")
        let staticLabels = nodes.filter { role($0) == kAXStaticTextRole }.map { string($0, kAXValueAttribute) }
        let imageNodes = nodes.filter { role($0) == kAXImageRole && label($0).range(of: "프로필|profile|avatar|badge me", options: [.regularExpression, .caseInsensitive]) == nil }
        let contentControls = nodes.filter { role($0) == kAXButtonRole && !label($0).contains("프로필") }
        if text.isEmpty && imageNodes.isEmpty && contentControls.isEmpty && chatIsSeparator(staticLabels) { previousSender = ""; continue }
        if text.isEmpty && imageNodes.isEmpty && staticLabels.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) && contentControls.allSatisfy({ label($0).isEmpty }) { previousSender = ""; continue }
        let attachments = chatMedia(images: imageNodes.map { label($0) }, controls: contentControls.map { label($0) }, labels: staticLabels, hasText: !text.isEmpty)
        let fileNodes = nodes.filter { chatFileName(label($0)) != nil || (role($0) == kAXButtonRole && label($0).range(of: "파일.*(?:다운로드|열기)|download|attachment", options: [.regularExpression, .caseInsensitive]) != nil) }
        let anchor = fields.first ?? imageNodes.first ?? fileNodes.first
        let profiles = nodes.filter { role($0) == kAXButtonRole && label($0).contains("프로필") }
        let hasProfile = !selfChat && !profiles.isEmpty
        var direction = "unknown"
        if selfChat { direction = "outgoing" }
        else if hasProfile { direction = "incoming" }
        else if let field = anchor, let f = frame(field), f.width > 0 {
            let trailing = tableFrame.maxX - f.maxX
            let leading = f.minX - tableFrame.minX
            if trailing >= -5 && trailing <= 48 { direction = "outgoing" }
            else if leading >= 25 && leading <= 85 && trailing > 55 { direction = "incoming" }
        }
        var sender = direction == "outgoing" ? "나" : ""
        if direction == "incoming" {
            // A sender label precedes the body, separate from time/unread metadata.
            let bodyIndex = anchor.flatMap { field in nodes.firstIndex(where: { CFEqual($0, field) }) } ?? nodes.count
            let labels = nodes.prefix(bodyIndex).filter { role($0) == kAXStaticTextRole }.map { string($0, kAXValueAttribute) }.filter { chatFileName($0) == nil && $0.range(of: #"^\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB)$"#, options: [.regularExpression, .caseInsensitive]) == nil }
            sender = chatSenderName(labels: labels, hasProfile: hasProfile, previous: previousSender, directRoom: groupChat ? nil : room)
        }
        previousSender = direction == "incoming" ? sender : ""
        result.append(Message(id: identity(row), text: text, direction: direction, sender: sender, time: currentTime, attachments: attachments.isEmpty ? nil : attachments))
    }
    var lastTime = ""
    let chronological = result.suffix(20).map { m -> Message in
        if !m.time.isEmpty { lastTime = m.time }
        return Message(id: m.id, text: m.text, direction: m.direction, sender: m.sender, time: lastTime, attachments: m.attachments)
    }
    return reply("ready", nil, chronological, names, selfChat ? "self" : groupChat ? "group" : "direct")
}
private let readLock = NSLock()

// Restoration and focus changes are asynchronous, especially during the Dock animation.
// Read these attributes without the snapshot cache; an accepted AX request is not completion.
func restoreSendWindow(_ window: AXUIElement, app: AXUIElement, running: NSRunningApplication, deadline: Date) -> Bool {
    func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
    AXUIElementSetMessagingTimeout(window, 0.3)
    AXUIElementSetMessagingTimeout(app, 0.3)
    guard AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success else { return false }
    _ = running.unhide()
    _ = running.activate(options: [])
    var raisedAfterRestore = false
    var readySince: Date?
    while Date() < deadline {
        let restored = (read(window, kAXMinimizedAttribute) as? Bool) == false
        let active = NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier
        if restored && active && !raisedAfterRestore {
            // Raising a still-minimized window can be ignored. Raise only after restoration.
            _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            raisedAfterRestore = true
        }
        let focused = read(app, kAXFocusedWindowAttribute)
        if restored && active && raisedAfterRestore, let focused,
           CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window) {
            if let readySince, Date().timeIntervalSince(readySince) >= 0.15 { return true }
            if readySince == nil { readySince = Date() }
        } else { readySince = nil }
        Thread.sleep(forTimeInterval: 0.05)
    }
    return false
}

// Manual sending needs controls, row identities and the new outgoing bubble only.
// Normal receiving retains its full chronological/sender parsing above.
struct SendContext {
    let window: AXUIElement
    let input: AXUIElement
    let table: AXUIElement
    let selfChat: Bool
}
func inspectSendWindow(_ window: AXUIElement, app: AXUIElement, room: String) -> SendContext? {
    guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
    let matches = windows.filter { string($0, kAXTitleAttribute) == room }
    guard matches.count == 1, CFEqual(matches[0], window) else { return nil }
    let nodes = flatten(window, skipTables: true)
    let inputs = nodes.filter { role($0) == kAXTextAreaRole && string($0, kAXDescriptionAttribute) == "메시지 입력" }
    guard inputs.count == 1 else { return nil }
    let controls = nodes.filter { role($0) == kAXButtonRole }.map { label($0) }
    let participants = controls.first { $0.contains("대화상대") }
    let ownControls = controls.contains { $0.contains("채팅방 서랍") } && !controls.contains { $0.contains("보이스톡") || $0.contains("페이스톡") }
    let selfChat = participants == nil && (ownControls || isSelfChat(room, windows))
    guard selfChat || chatParticipantCount(participants) == 2,
          let table = nodes.first(where: { role($0) == kAXTableRole }),
          let bounds = frame(table), bounds.width > 0 else { return nil }
    return SendContext(window: window, input: inputs[0], table: table, selfChat: selfChat)
}
struct SendBaseline {
    let rows: [AXUIElement]
    private let buckets: [CFHashCode: [AXUIElement]]
    init(_ rows: [AXUIElement]) {
        self.rows = rows
        self.buckets = Dictionary(grouping: rows, by: { CFHash($0) })
    }
    func contains(_ row: AXUIElement) -> Bool { buckets[CFHash(row)]?.contains(where: { CFEqual($0, row) }) ?? false }
}
func sendBaseline(_ context: SendContext) -> SendBaseline? {
    // Retain AX references directly: no per-row AX calls and no eviction from the
    // normal reader's bounded ID cache can turn an old duplicate into a new row.
    guard let rows = attribute(context.table, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
    return SendBaseline(rows)
}
func newOutgoingMatches(_ context: SendContext, previousRows: SendBaseline, payload: String) -> Bool {
    guard let bounds = frame(context.table), bounds.width > 0 else { return false }
    func normalized(_ value: String) -> String { value.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .newlines) }
    // Newest first, expanding over all new rows if needed. Old rows never have their
    // text/metadata parsed, so an old identical reply cannot confirm a new send.
    for row in children(context.table).reversed() where !previousRows.contains(row) && role(row) == kAXRowRole {
        let nodes = flatten(row)
        let fields = nodes.filter { role($0) == kAXTextAreaRole }
        let text = fields.map { string($0, kAXValueAttribute) }.filter { !$0.isEmpty && $0 != "메시지 입력" }.joined(separator: "\n")
        guard normalized(text) == normalized(payload) else { continue }
        if context.selfChat { return true }
        guard !nodes.contains(where: { role($0) == kAXButtonRole && label($0).contains("프로필") }),
              let first = fields.first, let bubble = frame(first), bubble.width > 0 else { continue }
        let trailing = bounds.maxX - bubble.maxX
        if trailing >= -5 && trailing <= 48 { return true }
    }
    return false
}

// Explicit manual send only. Polling/read requests never call this path or post input events.
func sendAndMinimize(_ request: Request) -> Response {
    let room = request.room ?? ""
    var outcome = "failed"
    var detail = "전송하지 못했습니다."
    var minimized = false
    var posted = false
    var touchedInput = false
    var touchedWindow = false
    var targetWindow: AXUIElement?
    var targetInput: AXUIElement?
    var previousApp: NSRunningApplication?
    let payload = (request.text ?? "").replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    func response() -> Response {
        var result = Response(id: request.id, status: outcome == "sent" ? "ready" : "error", room: room, messages: [], detail: detail, capturedAt: Date().timeIntervalSince1970 * 1000, rooms: [], chatKind: nil)
        result.sendOutcome = outcome; result.minimized = minimized; return result
    }
    guard !payload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, payload.utf16.count <= 20_000, !payload.contains("\0") else {
        detail = "보낼 내용을 20,000자 이내로 입력해주세요."; return response()
    }
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
        detail = "손쉬운 사용 권한을 허용한 뒤 다시 시도해주세요."; return response()
    }
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.kakao.KakaoTalkMac").first else {
        detail = "카카오톡을 실행하고 대상 채팅방을 열어주세요."; return response()
    }
    previousApp = NSWorkspace.shared.frontmostApplication
    let app = AXUIElementCreateApplication(running.processIdentifier)
    func fresh() { attributeCache.removeAll(keepingCapacity: true) }
    func sameElement(_ value: CFTypeRef?, _ expected: AXUIElement) -> Bool {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
        return CFEqual(value, expected)
    }
    func operation() {
        fresh()
        guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { detail = "카카오톡 창 목록을 확인하지 못했습니다."; return }
        let matches = windows.filter { string($0, kAXTitleAttribute) == room }
        guard matches.count == 1 else { detail = "대상 채팅방을 고유한 제목의 별도 창으로 열어주세요."; return }
        let window = matches[0]; targetWindow = window
        // The manual send button authorizes brief restoration, then minimization.
        touchedWindow = true
        guard restoreSendWindow(window, app: app, running: running, deadline: min(requestDeadline.addingTimeInterval(-3), Date().addingTimeInterval(3))) else {
            detail = "최소화된 채팅방 복원과 활성화를 확인하지 못해 전송하지 않았습니다."; return
        }
        fresh()
        var context = inspectSendWindow(window, app: app, room: room)
        let layoutDeadline = min(requestDeadline.addingTimeInterval(-3), Date().addingTimeInterval(1))
        while context == nil && Date() < layoutDeadline {
            Thread.sleep(forTimeInterval: 0.08); fresh()
            context = inspectSendWindow(window, app: app, room: room)
        }
        guard let context else { detail = "일반 1:1 채팅방의 입력란과 대화 목록을 확인하지 못해 전송하지 않았습니다."; return }
        let input = context.input; targetInput = input
        // Baseline every existing row without reading historical message bodies.
        guard let previousRows = sendBaseline(context) else { detail = "전송 전 대화 목록을 확인하지 못해 중단했습니다."; return }
        guard let existing = attribute(input, kAXValueAttribute) as? String, existing.isEmpty else {
            detail = "카톡 입력란에 작성 중인 내용이 있어 전송하지 않았습니다. 기존 내용을 먼저 정리해주세요."; return
        }
        var writable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(input, kAXValueAttribute as CFString, &writable) == .success, writable.boolValue else {
            detail = "카카오톡 입력란을 수정할 수 없습니다."; return
        }
        // Construct both events before touching text, and never post a global Return event.
        guard let source = CGEventSource(stateID: .privateState), let down = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false) else {
            detail = "전송 키를 준비하지 못했습니다."; return
        }
        _ = AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let focusDeadline = min(requestDeadline.addingTimeInterval(-2), Date().addingTimeInterval(1))
        var inputReady = false
        repeat {
            fresh()
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier else { break }
            inputReady = sameElement(attribute(app, kAXFocusedWindowAttribute), window)
                && sameElement(attribute(app, kAXFocusedUIElementAttribute), input)
                && (attribute(input, kAXFocusedAttribute) as? Bool) == true
            if inputReady { break }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < focusDeadline
        guard inputReady else {
            detail = "대상 채팅방과 입력 포커스를 확인하지 못해 전송하지 않았습니다."; return
        }
        guard AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, payload as CFString) == .success else {
            detail = "초안을 입력하지 못했습니다."; return
        }
        touchedInput = true; fresh()
        guard string(input, kAXValueAttribute) == payload,
              string(window, kAXTitleAttribute) == room,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier,
              sameElement(attribute(app, kAXFocusedWindowAttribute), window),
              sameElement(attribute(app, kAXFocusedUIElementAttribute), input),
              Date().addingTimeInterval(2) < requestDeadline else {
            detail = "전송 전 대상이나 입력 내용이 바뀌어 중단했습니다."; return
        }
        down.flags = []; up.flags = []
        posted = true; outcome = "unknown"
        down.postToPid(running.processIdentifier); up.postToPid(running.processIdentifier)
        // One Return only. An uncertain result is never automatically retried.
        while Date().addingTimeInterval(0.5) < requestDeadline {
            Thread.sleep(forTimeInterval: 0.15); fresh()
            guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { continue }
            let matches = windows.filter { string($0, kAXTitleAttribute) == room }
            if matches.count == 1, CFEqual(matches[0], window),
               (attribute(input, kAXValueAttribute) as? String) == "",
               newOutgoingMatches(context, previousRows: previousRows, payload: payload) {
                outcome = "sent"; detail = "카카오톡 대화에 전송한 내용을 확인했습니다."; return
            }
        }
        detail = "전송 결과를 확인하지 못했습니다. 중복 방지를 위해 다시 보내지 않습니다. 카톡방에서 직접 확인해주세요."
    }
    operation()
    // Do not leave a staged draft behind when no Return was posted. Never remove user changes.
    if touchedInput && !posted, let input = targetInput {
        fresh()
        if string(input, kAXValueAttribute) == payload { _ = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, "" as CFString) }
    }
    if touchedWindow, let window = targetWindow {
        AXUIElementSetMessagingTimeout(window, 0.3)
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
        // Miniaturization completes asynchronously; an immediate AX read can still return false.
        let minimizeDeadline = Date().addingTimeInterval(1.2)
        repeat {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &value) == .success { minimized = (value as? Bool) == true }
            if minimized { break }
            Thread.sleep(forTimeInterval: 0.08)
        } while Date() < minimizeDeadline
        if !minimized { detail += " 창을 다시 최소화하지 못했으니 확인해주세요." }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier, let previousApp, previousApp.processIdentifier != running.processIdentifier {
            _ = previousApp.activate(options: [])
        }
    }
    return response()
}

// Called from the Electron process through Node-API. Accessibility permission now belongs
// to Reply Note itself, rather than to an unbundled child executable with a separate identity.
@_cdecl("reply_note_read")
public func replyNoteRead(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    readLock.lock()
    defer { readLock.unlock() }
    return autoreleasepool {
        attributeCache.removeAll(keepingCapacity: true)
        let line = String(cString: input)
        guard let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else { return strdup("{}") }
        requestDeadline = Date().addingTimeInterval(request.op == "export" ? 40 : request.op == "send" ? 11 : 8)
        var response = request.op == "export" ? exportChatAttachment(request) : request.op == "send" ? sendAndMinimize(request) : respond(request)
        if request.op != "send" && request.op != "export" && Date() >= requestDeadline {
            response = Response(id: request.id, status: "error", room: request.room ?? "", messages: [], detail: "카카오톡 대화 읽기가 지연되고 있습니다. 채팅방을 확인한 뒤 다시 연결해주세요.", capturedAt: Date().timeIntervalSince1970 * 1000, rooms: [], chatKind: nil)
        }
        guard let output = try? JSONEncoder().encode(response), let text = String(data: output, encoding: .utf8) else { return strdup("{}") }
        return strdup(text)
    }
}
