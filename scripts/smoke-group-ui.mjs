// Run after npm run build. Uses an isolated demo profile; never opens real conversations.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { materials } from './material-fixtures.mjs';

const profile = mkdtempSync(path.join(os.tmpdir(), 'reply-note-group-ui-'));
const evidence = path.resolve(process.env.REPLY_NOTE_UI_EVIDENCE || '/tmp/reply-note-group-ui-evidence');
mkdirSync(evidence, { recursive: true });
const executable = process.env.REPLY_NOTE_TEST_APP || process.execPath;
const launch = process.env.REPLY_NOTE_TEST_APP ? [] : ['node_modules/electron/cli.js', '.'];
const child = spawn(executable, [...launch, '--demo', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { env: { ...process.env, REPLY_NOTE_DEMO_DIRECTORY: profile }, stdio: ['ignore', 'pipe', 'pipe'] });
let socket;
let appDiagnostics = '';
child.stderr.on('data', chunk => { appDiagnostics = (appDiagnostics + chunk.toString()).slice(-8000); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron debugger did not start')), 20000);
    child.stderr.on('data', chunk => { const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Electron exited: ${code}`)); });
  });
  const origin = new URL(endpoint); let target;
  for (let i = 0; i < 100 && !target; i++) {
    const pages = await fetch(`http://${origin.host}/json/list`).then(r => r.json());
    target = pages.find(page => page.type === 'page' && page.url.includes('index.html'));
    if (!target) await pause(100);
  }
  assert(target, 'app page exists');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const response = JSON.parse(event.data); const pair = pending.get(response.id); if (pair) { pending.delete(response.id); response.error ? pair.reject(new Error(response.error.message)) : pair.resolve(response.result); } });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + response.exceptionDetails.exception?.description);
    return response.result.value;
  };
  const until = async (expression, description, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(150); }
    const detail = await evaluate(`JSON.stringify({text:document.body.innerText.slice(0,2000), api:typeof window.replyNote})`);
    throw new Error(`Timed out: ${description}. ${detail}. ${appDiagnostics}`);
  };
  const click = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw Error('Button unavailable: ' + ${JSON.stringify(label)}); button.click(); })()`);
  const screenshot = async name => { const data = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(path.join(evidence, name), Buffer.from(data.data, 'base64')); };
  await until(`!!document.querySelector('#questioners')`, 'participant registration rendered', 30000);
  assert.equal(await evaluate(`document.querySelector('#questioners').value`), '민수\n지우');
  await evaluate(`document.querySelector('.participants-panel').scrollIntoView({block:'start'})`); await pause(250);
  await screenshot('00-participant-settings.png');
  await click('전체 감지 시작');
  await until(`window.replyNote.getState().then(s => s.monitor.phase === 'watching')`, 'baseline loaded');
  await click('민수 메시지 추가');
  await until(`window.replyNote.getState().then(s => s.monitor.tasks.length === 1)`, 'first questioner waiting');
  await click('지우 메시지 추가');
  await until(`window.replyNote.getState().then(s => s.monitor.tasks.length === 2)`, 'independent questioner waits');
  await until(`window.replyNote.getState().then(s => s.drafts.filter(d => d.targetSender).length === 2)`, 'two distinct generated drafts');
  const drafts = await evaluate(`window.replyNote.getState().then(s => s.drafts)`);
  assert.deepEqual(drafts.map(d => d.targetSender).sort(), ['민수', '지우']);
  assert(drafts.every(d => d.targetMessages.length === 1));
  assert.equal(await evaluate(`document.querySelectorAll('.questioner-drafts button').length`), 2);
  await evaluate(`document.querySelector('.draft-panel').scrollIntoView({block:'start'})`); await pause(250);
  await screenshot('01-questioner-drafts.png');
  // Select a different questioner through the actual UI and verify its source message.
  await evaluate(`document.querySelectorAll('.questioner-drafts button')[1].click()`);
  await until(`document.querySelector('.draft-target').textContent.includes('민수') || document.querySelector('.draft-target').textContent.includes('지우')`, 'source message shown');
  if (process.env.REPLY_NOTE_TEST_MATERIALS) {
    const fixtures = materials();
    for (const [name, data] of Object.entries(fixtures)) writeFileSync(path.join(profile, name), data);
    const targetId = drafts.find(d => d.targetSender === '민수').targetMessages[0].id;
    await evaluate(`document.querySelector('.message-context[data-question-id=' + CSS.escape(${JSON.stringify(targetId)}) + ']').open = true`);
    await until(`document.querySelector('.context-question').textContent.includes('어디부터')`, 'selected exact question');
    await evaluate(`(() => { const area = document.querySelector('.context-note'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '선생님이 이전에 설명한 원문입니다. 조건을 먼저 정리하세요.'); area.dispatchEvent(new Event('input',{bubbles:true})); const reference = document.querySelector('.context-reference-list input'); if (reference) reference.click(); })()`);
    await click('원문·설명 저장');
    await until(`window.replyNote.getState().then(s => s.questionContexts.some(c => c.note.includes('조건을 먼저')))`, 'reference note saved');
    await evaluate(`(() => { const input = document.createElement('input'); input.type='file'; input.multiple=true; input.id='smoke-files'; input.style.display='none'; document.body.append(input); })()`);
    const root = await call('DOM.getDocument'); const input = await call('DOM.querySelector', {nodeId:root.root.nodeId, selector:'#smoke-files'});
    const drop = async names => {
      await call('DOM.setFileInputFiles', {nodeId:input.nodeId, files:names.map(name => path.join(profile,name))});
      await evaluate(`(() => { const transfer = new DataTransfer(); for (const file of document.querySelector('#smoke-files').files) transfer.items.add(file); document.querySelector('.context-drop').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})); })()`);
    };
    await drop(['문제.png','문제.hwp','문제.pdf','문제.docx']);
    await until(`window.replyNote.getState().then(s => s.questionContexts.find(c => c.question.id === ${JSON.stringify(targetId)})?.attachments.length === 4)`, 'four actual files parsed in Electron workers', 35000);
    const attached = await evaluate(`window.replyNote.getState().then(s => s.questionContexts.find(c => c.question.id === ${JSON.stringify(targetId)}))`);
    assert.equal(attached.attachments.find(f => f.name.endsWith('.pdf')).imageCount, 1);
    assert(attached.attachments.find(f => f.name.endsWith('.hwp')).excerpt.includes('한글 문제'));
    await evaluate(`document.querySelector('.message-context[open]').scrollIntoView({block:'start'})`); await pause(200); await screenshot('03-question-materials.png');
    await evaluate(`[...document.querySelectorAll('.message-context[open] button')].find(b => b.textContent.includes('이 질문과 자료로 초안 만들기')).click()`);
    await until(`window.replyNote.getState().then(s => s.drafts.length === 3 && s.drafts[0].contexts?.[0]?.attachments.length === 4)`, 'regenerated draft preserves material sources');
    await evaluate(`document.querySelector('.draft-panel').scrollIntoView({block:'start'})`); await pause(200); await screenshot('04-material-draft.png');
    await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '문제.hwp 연결 해제'); button.click(); })()`);
    await until(`window.replyNote.getState().then(s => s.questionContexts[0].attachments.length === 3)`, 'remove app copy');
    await drop(['문제.hwpx']);
    await until(`window.replyNote.getState().then(s => s.questionContexts[0].attachments.some(f => f.name.endsWith('.hwpx') && f.excerpt.includes('HWPX 한글')))`, 'HWPX parsed in Electron worker');
  }
  await click('선생님 메시지 · 전체 취소');
  await until(`window.replyNote.getState().then(s => s.drafts.every(d => !!d.teacherResponse))`, 'completed drafts marked with teacher response');
  await until(`!!document.querySelector('.teacher-response')`, 'teacher badge rendered');
  await screenshot('02-teacher-response.png');
  await click('민수 메시지 추가'); await click('지우 메시지 추가');
  await until(`window.replyNote.getState().then(s => s.monitor.tasks.length === 2)`, 'second pair waiting');
  await click('선생님 메시지 · 전체 취소');
  await until(`window.replyNote.getState().then(s => s.monitor.tasks.length === 0 && s.monitor.phase === 'watching')`, 'teacher cancels room');
  assert.equal(await evaluate(`window.replyNote.getState().then(s => s.drafts.length)`), process.env.REPLY_NOTE_TEST_MATERIALS ? 3 : 2);
  if (process.env.REPLY_NOTE_TEST_MEDIA) {
    const fixtures = materials();
    for (const [name, data] of Object.entries(fixtures)) writeFileSync(path.join(profile, name), data);
    const previousCount = await evaluate(`window.replyNote.getState().then(s => s.drafts.length)`);
    await click('사진 메시지 추가'); await click('파일 메시지 추가'); await click('민수 메시지 추가');
    await until(`window.replyNote.getState().then(s => s.monitor.phase === 'needs_materials')`, 'unread photo/file blocks generation', 16000);
    assert.equal(await evaluate(`window.replyNote.getState().then(s => s.drafts.length)`), previousCount);
    const state = await evaluate(`window.replyNote.getState()`);
    const photo = state.monitor.messages.find(m => m.attachments?.some(a => a.kind === 'image'));
    const file = state.monitor.messages.find(m => m.attachments?.some(a => a.kind === 'file'));
    const question = state.monitor.messages.at(-1);
    assert(photo && file && photo.text === '' && file.text === '');
    assert.equal(await evaluate(`document.querySelectorAll('.message-attachment.missing').length`), 2);
    assert.equal(await evaluate(`document.body.innerText.includes('원문·사진·파일 연결')`), false);
    await evaluate(`(() => { document.querySelectorAll('.message-context').forEach(e => e.open = false); document.querySelector('.message-context[data-question-id=' + CSS.escape(${JSON.stringify(question.id)}) + ']').open = true; })()`);
    await until(`!!document.querySelector('.message-context[open] .context-body')`, 'question editor opens at exact message');
    await evaluate(`document.querySelector('.message-context[open]').scrollIntoView({block:'start'})`); await pause(200); await screenshot('05-unread-chat-media.png');
    await evaluate(`(() => { const input = document.createElement('input'); input.type='file'; input.multiple=true; input.id='smoke-media-files'; input.style.display='none'; document.body.append(input); })()`);
    const root = await call('DOM.getDocument'); const input = await call('DOM.querySelector', {nodeId:root.root.nodeId, selector:'#smoke-media-files'});
    const connect = async (message, filename) => {
      await call('DOM.setFileInputFiles', {nodeId:input.nodeId, files:[path.join(profile,filename)]});
      await evaluate(`(() => { const transfer = new DataTransfer(); for (const f of document.querySelector('#smoke-media-files').files) transfer.items.add(f); const row = [...document.querySelectorAll('.message')].find(e => e.querySelector('.message-context')?.dataset.questionId === ${JSON.stringify(message.id)}); row.querySelector('.message-attachment-wrap').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})); })()`);
      await until(`window.replyNote.getState().then(s => s.questionContexts.some(c => c.question.id === ${JSON.stringify(message.id)} && c.attachments.some(a => a.source?.message.id === ${JSON.stringify(message.id)})))`, 'file dropped onto exact attachment is parsed and bound', 30000);
    };
    await connect(photo, '문제.png');
    assert.equal(await evaluate(`document.querySelectorAll('.message-attachment.missing').length`), 1);
    assert.equal(await evaluate(`[...document.querySelectorAll('.message-context[open] button')].find(b => b.textContent.includes('이 질문과 자료로 초안 만들기')).disabled`), true);
    await connect(file, '문제.pdf');
    await until(`document.querySelectorAll('.message-attachment.missing').length === 0`, 'all media is ready');
    await evaluate(`[...document.querySelectorAll('.message-context[open] button')].find(b => b.textContent.includes('이 질문과 자료로 초안 만들기')).click()`);
    await until(`window.replyNote.getState().then(s => s.drafts.length === ${previousCount + 1} && s.drafts[0].contexts?.some(c => c.attachments.some(a => a.source?.message.id === ${JSON.stringify(photo.id)})))`, 'manual draft uses explicitly linked chat media');
    await until(`[...document.querySelectorAll('.message-attachment')].filter(el => el.textContent.includes('초안에 사용됨')).length === 2`, 'chat shows which media was used');
    await evaluate(`(() => { document.querySelector('.conversation-panel').scrollIntoView({block:'start'}); const scroll = document.querySelector('.conversation-scroll'); scroll.scrollTop = scroll.scrollHeight; })()`); await pause(200); await screenshot('06-chat-media-used.png');
    await evaluate(`(() => { const row = [...document.querySelectorAll('.message')].find(e => e.querySelector('.message-context')?.dataset.questionId === ${JSON.stringify(photo.id)}); [...row.querySelectorAll('button')].find(b => b.textContent === '연결 확인').click(); })()`);
    await until(`!!document.querySelector('.message-linked-files')`, 'connected files expand at photo');
    await evaluate(`document.querySelector('.message-linked-files button[aria-label="문제.png 연결 해제"]').click()`);
    await until(`document.querySelectorAll('.message-attachment.missing').length === 1`, 'unlinking content restores unread status');
    assert.equal(await evaluate(`[...document.querySelectorAll('.message-context[open] button')].find(b => b.textContent.includes('이 질문과 자료로 초안 만들기')).disabled`), true);
  }
  if (process.env.REPLY_NOTE_TEST_ACQUIRE === '1') {
    await click('사진 메시지 추가');
    await until(`!![...document.querySelectorAll('.message-attachment.missing button')].filter(b => b.textContent.includes('카톡에서 가져오기')).at(-1)`, 'acquisition button visible');
    await evaluate(`[...document.querySelectorAll('.message-attachment.missing button')].filter(b => b.textContent.includes('카톡에서 가져오기')).at(-1).click()`);
    await until(`window.replyNote.getState().then(s => s.questionContexts.some(c => c.attachments.some(a => a.name === 'KakaoTalk_Photo_demo.png' && a.source?.message.id === s.monitor.messages.at(-1).id)))`, 'acquired original parsed and bound to its exact message');
    await screenshot('09-acquired-original.png');
  }
  console.log(JSON.stringify({ result: 'passed', checks: [...(process.env.REPLY_NOTE_TEST_MEDIA ? ['photo/file message order', 'generation blocked before content', 'exact source mapping', 'used media status', 'unlink restores block'] : []), ...(process.env.REPLY_NOTE_TEST_MATERIALS ? ['actual PNG/PDF/DOCX/HWP/HWPX parsing', 'question-scoped file links', 'manual original reference', 'material draft provenance'] : []), 'participant registration', 'independent timers', 'two targeted drafts', 'source messages', 'teacher response badges', 'room-wide cancellation'], evidence }));
} finally {
  socket?.close();
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)]);
  rmSync(profile, { recursive: true, force: true });
}
