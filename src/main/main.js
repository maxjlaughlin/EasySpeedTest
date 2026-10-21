'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, globalShortcut, ipcMain, dialog, powerSaveBlocker, shell,
} = require('electron');

const { runTest, PROFILES } = require('./speedtest');
const { getNetInfo } = require('./netinfo');
const store = require('./store');

const isDev = process.argv.includes('--dev');

let mainWindow = null;
let activeRun = null; // { controller } while a test is in flight
let powerBlockerId = null;

function displayVersion() {
  // The app presents x.y; package.json carries the npm-required third field.
  const [major, minor] = app.getVersion().split('.');
  return `${major}.${minor}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#13131a',
    title: `EasySpeedTest v${displayVersion()}`,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Smoke-test hook (see scripts/smoke.js). Runs a scenario file against the
  // live renderer, saves a screenshot, reports console errors, and quits.
  // Inert unless EST_SMOKE is set, so it never affects normal use.
  if (process.env.EST_SMOKE) {
    const errors = [];
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      // Electron's own security advice is not a renderer fault.
      if (level >= 2 && !/Electron Security Warning/.test(message)) errors.push(message);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      errors.push(`render process gone: ${details.reason}`);
    });

    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let report = null;
        try {
          if (process.env.EST_SMOKE_SCENARIO) {
            const scenario = fs.readFileSync(process.env.EST_SMOKE_SCENARIO, 'utf8');
            report = await mainWindow.webContents.executeJavaScript(scenario, true);
          }
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.EST_SMOKE, image.toPNG());
        } catch (err) {
          errors.push(`smoke failure: ${err.message}`);
        }
        if (report) console.log(`SMOKE_REPORT ${JSON.stringify(report)}`);
        console.log(`SMOKE_ERRORS ${JSON.stringify(errors)}`);
        app.exit(errors.length ? 1 : 0);
      }, 1500);
    });
  }

  // External links belong in the real browser, never in the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------------

// Registered globally so you never have to focus the window. The whole point is
// to walk with the laptop half-closed in one arm and still be able to test.
function registerHotkeys(hotkeys) {
  globalShortcut.unregisterAll();
  const failures = [];

  const bind = (accelerator, action) => {
    if (!accelerator) return;
    try {
      const ok = globalShortcut.register(accelerator, () => send('hotkey', { action }));
      if (!ok) failures.push({ action, accelerator });
    } catch {
      failures.push({ action, accelerator });
    }
  };

  bind(hotkeys.run, 'run');
  bind(hotkeys.next, 'next');
  bind(hotkeys.prev, 'prev');
  bind(hotkeys.undo, 'undo');

  if (failures.length) send('hotkey-conflict', failures);
  return failures;
}

// ---------------------------------------------------------------------------
// Keep-awake
// ---------------------------------------------------------------------------

// A survey is a sequence of walks with the lid moving; letting the machine
// sleep mid-walk loses the Wi-Fi association and poisons the next reading.
function setKeepAwake(enabled) {
  if (enabled && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!enabled && powerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
  version: displayVersion(),
  fullVersion: app.getVersion(),
  platform: process.platform,
  profiles: Object.entries(PROFILES).map(([key, p]) => ({
    key,
    label: p.label,
    downloadMs: p.downloadMs,
    uploadMs: p.uploadMs,
  })),
  dataDir: store.dataDir(),
}));

ipcMain.handle('settings:get', () => store.loadSettings());

ipcMain.handle('settings:set', (_evt, patch) => {
  const merged = store.saveSettings(patch);
  if (patch.hotkeys) registerHotkeys(merged.hotkeys);
  if (Object.prototype.hasOwnProperty.call(patch, 'keepAwake')) setKeepAwake(merged.keepAwake);
  return merged;
});

ipcMain.handle('session:get', () => store.loadSession());
ipcMain.handle('session:save', (_evt, session) => store.saveSession(session));

ipcMain.handle('speedtest:run', async (_evt, { profile, captureWifi, captureMeta, maxMbPerTest, endpoints }) => {
  // One test at a time. A second overlapping test would contend for the same
  // radio and both readings would be wrong.
  if (activeRun) return { busy: true };

  const controller = new AbortController();
  activeRun = { controller };

  try {
    // Wi-Fi details are collected concurrently: system_profiler takes a second
    // or two on macOS and there is no reason to make the user wait for it.
    const netPromise = captureWifi ? getNetInfo() : Promise.resolve(null);

    const result = await runTest({
      profileName: profile,
      signal: controller.signal,
      includeMeta: captureMeta,
      maxMbPerTest,
      endpoints,
      onProgress: (p) => send('speedtest:progress', p),
    });

    result.wifi = await netPromise;
    return { busy: false, result };
  } finally {
    activeRun = null;
  }
});

ipcMain.handle('speedtest:cancel', () => {
  if (activeRun) {
    activeRun.controller.abort();
    return true;
  }
  return false;
});

ipcMain.handle('netinfo:get', () => getNetInfo());

ipcMain.handle('floorplan:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a floor plan image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const stored = store.importFloorplan(res.filePaths[0]);
  return { file: stored, dataUrl: store.readFloorplanDataUrl(stored) };
});

ipcMain.handle('floorplan:read', (_evt, filePath) => {
  try {
    return store.readFloorplanDataUrl(filePath);
  } catch {
    return null;
  }
});

// Drag-and-drop hands the renderer a path; import it the same way as the picker
// so the file is copied into userData and the survey stays self-contained.
ipcMain.handle('floorplan:import', (_evt, sourcePath) => {
  try {
    const stored = store.importFloorplan(sourcePath);
    return { file: stored, dataUrl: store.readFloorplanDataUrl(stored) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('export:save', async (_evt, { defaultName, contents, encoding }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export survey',
    defaultPath: defaultName,
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    if (encoding === 'base64') {
      fs.writeFileSync(res.filePath, Buffer.from(contents, 'base64'));
    } else {
      fs.writeFileSync(res.filePath, contents, 'utf8');
    }
    return { canceled: false, path: res.filePath };
  } catch (err) {
    return { canceled: false, error: err.message };
  }
});

ipcMain.handle('shell:reveal', (_evt, filePath) => {
  shell.showItemInFolder(filePath);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// A second instance would fight over the same global hotkeys and the same
// session file, so hand off to the window that already exists.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const settings = store.loadSettings();
    createWindow();
    registerHotkeys(settings.hotkeys);
    setKeepAwake(settings.keepAwake);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    setKeepAwake(false);
  });
}
