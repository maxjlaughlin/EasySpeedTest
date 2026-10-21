'use strict';

// Session + settings persistence.
//
// Everything lives as plain JSON under the Electron userData directory, so a
// survey survives a crash or a quit mid-walk. Writes are atomic (temp file plus
// rename) because the most likely moment to lose power is while walking around
// a building with an unplugged laptop.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SCHEMA_VERSION = 1;

function dataDir() {
  return app.getPath('userData');
}

function floorplanDir() {
  const dir = path.join(dataDir(), 'floorplans');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}

function sessionPath() {
  return path.join(dataDir(), 'session.json');
}

function writeAtomic(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, target);
}

function readJson(target, fallback) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return fallback;
  }
}

const DEFAULT_SETTINGS = {
  schemaVersion: SCHEMA_VERSION,
  profile: 'standard',
  hotkeys: {
    run: 'CommandOrControl+Shift+T',
    next: 'CommandOrControl+Shift+N',
    prev: 'CommandOrControl+Shift+B',
    undo: 'CommandOrControl+Shift+Z',
  },
  // The speed below which a point is flagged as a problem spot. Drives the
  // flagged ring on the map, which is what makes dead zones findable at a
  // glance instead of by reading every number.
  thresholdMbps: 50,
  // Per-test data budget. Keeps a long survey from moving tens of gigabytes on
  // a fast link; see speedtest.js for how the budget is split and enforced.
  maxMbPerTest: 300,
  // Override the test target, e.g. { download: 'http://nas.local:8080/__down', ... }.
  // A server on the same LAN measures the Wi-Fi rather than the ISP uplink.
  // No UI control for this yet - edit settings.json.
  endpoints: null,
  captureWifi: true,
  captureMeta: false,
  autoAdvance: true,
  stepFeet: 15,
  keepAwake: true,
};

function loadSettings() {
  const stored = readJson(settingsPath(), {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(stored.hotkeys || {}) },
  };
}

function saveSettings(settings) {
  const merged = { ...loadSettings(), ...settings, schemaVersion: SCHEMA_VERSION };
  writeAtomic(settingsPath(), JSON.stringify(merged, null, 2));
  return merged;
}

function emptySession() {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Untitled survey',
    createdAt: new Date().toISOString(),
    floorplan: null, // { file, width, height, scaleFeetPerPx }
    tests: [],
    waypoints: [],
    routeIndex: 0,
  };
}

function loadSession() {
  const stored = readJson(sessionPath(), null);
  if (!stored || !Array.isArray(stored.tests)) return emptySession();
  return { ...emptySession(), ...stored };
}

function saveSession(session) {
  writeAtomic(sessionPath(), JSON.stringify(session));
  return true;
}

// Floorplans are copied into userData rather than referenced in place, so a
// survey does not break when the original image is moved or the volume is
// unmounted.
function importFloorplan(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase() || '.png';
  const name = `floorplan-${Date.now()}${ext}`;
  const dest = path.join(floorplanDir(), name);
  fs.copyFileSync(sourcePath, dest);
  return dest;
}

function readFloorplanDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
        : 'image/png';
  const buf = fs.readFileSync(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

module.exports = {
  loadSettings,
  saveSettings,
  loadSession,
  saveSession,
  emptySession,
  importFloorplan,
  readFloorplanDataUrl,
  dataDir,
  DEFAULT_SETTINGS,
};
