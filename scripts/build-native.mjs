import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
mkdirSync('native/bin', { recursive: true });
if (process.platform === 'darwin') {
  if (existsSync('native/bin/chat-reader')) unlinkSync('native/bin/chat-reader');
  execFileSync('swiftc', ['-O', '-emit-library', '-module-name', 'ReplyAccessibility', 'native/macos/ChatReader.swift', 'native/macos/MessageParsing.swift', 'native/macos/AttachmentExport.swift', '-o', 'native/bin/libReplyAccessibility.dylib', '-Xlinker', '-install_name', '-Xlinker', '@rpath/libReplyAccessibility.dylib', '-framework', 'Cocoa', '-framework', 'ApplicationServices'], { stdio: 'inherit' });
  execFileSync('clang', ['-dynamiclib', '-undefined', 'dynamic_lookup', '-DNAPI_VERSION=8', '-I', 'node_modules/node-api-headers/include', 'native/macos/Bridge.c', '-Lnative/bin', '-lReplyAccessibility', '-Wl,-rpath,@loader_path', '-o', 'native/bin/chat-reader.node'], { stdio: 'inherit' });
} else if (process.platform === 'win32') {
  execFileSync(process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/test-windows-native.ps1'], { stdio: 'inherit' });
} else {
  console.log('이 운영체제의 카카오톡 수집 모듈은 아직 지원되지 않습니다. UI와 공통 로직만 빌드합니다.');
}
