'use strict';
/**
 * Preload bridge. Both windows share it.
 *
 * Every channel is explicitly allowlisted in both directions. contextIsolation
 * stays on and nodeIntegration stays off, so the renderers never touch require().
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Channels a renderer may listen on. The check script reads this array
 * literally, so it holds names and nothing else -- notes go here instead.
 *
 * 'transcript'        every utterance, for the pill's ticker.
 * 'transcript:stage'  the user's own speech, staged in the composer unsent.
 * 'transcript:heard'  system speech, written into the chat as a turn.
 * 'stt:engine'        install progress and health of the managed local engine.
 * 'focus:mode'        whether the panel currently holds the keyboard.
 */
const INBOUND = [
  'panel:state',
  'llm:start',
  'llm:token',
  'llm:reasoning',
  'llm:done',
  'llm:error',
  'status',
  'transcript',
  'transcript:stage',
  'transcript:heard',
  'audio:digest',
  'stt:engine',
  'context:usage',
  'compact:state',
  'compact:done',
  'compact:advice',
  'settings:changed',
  'listen:request',
  'mic:gate',
  'panel:focus-input',
  'focus:mode',
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
  discoverModels: (id, opts) => ipcRenderer.invoke('providers:discover', id, opts),
  testProvider: (id) => ipcRenderer.invoke('providers:test', id),
  discoverSttModels: () => ipcRenderer.invoke('stt:discover'),

  // ---- the managed local transcription engine ----
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  engineInstall: (opts) => ipcRenderer.invoke('engine:install', opts),
  engineStop: () => ipcRenderer.invoke('engine:stop'),
  engineProbe: () => ipcRenderer.invoke('engine:probe'),

  nativeStatus: () => ipcRenderer.invoke('native:status'),
  displayInfo: () => ipcRenderer.invoke('display:info'),
  applySettings: (patch) => ipcRenderer.invoke('ui:apply', patch),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // ---- history ----
  historyList: (opts) => ipcRenderer.invoke('history:list', opts),
  historySearch: (q) => ipcRenderer.invoke('history:search', q),
  historyCount: () => ipcRenderer.invoke('history:count'),
  historyRename: (id, title) => ipcRenderer.invoke('history:rename', id, title),
  historyLoad: (id) => ipcRenderer.invoke('history:load', id),
  historyNew: () => ipcRenderer.invoke('history:new'),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyCurrent: () => ipcRenderer.invoke('history:current'),
  contextUsage: () => ipcRenderer.invoke('context:get'),
  compactNow: () => ipcRenderer.invoke('context:compact'),
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
  /**
   * The VAD's opinion of whether a channel is carrying speech RIGHT NOW.
   *
   * Sent as well as the utterance, not instead of it. An utterance only lands
   * when the speaker stops or the 15s cap cuts them off, so anything that waits
   * for utterances to judge silence concludes that unbroken narration is silent
   * for two thirds of its length.
   */
  speech: (channel, active) => ipcRenderer.send('audio:speech', { channel, active: !!active }),
  listenState: (active) => ipcRenderer.send('listen:state', active),
  /**
   * The pill's talk button, held. Merged in main with the global hold-to-talk
   * key so the mic gate has one owner and one answer.
   */
  micHold: (on) => ipcRenderer.send('mic:hold', !!on),

  // ---- window ----
  pillSize: (w, h) => ipcRenderer.send('ui:pill-size', { w, h }),
  panelSize: (w, h) => ipcRenderer.send('ui:panel-size', { w, h }),
  togglePanel: (opts) => ipcRenderer.send('ui:toggle-panel', opts || {}),
  dragStart: () => ipcRenderer.send('ui:drag-start'),
  dragEnd: () => ipcRenderer.send('ui:drag-end'),
  openSettings: () => ipcRenderer.send('ui:open-settings'),
  /**
   * Ask for the keyboard, and hand it back.
   *
   * The windows do not activate on click, so a text field in the panel is not
   * typeable until main is told to take focus -- and the window the focus was
   * borrowed from gets it back on release.
   */
  requestFocus: () => ipcRenderer.send('ui:focus-input'),
  releaseFocus: () => ipcRenderer.send('ui:release-focus'),
  quit: () => ipcRenderer.send('app:quit'),
  // The pill's menu paints outside the pill, so the window must grow to
  // contain it -- the region clip would otherwise slice it off.
  menuOpen: (open, rect) => ipcRenderer.send('ui:menu-open', { open: !!open, rect: rect || null }),

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
