import { spawn, execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['scripts/build-native.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/build-electron.mjs'], { stdio: 'inherit' });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
let electron;
const cleanup = () => { electron?.kill(); vite.kill(); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
for (let attempt = 0; attempt < 100; attempt++) {
  try { const r = await fetch('http://127.0.0.1:5173'); if (r.ok) break; } catch {}
  await new Promise(r => setTimeout(r, 100));
}
electron = spawn(process.execPath, ['node_modules/electron/cli.js', '.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, REPLY_NOTE_DEV_URL: 'http://127.0.0.1:5173' } });
electron.on('exit', () => { vite.kill(); process.exit(); });
