import { rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
rmSync('dist-electron', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json'], { stdio: 'inherit' });

copyFileSync('electron/pdf-loader.cjs', 'dist-electron/electron/pdf-loader.cjs');
