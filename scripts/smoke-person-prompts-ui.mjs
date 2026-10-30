// Run after npm run build. Uses an isolated demo profile; never opens real conversations.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = mkdtempSync(path.join(os.tmpdir(), 'reply-note-person-ui-'));
const evidence = path.resolve(process.env.REPLY_NOTE_UI_EVIDENCE || '/tmp/reply-note-person-ui-evidence');
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
  await until(`!!document.querySelector('#person-prompt-text')`, 'person prompts mounted', 30000);
  await evaluate(`document.querySelector('.person-prompts-panel').open = true`);
  const setText = text => evaluate(`(() => { const area = document.querySelector('#person-prompt-text'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(text)}); area.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  const select = name => evaluate(`(() => { const select = document.querySelector('#person-prompt-name'); select.value = ${JSON.stringify(name)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  assert.equal(await evaluate(`document.querySelector('#person-prompt-name').value`), '민수');
  await setText('항상 정중한 존댓말을 사용하고 선생님이라고 불러줘.');
  await click('개인 프롬프트 저장');
  await until(`window.replyNote.getState().then(s => s.targets.find(t => t.room === '수학 수업방').personPrompts?.민수?.includes('존댓말'))`, 'formal profile persisted');
  await select('지우'); await setText('친구처럼 편한 반말로 답해줘.');
  await select('민수'); assert((await evaluate(`document.querySelector('#person-prompt-text').value`)).includes('존댓말'));
  await select('지우'); assert((await evaluate(`document.querySelector('#person-prompt-text').value`)).includes('반말'));
  await click('개인 프롬프트 저장');
  await until(`window.replyNote.getState().then(s => Object.keys(s.targets.find(t => t.room === '수학 수업방').personPrompts ?? {}).length === 2)`, 'two separate profiles');
  await evaluate(`document.querySelector('.person-prompts-panel').scrollIntoView({block:'start'})`); await pause(100); await screenshot('00-person-prompts.png');
  await evaluate(`window.replyNote.selectRoom('테스트 친구')`);
  await until(`document.querySelector('#person-prompt-name')?.value === '테스트 친구'`, 'direct recipient editor');
  assert.equal(await evaluate(`document.querySelector('#person-prompt-text').value`), '');
  await evaluate(`document.querySelector('.person-prompts-panel').open = true`); await setText('짧고 정중한 존댓말로 답해줘.'); await click('개인 프롬프트 저장');
  await until(`window.replyNote.getState().then(s => !!s.targets.find(t => t.room === '테스트 친구').personPrompts?.['테스트 친구'])`, 'direct profile persisted');
  await setText(''); await click('개인 프롬프트 저장');
  await until(`window.replyNote.getState().then(s => Object.keys(s.targets.find(t => t.room === '테스트 친구').personPrompts ?? {}).length === 0)`, 'blank deletes profile');
  await evaluate(`window.replyNote.selectRoom('수학 수업방')`);
  await until(`document.querySelector('#person-prompt-name')?.value === '민수'`, 'return to group');
  assert((await evaluate(`document.querySelector('#person-prompt-text').value`)).includes('존댓말'));
  console.log(JSON.stringify({result:'passed',checks:['formal and casual profiles separated','unsaved edits preserved across people','room isolation','direct room profile','blank deletes profile','no real conversations or model calls'],evidence}));
} finally {
  socket?.close(); child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)]);
  rmSync(profile, {recursive:true,force:true});
}
