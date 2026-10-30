import Foundation

// Pure helpers shared by the native reader and synthetic parser checks.
func chatParticipantCount(_ label: String?) -> Int? {
    guard let label, let range = label.range(of: #"대화상대\s+(\d+)명"#, options: .regularExpression) else { return nil }
    return Int(label[range].filter { $0.isNumber })
}

func chatSenderName(labels: [String], hasProfile: Bool, previous: String, directRoom: String?) -> String {
    let names = Set(labels.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter {
        !$0.isEmpty && $0.range(of: #"^(?:[0-9]+|.*\d{1,2}:\d{2}.*|.*\d+년.*|.*\d+월.*\d+일.*)$"#, options: .regularExpression) == nil
    })
    if names.count == 1 { return names.first! }
    if names.isEmpty && !hasProfile && !previous.isEmpty { return previous }
    return directRoom ?? ""
}

struct MessageAttachment: Codable {
    let id: String
    let kind: String
    var name: String? = nil
    var count: Int? = nil
}
func chatFileName(_ value: String) -> String? {
    let text = value.components(separatedBy: " 유효기간").first!.components(separatedBy: " 용량:").first!.trimmingCharacters(in: .whitespacesAndNewlines)
    let pattern = #"^[^/\\\n\r]{1,180}\.(?:pdf|docx?|hwpx?|xlsx?|pptx?|txt|csv|zip|7z|png|jpe?g|webp|gif|bmp|heic|mp4|mov|mp3|m4a)(?:\s+(?:다운로드|열기|저장))?$"#
    guard text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
    return text.replacingOccurrences(of: #"\s+(?:다운로드|열기|저장)$"#, with: "", options: .regularExpression)
}
func chatIsSeparator(_ labels: [String]) -> Bool {
    let labels = labels.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    return !labels.isEmpty && labels.allSatisfy { $0.range(of: #"^(?:\d{4}년\s*\d{1,2}월\s*\d{1,2}일.*|\d{4}[./-]\s*\d{1,2}[./-]\s*\d{1,2}.*|여기까지 읽었습니다|새로운 메시지|읽지 않은 메시지)$"#, options: .regularExpression) != nil }
}
func chatMedia(images: [String], controls: [String], labels: [String], hasText: Bool) -> [MessageAttachment] {
    let controls = controls.filter { $0.range(of: "프로필|profile|badge me", options: [.regularExpression, .caseInsensitive]) == nil }
    let filenames = (controls + labels).compactMap(chatFileName)
    let fileControl = controls.contains { $0.range(of: "파일.*(?:다운로드|열기|저장)|(?:다운로드|열기).*파일|download|attachment", options: [.regularExpression, .caseInsensitive]) != nil || chatFileName($0) != nil }
    let sizeLabel = labels.contains { $0.range(of: #"^\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB)$"#, options: [.regularExpression, .caseInsensitive]) != nil }
    var result: [MessageAttachment] = []
    if fileControl || (!filenames.isEmpty && (sizeLabel || labels.contains { $0.contains("유효기간") || $0.contains("용량:") })) { result.append(MessageAttachment(id: "media-0", kind: "file", name: filenames.first)) }
    for image in images where image.range(of: "프로필|profile|avatar|badge me|파일.*아이콘|file.*icon|document.*icon", options: [.regularExpression, .caseInsensitive]) == nil {
        if hasText && image.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
        if !result.isEmpty && image.range(of: "사진|photo", options: [.regularExpression, .caseInsensitive]) == nil { continue }
        var count: Int? = nil
        if let range = image.range(of: #"\d+\s*장"#, options: .regularExpression) { count = Int(image[range].filter { $0.isNumber }) }
        result.append(MessageAttachment(id: "media-\(result.count)", kind: "image", count: count))
    }
    if result.isEmpty && !hasText { result.append(MessageAttachment(id: "media-0", kind: "unknown")) }
    return result
}
