// Arabic Church Assistant — desktop app. Opens the operator console in its own window, puts the display full screen
// on the projector, runs the local server (for OBS and other PCs) and keeps the speech engine running.
'use strict';
const { app, BrowserWindow, Menu, Tray, screen, ipcMain, dialog, powerSaveBlocker, powerMonitor, shell, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(__dirname, 'icon.png');
const MAC = process.platform === 'darwin';

if (process.platform === 'win32') app.setAppUserModelId('ArabicChurchAssistant.Desktop');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// The Mac app can't write inside itself (Arabic Church Assistant.app): its settings, history, logs and recordings are in
// ~/Library/Application Support/Arabic Church Assistant/data, which gets the Bibles, fonts and song list it comes with.
if (MAC && app.isPackaged && !process.env.VF_DATA_DIR) {
  const dir = path.join(app.getPath('userData'), 'data');
  const seed = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name), d = path.join(to, e.name);
      if (e.isDirectory()) seed(s, d); else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
    }
  };
  try { seed(path.join(ROOT, 'data'), dir); } catch (e) { console.error('Could not set up ' + dir + ': ' + e.message); }
  process.env.VF_DATA_DIR = dir;
}

const server = require(path.join(ROOT, 'server.js'));
let base = 'http://localhost:5050';
let consoleWin = null, displayWin = null, tray = null, sleepBlock = null, quitting = false;
// what happens to the app itself goes into the day's log (data\logs), next to the speech engine's
const note = msg => { console.log(msg); try { server.logLine('app', msg); } catch { /* the log is a nice-to-have */ } };
process.on('uncaughtExceptionMonitor', e => { try { server.logLine('app', 'ERROR ' + ((e && e.stack) || e)); } catch { /* ignore */ } });

function icon() { try { return nativeImage.createFromPath(ICON); } catch { return undefined; } }

// ------------------------------------------------------------------ console
function createConsole() {
  const work = screen.getPrimaryDisplay().workAreaSize;
  consoleWin = new BrowserWindow({
    width: Math.min(1560, work.width), height: Math.min(980, work.height), minWidth: 980, minHeight: 640,
    title: 'Arabic Church Assistant', icon: icon(), backgroundColor: '#0f1115', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  consoleWin.setMenuBarVisibility(false);
  consoleWin.once('ready-to-show', () => { consoleWin.maximize(); consoleWin.show(); });
  consoleWin.loadURL(base + '/');
  consoleWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(base + '/display')) { openDisplay(); return { action: 'deny' }; }
    if (url.startsWith(base)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1280, height: 900, title: 'Arabic Church Assistant — Settings', icon: icon(), autoHideMenuBar: true, backgroundColor: '#0f1115', webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } } };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  consoleWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); shell.openExternal(url); } });
  consoleWin.webContents.on('render-process-gone', (e, d) => {
    if (quitting) return;
    note('Console page crashed (' + d.reason + '); reloading it.');
    setTimeout(() => { if (consoleWin && !consoleWin.isDestroyed()) consoleWin.reload(); }, 1000);
  });
  consoleWin.webContents.on('unresponsive', () => note('Console page is not responding…'));
  consoleWin.webContents.on('responsive', () => note('Console page is responding again.'));
  consoleWin.on('close', e => {
    if (quitting) return;
    const listening = server.speech && server.speech.listening;
    const choice = dialog.showMessageBoxSync(consoleWin, {
      type: 'question', buttons: ['Quit Arabic Church Assistant', 'Cancel'], defaultId: listening ? 1 : 0, cancelId: 1,
      title: 'Arabic Church Assistant', message: listening ? 'Arabic Church Assistant is listening. Stop listening and quit?' : 'Quit Arabic Church Assistant?',
      detail: 'The display window and the display links (OBS, other PCs) close too.',
    });
    if (choice !== 0) { e.preventDefault(); return; }
    quitting = true;
  });
  consoleWin.on('closed', () => { consoleWin = null; if (quitting) app.quit(); });
}

