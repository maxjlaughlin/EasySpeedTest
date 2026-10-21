'use strict';

// The renderer gets this narrow surface and nothing else: context isolation is
// on and node integration is off, so there is no path from UI code to the file
// system except the handlers enumerated here.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel) => (callback) => {
  const wrapped = (_evt, payload) => callback(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('api', {
  // True only under the smoke-test harness; gates the renderer's test seam.
  smoke: !!process.env.EST_SMOKE,

  appInfo: () => ipcRenderer.invoke('app:info'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  getSession: () => ipcRenderer.invoke('session:get'),
  saveSession: (session) => ipcRenderer.invoke('session:save', session),

  runTest: (opts) => ipcRenderer.invoke('speedtest:run', opts),
  cancelTest: () => ipcRenderer.invoke('speedtest:cancel'),
  netInfo: () => ipcRenderer.invoke('netinfo:get'),

  // Electron 32 removed File.path, so a dropped file's real path has to come
  // from webUtils here in the preload rather than from the renderer.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  pickFloorplan: () => ipcRenderer.invoke('floorplan:pick'),
  importFloorplan: (sourcePath) => ipcRenderer.invoke('floorplan:import', sourcePath),
  readFloorplan: (filePath) => ipcRenderer.invoke('floorplan:read', filePath),

  saveExport: (payload) => ipcRenderer.invoke('export:save', payload),
  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),

  onHotkey: listen('hotkey'),
  onProgress: listen('speedtest:progress'),
  onHotkeyConflict: listen('hotkey-conflict'),
});
