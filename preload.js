'use strict';
/**
 * Preload bridge. Both windows share it.
 *
 * Every channel is explicitly allowlisted in both directions. contextIsolation
 * stays on and nodeIntegration stays off, so the renderers never touch require().
 */

const { contextBridge, ipcRenderer } = require('electron');

const INBOUND = [
  'panel:state',
  'llm:start',
  'llm:token',
  'llm:done',
  'llm:error',
  'status',
  'transcript',
  'settings:changed',
  'listen:request',
  'panel:focus-input',
  'open-settings',
  'display:changed',
  'glass:changed',
  'warmth:state',
  'warmth:loaded',
  'stealth:state',
  'history:changed',
  'history:opened'
];

contextBridge.exposeInMainWorld('nimbus', {
  platform: process.platform,

  // ---- settings + providers ----
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  providers: () => ipcRenderer.invoke('providers:list'),
  discoverModels: (id) => ipcRenderer.invoke('providers:discover', id),
  discoverSttModels: () => ipcRenderer.invoke('stt:discover'),
  nativeStatus: () => ipcRenderer.invoke('native:status'),
  displayInfo: () => ipcRenderer.invoke('display:info'),
  applySettings: (patch) => ipcRenderer.invoke('ui:apply', patch),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // ---- history ----
  historyList: () => ipcRenderer.invoke('history:list'),
  historySearch: (q) => ipcRenderer.invoke('history:search', q),
  historyLoad: (id) => ipcRenderer.invoke('history:load', id),
  historyNew: () => ipcRenderer.invoke('history:new'),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyCurrent: () => ipcRenderer.invoke('history:current'),
  setStealth: (on) => ipcRenderer.invoke('stealth:set', on),
  stealthStatus: () => ipcRenderer.invoke('stealth:status'),
  warmthStatus: () => ipcRenderer.invoke('warmth:status'),
  setWarmth: (on) => ipcRenderer.invoke('warmth:set', on),

  // ---- chat ----
  ask: (payload) => ipcRenderer.send('ask', payload),
  abort: () => ipcRenderer.send('ask:abort'),

  // ---- audio ----
  /**
   * A complete utterance, emitted by the VAD the moment the speaker stops.
   * The ArrayBuffer is passed as a separate argument so Electron's structured
   * clone moves the bytes rather than copying them through a JSON round-trip.
   */
  utterance: (meta, buffer) => ipcRenderer.send('audio:utterance', meta, buffer),
  listenState: (active) => ipcRenderer.send('listen:state', active),

  // ---- window ----
  pillSize: (w, h) => ipcRenderer.send('ui:pill-size', { w, h }),
  panelSize: (w, h) => ipcRenderer.send('ui:panel-size', { w, h }),
  togglePanel: (opts) => ipcRenderer.send('ui:toggle-panel', opts || {}),
  dragStart: () => ipcRenderer.send('ui:drag-start'),
  dragEnd: () => ipcRenderer.send('ui:drag-end'),
  openSettings: () => ipcRenderer.send('ui:open-settings'),
  quit: () => ipcRenderer.send('app:quit'),
  // The pill's menu paints outside the pill, so the window must grow to
  // contain it -- the region clip would otherwise slice it off.
  menuOpen: (open) => ipcRenderer.send('ui:menu-open', !!open),

  // ---- misc ----
  status: (payload) => ipcRenderer.send('ui:status', payload),
  log: (msg) => ipcRenderer.send('log', msg),

  on: (channel, cb) => {
    if (!INBOUND.includes(channel)) return () => {};
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
