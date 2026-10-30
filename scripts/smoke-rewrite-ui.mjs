// Run after npm run build. Uses an isolated demo profile; never opens real conversations.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = mkdtempSync(path.join(os.tmpdir(), 'reply-note-rewrite-ui-'));
const evidence = path.resolve(process.env.REPLY_NOTE_UI_EVIDENCE || '/tmp/reply-note-rewrite-ui-evidence');
mkdirSync(evidence, { recursive: true });
const executable = process.env.REPLY_NOTE_TEST_APP || process.execPath;
const launch = process.env.REPLY_NOTE_TEST_APP ? [] : ['node_modules/electron/cli.js', '.'];
writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ settings: {room:'수학 수업방',prompt:'테스트 지침',model:'',codexPath:'',delivery:'app'}, roomNames:['수학 수업방','테스트 친구'], drafts:[{id:'keyboard-ui',room:'수학 수업방',text:'원본 초안',createdAt:Date.now(),delivery:'local',targetSender:'민수',targetMessages:[{id:'group-2',sender:'민수',direction:'incoming',text:'네, 감사합니다.',time:'오후 1:01'}]}] }));
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
  await until(`!!document.querySelector('#draft-rewrite-instruction')`, 'rewrite editor mounted', 30000);
  const edit = (selector, text) => evaluate(`(() => { const area = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(text)}); area.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await edit('#reply-draft-editor', '내가 고친 현재 초안입니다.');
  await until(`window.replyNote.getState().then(s => s.drafts[0].text === '내가 고친 현재 초안입니다.')`, 'current edited text autosaved');
  await edit('#draft-rewrite-instruction', '더 정중하게');
  await evaluate(`(() => { const area = document.querySelector('#draft-rewrite-instruction'); area.focus(); area.setSelectionRange(area.value.length,area.value.length); })()`);
  await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await call('Input.insertText', {text:'두 문장으로 줄여줘.'});
  assert.equal(await evaluate(`document.querySelector('#draft-rewrite-instruction').value`), '더 정중하게\n두 문장으로 줄여줘.');
  assert.equal(await evaluate(`window.replyNote.getState().then(s => s.drafts.length)`), 1, 'instruction Enter never generates or sends');
  await evaluate(`document.querySelector('.draft-rewrite').scrollIntoView({block:'center'})`); await screenshot('00-rewrite-request.png');
  await click('지시대로 다시 만들기');
  await until(`window.replyNote.getState().then(s => s.draftTest.running && s.draftTest.source === 'rewrite')`, 'rewrite in progress');
  assert.equal(await evaluate(`document.querySelector('#reply-draft-editor').disabled`), true);
  await until(`window.replyNote.getState().then(s => s.drafts.length === 2 && !s.draftTest.running)`, 'rewritten child saved');
  const state = await evaluate(`window.replyNote.getState()`);
  assert.equal(state.drafts[0].revision.parentId, 'keyboard-ui');
  assert.equal(state.drafts[0].revision.instruction, '더 정중하게\n두 문장으로 줄여줘.');
  assert(state.drafts[0].text.startsWith('내가 고친 현재 초안입니다.'));
  assert.equal(state.drafts[1].text, '내가 고친 현재 초안입니다.');
  assert.equal(state.drafts[0].targetSender, '민수'); assert.equal(state.settings.prompt, '테스트 지침');
  assert(state.drafts.every(d => !d.contactSend));
  await until(`document.querySelector('#draft-rewrite-instruction').value === ''`, 'one-off instruction not carried into next request');
  await edit('#draft-rewrite-instruction', '더 짧게'); await click('지시대로 다시 만들기');
  await until(`window.replyNote.getState().then(s => s.drafts.length === 3 && !s.draftTest.running)`, 'second revision saved');
  const again = await evaluate(`window.replyNote.getState()`); assert.equal(again.drafts[0].revision.parentId, state.drafts[0].id);
  assert(again.drafts.every(d => !d.contactSend));
  await edit('#draft-rewrite-instruction', '취소할 재작성'); await click('지시대로 다시 만들기');
  await until(`window.replyNote.getState().then(s => s.draftTest.running)`, 'third revision started');
  await click('재작성 취소');
  await until(`window.replyNote.getState().then(s => !s.draftTest.running)`, 'revision cancelled');
  await pause(1500); assert.equal(await evaluate(`window.replyNote.getState().then(s => s.drafts.length)`), 3, 'no cancelled late result');
  await evaluate(`document.querySelector('.draft-panel').scrollIntoView({block:'start'})`); await screenshot('01-rewritten-draft.png');
  console.log(JSON.stringify({result:'passed',checks:['instruction Enter only adds newline','edited body used','original preserved','new unsent result','one-off instruction isolation','group recipient preserved','iterative revision chain','cancelled late result suppressed','no real messages or model calls'],evidence}));
} finally {
  socket?.close(); child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)]);
  rmSync(profile, {recursive:true,force:true});
}
