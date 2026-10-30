// Run after npm run build. Uses an isolated demo profile; never opens real conversations.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = mkdtempSync(path.join(os.tmpdir(), 'reply-note-keyboard-ui-'));
const evidence = path.resolve(process.env.REPLY_NOTE_UI_EVIDENCE || '/tmp/reply-note-keyboard-ui-evidence');
mkdirSync(evidence, { recursive: true });
const executable = process.env.REPLY_NOTE_TEST_APP || process.execPath;
const launch = process.env.REPLY_NOTE_TEST_APP ? [] : ['node_modules/electron/cli.js', '.'];
writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ settings: {room:'수학 수업방',prompt:'테스트 지침',model:'',codexPath:'',delivery:'app'}, roomNames:['수학 수업방','테스트 친구'], drafts:[{id:'keyboard-ui',room:'수학 수업방',text:'첫 줄',createdAt:Date.now(),delivery:'local'}] }));
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
  await until(`!!document.querySelector('#reply-draft-editor')`, 'draft editor rendered', 30000);
  const value = () => evaluate(`document.querySelector('#reply-draft-editor').value`);
  await evaluate(`(() => { const area = document.querySelector('#reply-draft-editor'); area.focus(); area.setSelectionRange(area.value.length,area.value.length); })()`);
  const enter = async modifiers => {
    await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,modifiers,text:'\r',unmodifiedText:'\r'});
    await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,modifiers});
  };
  await enter(0); assert.equal(await value(), '첫 줄', 'disabled Enter cannot send or insert newline');
  await enter(8); await until(`document.querySelector('#reply-draft-editor').value === '첫 줄\\n'`, 'native Shift+Enter newline');
  await until(`window.replyNote.getState().then(s => s.drafts[0].text === '첫 줄\\n')`, 'newline autosaved');
  assert.equal(await evaluate(`window.replyNote.getState().then(s => s.drafts[0].contactSend)`), undefined);
  await evaluate(`document.querySelector('.draft-editor').scrollIntoView({block:'center'})`); await screenshot('00-keyboard-editor.png');
  console.log(JSON.stringify({result:'passed',checks:['native Shift+Enter newline','newline autosave','disabled Enter blocked','no real native send or model calls'],evidence}));
} finally {
  socket?.close(); child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)]);
  rmSync(profile, {recursive:true,force:true});
}
