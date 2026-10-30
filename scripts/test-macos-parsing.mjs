import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if (process.platform !== 'darwin') { console.log('macOS Swift parser checks skipped on this platform.'); process.exit(0); }
const temporary = mkdtempSync(path.join(os.tmpdir(), 'reply-note-mac-parser-'));
try {
  const main = path.join(temporary, 'main.swift');
  writeFileSync(main, String.raw`
import Foundation
assert(chatParticipantCount(nil) == nil)
assert(chatParticipantCount("대화상대 2명") == 2)
assert(chatParticipantCount("대화상대 20명 대화상대 20명") == 20)
assert(chatParticipantCount("대화상대 2명") != 20)
assert(chatSenderName(labels: ["민수", "오후 1:00", "3"], hasProfile: true, previous: "지우", directRoom: nil) == "민수")
assert(chatSenderName(labels: [" 민수 ", "민수"], hasProfile: true, previous: "", directRoom: nil) == "민수")
assert(chatSenderName(labels: ["오후 1:00", "2"], hasProfile: false, previous: "민수", directRoom: nil) == "민수")
assert(chatSenderName(labels: [], hasProfile: true, previous: "민수", directRoom: nil) == "")
assert(chatSenderName(labels: [], hasProfile: false, previous: "", directRoom: nil) == "")
assert(chatSenderName(labels: ["민수", "지우"], hasProfile: false, previous: "민수", directRoom: nil) == "")
assert(chatSenderName(labels: [], hasProfile: false, previous: "", directRoom: "친구") == "친구")
assert(chatMedia(images: ["사진"], controls: [], labels: [], hasText: false).first?.kind == "image")
assert(chatMedia(images: ["사진 3장"], controls: [], labels: [], hasText: false).first?.count == 3)
assert(chatMedia(images: [], controls: ["파일 다운로드"], labels: ["수학문제.hwp", "64 KB"], hasText: false).first?.name == "수학문제.hwp")
assert(chatMedia(images: [], controls: [], labels: [], hasText: false).first?.kind == "unknown")
assert(chatMedia(images: ["프로필 사진"], controls: [], labels: [], hasText: true).isEmpty)
assert(chatMedia(images: [], controls: [], labels: [], hasText: true).isEmpty)
assert(chatIsSeparator(["2026년 10월 29일 목요일"]))
assert(!chatIsSeparator(["사진", "민수"]))
assert(chatMedia(images: [""], controls: ["공유"], labels: ["안녕하세요"], hasText: true).isEmpty)
assert(chatMedia(images: [""], controls: ["공유"], labels: [], hasText: false).first?.kind == "image")
assert(chatMedia(images: [""], controls: ["저장", "다른 이름으로 저장"], labels: ["[오늘의집]_표준계약서.pdf 유효기간: ~2025. 10. 31. 용량: 1.1MB"], hasText: false).first?.name == "[오늘의집]_표준계약서.pdf")
print("22 macOS participant/sender parser checks passed (synthetic metadata).")
`);
  const binary = path.join(temporary, 'parser-checks');
  execFileSync('swiftc', ['native/macos/MessageParsing.swift', main, '-o', binary], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
} finally { rmSync(temporary, { recursive: true, force: true }); }