// ------------------------------------------------------------------ display (projector)
function displays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id), primary: d.id === primary.id, label: `${d.label || 'Screen ' + (i + 1)} — ${d.size.width}×${d.size.height}${d.id === primary.id ? ' (main screen)' : ''}`,
    bounds: d.bounds,
  }));
}
// The screen to use: the one chosen in Settings, else the projector (a screen that isn't the main one)
function targetDisplay() {
  const all = screen.getAllDisplays();
  const want = String(server.getSettings().displayId || '');
  const chosen = want && all.find(d => String(d.id) === want);
  if (chosen) return chosen;
  const primary = screen.getPrimaryDisplay();
  const consoleDisp = consoleWin && !consoleWin.isDestroyed() ? screen.getDisplayMatching(consoleWin.getBounds()) : primary;
  return all.find(d => d.id !== consoleDisp.id && d.id !== primary.id) || all.find(d => d.id !== consoleDisp.id) || primary;
}
// Is the display on a screen of its own (the projector)? Then it is full screen without a frame; sharing the
// console's screen, it is a normal window with a title bar, so it can be moved and resized.
function displayOwnScreen() {
  const d = targetDisplay();
  const consoleDisp = consoleWin && !consoleWin.isDestroyed() ? screen.getDisplayMatching(consoleWin.getBounds()) : screen.getPrimaryDisplay();
  return { d, own: d.id !== consoleDisp.id };
}
function placeDisplay() {
  if (!displayWin || displayWin.isDestroyed()) return;
  const { d, own } = displayOwnScreen();
  if (own !== displayWin.vfOwn && server.getScreen().type !== 'video') {   // projector plugged in or out: make the window again
    const w = displayWin;
    displayWin = null;
    w.removeAllListeners('closed');
    w.destroy();
    openDisplay();
    return;
  }
  displayWin.setFullScreen(false);
  if (own) {
    displayWin.setBounds(d.bounds);
    displayWin.setFullScreen(true);
  } else {
    const w = Math.round(d.workArea.width * 0.5), h = Math.round(w * 9 / 16);
    displayWin.setBounds({ x: d.workArea.x + d.workArea.width - w - 20, y: d.workArea.y + 20, width: w, height: h });
  }
}
function openDisplay() {
  if (displayWin && !displayWin.isDestroyed()) { placeDisplay(); displayWin.showInactive(); return true; }
  const { own } = displayOwnScreen();
  displayWin = new BrowserWindow({
    title: 'Arabic Church Assistant — Display', icon: icon(), backgroundColor: '#000000', frame: !own, show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  displayWin.vfOwn = own;
  displayWin.setMenuBarVisibility(false);
  displayWin.loadURL(base + '/display?video=1&desktop=1');
  displayWin.once('ready-to-show', () => { placeDisplay(); displayWin.showInactive(); if (consoleWin) consoleWin.focus(); });
  displayWin.webContents.on('render-process-gone', (e, d) => {
    if (quitting) return;
    note('Display page crashed (' + ((d && d.reason) || '?') + '); reloading it.');
    setTimeout(() => { if (displayWin && !displayWin.isDestroyed()) displayWin.reload(); }, 800);
  });
  displayWin.on('closed', () => { displayWin = null; if (!quitting) note('The display window was closed.'); notify(); });
  note('The display window was opened (' + (own ? 'full screen on its own screen' : 'in a window: there is one screen') + ').');
  displayWin.on('enter-full-screen', notify);
  displayWin.on('leave-full-screen', notify);
  notify();
  return true;
}
function closeDisplay() { if (displayWin && !displayWin.isDestroyed()) displayWin.close(); }
function notify() {
  const st = { open: !!(displayWin && !displayWin.isDestroyed()), fullscreen: !!(displayWin && !displayWin.isDestroyed() && displayWin.isFullScreen()) };
  if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send('display-state', st);
  updateTray();
}

// ------------------------------------------------------------------ tray
function updateTray() {
  if (!tray) return;
  const open = !!(displayWin && !displayWin.isDestroyed());
  const listening = !!(server.speech && server.speech.listening);
  tray.setToolTip('Arabic Church Assistant' + (listening ? ' — listening' : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show the console', click: () => { if (consoleWin) { consoleWin.show(); consoleWin.focus(); } } },
    { label: open ? 'Close the display' : 'Open the display', click: () => (open ? closeDisplay() : openDisplay()) },
    { label: listening ? 'Stop listening' : 'Start listening', click: () => server.speech.setListening(!listening) },
    { type: 'separator' },
    { label: 'Quit Arabic Church Assistant', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ------------------------------------------------------------------ IPC from the pages (preload.js)
ipcMain.handle('vf:displays', () => displays());
ipcMain.handle('vf:display-open', () => openDisplay());
ipcMain.handle('vf:display-close', () => { closeDisplay(); return true; });
ipcMain.handle('vf:display-state', () => ({ open: !!(displayWin && !displayWin.isDestroyed()), fullscreen: !!(displayWin && !displayWin.isDestroyed() && displayWin.isFullScreen()) }));
ipcMain.handle('vf:display-fullscreen', () => {
  if (!displayWin || displayWin.isDestroyed()) return false;
  displayWin.setFullScreen(!displayWin.isFullScreen());
  return displayWin.isFullScreen();
});
ipcMain.handle('vf:pick-file', async () => {
  const r = await dialog.showOpenDialog(consoleWin, {
    title: 'Test with a recording or video', properties: ['openFile'],
    filters: [{ name: 'Audio and video', extensions: ['mp3', 'm4a', 'wav', 'mp4', 'mkv', 'mov', 'aac', 'ogg', 'opus', 'webm', 'wma', 'flac', 'avi', 'wmv'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('vf:open-external', (e, url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(String(url)); return true; });
ipcMain.handle('vf:open-folder', (e, which) => {
  const data = server.DATA || path.join(ROOT, 'data');
  const dirs = { history: path.join(data, 'history'), logs: path.join(data, 'logs'), recordings: path.join(data, 'recordings'),
    app: ROOT, engine: path.join(ROOT, 'engine') };
  const d = dirs[which] || ROOT;
  fs.mkdirSync(d, { recursive: true });
  shell.openPath(d);
  return true;
});
ipcMain.handle('vf:info', () => ({ version: server.VERSION, electron: process.versions.electron, root: ROOT }));

// ------------------------------------------------------------------ start
// The shortcut in the app's folder (it comes in the download) leads into bin\ by a path relative to itself, so it works
// wherever the folder is unzipped; but until it also holds the full path, Windows shows it without the app's icon. Made
// again once for each place the folder is in (electron\shortcut.ps1 keeps the relative path too).
function fixFolderShortcut() {
  const exe = process.execPath, lnk = path.join(ROOT, 'Arabic Church Assistant.lnk'), mark = path.join(ROOT, 'bin', 'shortcut.txt');
  if (process.platform !== 'win32' || !/Arabic Church Assistant\.exe$/i.test(exe)) return;
  try { if (!fs.existsSync(lnk) || fs.readFileSync(mark, 'utf8') === exe) return; } catch { /* not made here yet */ }
  require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'shortcut.ps1'), '-Link', lnk, '-Target', exe, '-Icon', path.join(__dirname, 'icon.ico')], { windowsHide: true }, err => {
    if (!err) { try { fs.writeFileSync(mark, exe); } catch { /* next time */ } }
  });
}

app.whenReady().then(async () => {
  // the pages are this app's own (localhost): allow the microphone, full screen and autoplay without asking
  const ok = url => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url || '');
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(ok(details.requestingUrl || wc.getURL()) || perm === 'fullscreen'));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => ok(origin + '/') || perm === 'fullscreen');
  try {
    const r = await server.start();
    base = r.url;
  } catch (e) {
    dialog.showErrorBox('Arabic Church Assistant', 'Arabic Church Assistant could not start: ' + e.message);
    app.quit();
    return;
  }
  if (MAC) {
    // a Mac's menu bar: copy and paste in the text boxes, Quit (⌘Q), full screen, the windows
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    // the speech engine listens on behalf of the app: the Mac asks the operator once
    const { systemPreferences } = require('electron');
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    if (mic === 'not-determined') systemPreferences.askForMediaAccess('microphone').then(ok => note('Microphone: ' + (ok ? 'allowed.' : 'not allowed (System Settings → Privacy & Security → Microphone).'))).catch(() => {});
    else if (mic !== 'granted') note(`Microphone access is ${mic}: allow Arabic Church Assistant in System Settings → Privacy & Security → Microphone.`);
  }
  createConsole();
  setTimeout(fixFolderShortcut, 5000);
  const trayIcon = icon();
  tray = new Tray(trayIcon && MAC ? trayIcon.resize({ width: 18, height: 18 }) : trayIcon || nativeImage.createEmpty());
  tray.on('click', () => { if (consoleWin) { consoleWin.show(); consoleWin.focus(); } });
  updateTray();
  if (server.getSettings().displayAutoOpen) setTimeout(openDisplay, 1500);

  // the display follows the projector being plugged in or out
  const replace = () => setTimeout(() => { placeDisplay(); notify(); }, 800);
  screen.on('display-added', replace);
  screen.on('display-removed', replace);
  screen.on('display-metrics-changed', replace);

  // the PC must not go to sleep (or blank the projector) during a service
  server.hub.on('speech', st => {
    const on = !!(st && st.listening);
    if (on && sleepBlock == null) sleepBlock = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && sleepBlock != null) { powerSaveBlocker.stop(sleepBlock); sleepBlock = null; }
    updateTray();
  });
  server.hub.on('display', action => { if (action === 'close') closeDisplay(); else openDisplay(); });
  powerMonitor.on('suspend', () => note(MAC ? 'The Mac is going to sleep.' : 'Windows is going to sleep.'));
  powerMonitor.on('resume', () => note(MAC ? 'The Mac woke up.' : 'Windows woke up.'));
  server.hub.on('settings', (s, before) => { if (before && s.displayId !== before.displayId) placeDisplay(); });
});

app.on('second-instance', () => { if (consoleWin) { if (consoleWin.isMinimized()) consoleWin.restore(); consoleWin.show(); consoleWin.focus(); } });
app.on('before-quit', () => { quitting = true; note('Arabic Church Assistant is closing.'); server.shutdown(); });
app.on('window-all-closed', () => app.quit());
