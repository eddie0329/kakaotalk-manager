import { app, BrowserWindow } from 'electron';
import path from 'node:path';
app.setName('Reply Note');
void app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const development = !app.isPackaged && process.env.REPLY_NOTE_DEV_URL === 'http://127.0.0.1:5173';
  if (development) void window.loadURL(process.env.REPLY_NOTE_DEV_URL!);
  else void window.loadFile(path.join(__dirname, '../../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
