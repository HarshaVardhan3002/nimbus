'use strict';
/**
 * Nimbus — main process.
 *
 * Responsibilities kept here: app lifecycle, window ownership, IPC, the STT
 * queue and the feature runner. Everything else is a module.
 */

const { app, BrowserWindow, ipcMain, globalShortcut, session, desktopCapturer, screen } = require('electron');

const store = require('./src/store');
const providers = require('./src/providers');
const win32 = require('./src/native/win32');
const { WindowManager } = require('./src/windows/manager');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM, testConnection } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { WarmthKeeper } = require('./src/warmth');
const { PushToTalk } = require('./src/pushtotalk');
const history = require('./src/history');

const DEV = !!process.env.CUE_DEV;
const log = (...a) => { if (DEV) console.log('[nimbus]', ...a); };

// Single instance. Two overlays fighting over the same global shortcuts and
// the same settings file is never what anyone wants.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let wm = null;
let warmth = null;
let ptt = null;
let convo = null;     // the conversation currently on screen (Electron owns `session`)

const state = {
  listening: false,
  busy: false,
  sttFailures: 0,
  sttMuted: false,     // set after repeated failures so we stop spamming notices

  // ---- microphone gate ----
  micOpen: false,      // the merged answer: is the mic feeding the model right now
  micClosedAt: 0,      // when it last closed, for the release grace window
  keyHeld: false,      // the global hold-to-talk chord
  buttonHeld: false    // the pill's talk button
};

/**
 * How long after the talk key is released a 'you' utterance is still accepted.
 *
 * The VAD emits an utterance when the speaker STOPS, and a user lets go of the
 * key at roughly the same moment -- often a few hundred ms earlier, because the
 * hangover has not elapsed yet. Without this window the last sentence of every
 * push-to-talk turn would be transcribed and then thrown away by the very guard
 * meant to protect it.
 */
const MIC_RELEASE_GRACE_MS = 2500;

const transcript = [];        // { channel, text, ts }
const MAX_TRANSCRIPT = 400;

let sttQueue = Promise.resolve();
let abortController = null;

// ---------------------------------------------------------------- helpers
function broadcast(channel, data) { if (wm) wm.broadcast(channel, data); }
function toPanel(channel, data) { if (wm) wm.sendToPanel(channel, data); }
function notify(message, level) { broadcast('status', { message, level: level || 'info' }); }

// ---------------------------------------------------------------- mic gate
/**
 * Who decides whether the microphone is feeding the model.
 *
 * Three inputs -- the configured mode, the global hold-to-talk chord, and the
 * pill's talk button -- collapse to ONE boolean here, in the main process. The
 * renderer applies it to the worklet and the STT intake enforces it, so the
 * question "was the mic open when this audio was captured" has a single answer
 * rather than two that can disagree.
 */
function micModeOf() {
  return ((store.getSettings().audio || {}).micMode) || 'ptt';
}

function updateMicGate() {
  const mode = micModeOf();
  const want = state.listening && (
    mode === 'always' ? true
      : mode === 'off' ? false
        : (state.keyHeld || state.buttonHeld)
  );
  if (want === state.micOpen) return;
  state.micOpen = want;
  if (!want) state.micClosedAt = Date.now();
  broadcast('mic:gate', { open: want, mode });
  log('mic gate', want ? 'open' : 'closed', '(' + mode + ')');
}

/** Bring the hold-to-talk poller in line with the current settings. */
function syncPushToTalk() {
  if (!ptt) return;
  const s = store.getSettings();
  ptt.bind((s.shortcuts || {}).talk || 'Control+Alt+Space');
  // Poll only when it could matter: listening, and the mic on push-to-talk.
  if (state.listening && micModeOf() === 'ptt') ptt.start();
  else ptt.stop();
  updateMicGate();
}

// ---------------------------------------------------------------- STT
/**
 * One utterance in, one transcription out.
 *
 * Serialised through a promise chain rather than fired in parallel: a local
 * Whisper server is usually single-slot, and three concurrent requests to it
 * queue internally anyway while burning three timeouts. Ordering also matters
 * for the transcript to read correctly.
 */
function enqueueUtterance(channel, pcm) {
  sttQueue = sttQueue.then(() => transcribeOne(channel, pcm)).catch((e) => {
    console.error('[nimbus] stt queue error:', e && e.message);
  });
}

async function transcribeOne(channel, pcm) {
  const settings = store.getSettings();
  const stt = createSTT(settings);
  if (!stt.available) return;

  const res = await stt.transcribe(pcm);

  if (res.error) {
    state.sttFailures++;
    // Surface the first failure, then go quiet. The old build set a permanent
    // disable flag on the first error, which meant starting the local server
    // after Nimbus required an app restart.
    if (state.sttFailures === 1) notify(res.error.message, 'error');
    if (state.sttFailures >= 5 && !state.sttMuted) {
      state.sttMuted = true;
      notify('Transcription has failed repeatedly. Check the engine in Settings.', 'error');
    }
    return;
  }

  state.sttFailures = 0;
  state.sttMuted = false;

  const text = (res.text || '').trim();
  if (!text) return;

  const turn = { channel, text, ts: Date.now() };
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT) transcript.splice(0, transcript.length - MAX_TRANSCRIPT);
  broadcast('transcript', turn);
  log('transcript', channel, text);

  maybeWake(text, channel);
}

/**
 * Wake word.
 *
 * This matches on the transcript, not on the raw audio, so it costs no extra
 * model and works with any STT backend. The tradeoff is honest: it only fires
 * after an utterance completes and transcribes, so it is roughly as fast as the
 * STT round trip rather than instant. A true always-on KWS (openWakeWord,
 * Porcupine) would need its own model running per-frame in the worklet; the
 * VAD's _classify() hook is the place that would slot into.
 */
function maybeWake(text, channel) {
  const s = store.getSettings();
  const a = s.audio || {};
  if (!a.wakeWordEnabled || channel !== 'you') return;
  const phrase = (a.wakeWord || '').trim().toLowerCase();
  if (!phrase) return;
  const said = text.toLowerCase();
  if (!said.includes(phrase)) return;

  const after = said.split(phrase).slice(1).join(phrase).trim();
  if (wm) wm.openPanel({ focus: false });
  if (a.autoRespondOnWake !== false) {
    runFeature(after ? 'ask' : 'assist', after);
  }
}

// ---------------------------------------------------------------- features
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) { log('unknown mode', mode); return; }

  state.busy = true;
  abortController = new AbortController();

  try {
    const settings = store.getSettings();
    // Resolve through the tier's own route, not a global provider.
    const llm = createLLM(settings, settings.smart ? 'smart' : 'fast');

    if (wm) wm.openPanel({ focus: false });

    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    broadcast('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      broadcast('llm:error', { message: llm.reason || 'No model configured.' });
      return;
    }

    let imageDataUrl = null;
    let activeLLM = llm;

    if (def.needsScreen) {
      /**
       * Vision hand-off.
       *
       * If the tier's model cannot accept an image, look for a configured
       * vision route and send THIS request there instead of dropping the
       * screenshot. That keeps a fast text-only local model as the default
       * while screen questions still get answered by something that can see.
       */
      if (!llm.vision) {
        const vr = (settings.routes || {}).vision || {};
        if (vr.provider && (vr.model || '').trim()) {
          const vlm = createLLM(settings, 'vision');
          if (vlm.ready && vlm.vision) {
            activeLLM = vlm;
            notify('Screen question routed to ' + vlm.label + ' / ' + vlm.model + ' for vision.', 'info');
          }
        }
      }

      if (!activeLLM.vision) {
        notify('"' + activeLLM.model + '" is text-only, so no screenshot was attached. Set a Vision route in Settings, or tick "Model can see images".', 'warn');
      } else {
        try {
          imageDataUrl = await captureScreenshot();
          if (!imageDataUrl) notify('Screen capture returned nothing.', 'warn');
        } catch (e) {
          notify('Screen capture failed: ' + ((e && e.message) || e), 'warn');
        }
      }
    }

    const built = def.build({
      transcript,
      userText: userText || '',
      targetLang: (settings.stt && settings.stt.targetLang) || 'English'
    });

    /**
     * Conversation context.
     *
     * Prior turns go in front of the new one so follow-ups resolve. Without
     * this, "explain that differently" has no referent and the model answers a
     * question nobody asked.
     *
     * Only `ask` and `screenshot` are conversational. The one-shot modes
     * (assist, recap, translate) are commands about the CURRENT screen or
     * transcript, and feeding them history makes them answer stale questions.
     */
    const conversational = mode === 'ask' || mode === 'screenshot';
    if (!convo) convo = history.create(userText || def.userBubble || 'Conversation');
    const prior = conversational
      ? history.contextTurns(convo, (settings.history || {}).contextTurns)
      : [];
    const turns = prior.concat([{ role: 'user', text: built }]);

    history.append(convo, 'user', userBubble || userText || def.userBubble || '(action)', { mode });

    const askedAt = Date.now();
    let sawFirstToken = false;

    const full = await activeLLM.stream({
      system: def.system,
      turns,
      imageDataUrl,
      signal: abortController.signal,
      maxTokens: Math.max(256, ((settings.reply || {}).maxTokens) || 4096),
      /**
       * A reasoning model can think for tens of seconds before it writes a
       * single word of answer. Forwarding the reasoning channel is what keeps
       * that from looking like a hang -- and it is the same data that used to
       * be dropped on the floor, producing an empty bubble. See src/llm.js.
       */
      onReasoning: (t) => {
        if (!sawFirstToken) {
          sawFirstToken = true;
          if (warmth) warmth.recordTTFT(activeLLM.provider, activeLLM.model, Date.now() - askedAt);
        }
        broadcast('llm:reasoning', { text: t });
      },
      onToken: (t) => {
        if (!sawFirstToken) {
          sawFirstToken = true;
          // Real user-facing TTFT, fed back so the model picker can show what
          // is actually fast on this machine instead of guessing from size.
          if (warmth) warmth.recordTTFT(activeLLM.provider, activeLLM.model, Date.now() - askedAt);
        }
        broadcast('llm:token', { text: t });
      },
      onNotice: (n) => {
        notify(n.message, n.level || 'info');
        /**
         * The retry just proved this model cannot take an image. Persist that
         * so the next screen question skips the screenshot instead of paying
         * for the same failed round trip again.
         *
         * Only ever flips the flag OFF. Turning it back on is a user decision,
         * because a single success does not prove capability.
         */
        if (n.visionFailed && n.provider) {
          const cur = store.getSettings();
          const models = Object.assign({}, (cur.models || {})[n.provider], { vision: false });
          const next = store.setSettings({ models: { [n.provider]: models } });
          broadcast('settings:changed', next);
        }
      }
    });

    if (typeof full === 'string' && full.trim()) {
      history.append(convo, 'assistant', full, {
        model: activeLLM.model, provider: activeLLM.provider, tier: activeLLM.tier
      });
    }
    history.save(convo);
    broadcast('history:changed', { id: convo.id, title: convo.title });

    broadcast('llm:done', {});
  } catch (e) {
    if (e && e.aborted) broadcast('llm:done', {});
    else broadcast('llm:error', { message: (e && e.message) || String(e) });
  } finally {
    state.busy = false;
    abortController = null;
  }
}

// ---------------------------------------------------------------- IPC
function registerIPC() {
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = store.setSettings(patch);
    // Reset the STT backoff whenever settings change: the user may have just
    // fixed the thing that was failing.
    state.sttFailures = 0;
    state.sttMuted = false;
    // Same reasoning for discovery: a cached model list from before the edit
    // would report the old endpoint's answer for the new one.
    providers.clearDiscoveryCache();
    // The mic mode and the talk chord both live in settings, so every save is a
    // chance that the gate's inputs just changed underneath it.
    syncPushToTalk();
    broadcast('settings:changed', next);
    return next;
  });

  ipcMain.handle('providers:list', () => {
    const s = store.getSettings();
    // Fold any user rename into the label the UI shows.
    return providers.list(s).map((p) => ({ ...p, label: providers.labelOf(s, p.id) }));
  });

  /**
   * Settings that can be applied without a restart do so here; the renderer
   * asks for a relaunch only for the ones that genuinely cannot.
   */
  ipcMain.handle('ui:apply', (_e, patch) => {
    const s = store.getSettings();
    const applied = [];
    const needsRestart = [];

    const glass = (patch && patch.glass) || (s.ui || {}).glass;
    if (wm && glass && glass !== wm.glassMode) { wm.applyGlass(glass); applied.push('glass'); }

    /**
     * Screen-capture hiding no longer needs a relaunch.
     *
     * It was constructor-time only when this handler was written, so Apply
     * reported "screen-capture hiding needs a relaunch" whenever the checkbox
     * differed from the window state. WindowManager.applyStealth() has since
     * made it a syscall on a live HWND, so the message was telling users to
     * restart for something that had already taken effect. Apply it instead.
     */
    if (wm && patch && typeof patch.stealth === 'boolean' && patch.stealth !== !!wm.stealth) {
      wm.applyStealth(patch.stealth);
      applied.push('screen-capture hiding');
    }
    return { applied, needsRestart };
  });

  ipcMain.handle('app:relaunch', () => {
    store.flush();          // never lose a debounced write across a restart
    app.relaunch();
    app.exit(0);
    return true;
  });
  // `force` comes from the Refresh button: a refresh that can return a cached
  // answer is not a refresh. Ordinary UI re-reads leave it unset and hit cache.
  ipcMain.handle('providers:discover', (_e, id, opts) =>
    providers.discoverModels(store.getSettings(), id, { force: !!(opts && opts.force) }));

  /**
   * One button that answers "is this provider actually usable?".
   *
   * Model discovery only proves the endpoint answers a GET; it says nothing
   * about whether the key can generate or whether the chosen model exists.
   */
  ipcMain.handle('providers:test', async (_e, id) => {
    try {
      return await testConnection(store.getSettings(), id);
    } catch (e) {
      return { ok: false, level: 'error', message: (e && e.message) || String(e) };
    }
  });

  /**
   * Model discovery for the transcription endpoint.
   *
   * Reuses the chat discovery by synthesising a throwaway provider pointed at
   * the STT base URL, so speech servers get the same capability classification
   * (Lemonade tags Whisper with `transcription`) instead of a bare text field
   * the user has to type an exact checkpoint name into.
   */
  ipcMain.handle('stt:discover', async () => {
    const s = store.getSettings();
    const cfg = s.stt || {};
    if ((cfg.provider || 'local') !== 'local') {
      return { ok: false, error: 'Model discovery only applies to a local/self-hosted server.', models: [] };
    }
    if (!cfg.localBaseURL) return { ok: false, error: 'Set the transcription server URL first.', models: [] };
    const shim = {
      ...s,
      provider: '__stt__',
      customProviders: [{ id: '__stt__', label: 'transcription', baseURL: cfg.localBaseURL, needsKey: false, local: true }],
      models: { ...(s.models || {}), __stt__: { fast: 'x', smart: 'x', baseURL: cfg.localBaseURL } }
    };
    return providers.discoverModels(shim, '__stt__');
  });
  /**
   * Build identity.
   *
   * Exists because a packaged build is a FROZEN COPY of the source. Running
   * `dist/win-unpacked/Nimbus.exe` after editing the source silently tests
   * hour-old code, and nothing in the UI said so -- which cost a full debugging
   * round trip chasing a bug that had already been fixed. Now the build stamp
   * is on screen, and a packaged build older than the source is called out.
   */
  /**
   * Stealth is now live-togglable and self-verifying.
   *
   * Previously it was constructor-time only, so the toggle needed a restart and
   * the UI could claim protection that was never actually applied.
   */
  ipcMain.handle('stealth:set', (_e, on) => {
    const next = store.setSettings({ ui: { privacy: !!on } });
    const res = wm ? wm.applyStealth(!!on) : {};
    broadcast('settings:changed', next);
    return { applied: res, status: wm ? wm.stealthStatus() : null };
  });

  ipcMain.handle('stealth:status', () => (wm ? wm.stealthStatus() : { enabled: false, verified: false }));

  // ---- conversation history ----
  ipcMain.handle('history:list', () => history.list());
  ipcMain.handle('history:search', (_e, q) => history.search(q));
  ipcMain.handle('history:load', (_e, id) => {
    const s = history.load(id);
    if (s) { convo = s; broadcast('history:opened', s); }
    return s;
  });
  ipcMain.handle('history:new', () => {
    convo = null;     // created lazily on the next message, so empty sessions never persist
    broadcast('history:opened', { id: null, title: 'New conversation', messages: [] });
    return true;
  });
  ipcMain.handle('history:delete', (_e, id) => {
    history.remove(id);
    if (convo && convo.id === id) convo = null;
    return true;
  });
  ipcMain.handle('history:clear', () => { history.clearAll(); convo = null; return true; });
  ipcMain.handle('history:current', () => convo);

  ipcMain.handle('app:info', () => {
    const appPath = app.getAppPath();
    let builtAt = null;
    try { builtAt = require('fs').statSync(appPath).mtime.getTime(); } catch { /* ignore */ }
    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      electron: process.versions.electron,
      builtAt,
      appPath
    };
  });

  ipcMain.handle('warmth:status', () => {
    const s = store.getSettings();
    // Resolved through the ACTIVE ROUTE. Reading s.provider / s.models here was
    // left over from the single-provider shape, so the reported TTFT belonged to
    // whichever provider happened to be in the legacy slot rather than to the
    // model that is actually going to answer.
    const active = providers.resolveTier(s, s.smart ? 'smart' : 'fast');
    return {
      ...(warmth ? warmth.status() : { enabled: false }),
      switchWarning: warmth ? warmth.switchWarning(s) : null,
      provider: active ? active.id : null,
      model: active ? active.model : null,
      ttft: (warmth && active) ? warmth.getTTFT(active.id, active.model) : null
    };
  });

  ipcMain.handle('warmth:set', (_e, on) => {
    const next = store.setSettings({ warmth: { enabled: !!on } });
    if (warmth) { if (on) warmth.start(); else warmth.stop(); }
    broadcast('settings:changed', next);
    return !!on;
  });

  ipcMain.handle('native:status', () => ({
    ...win32.status(),
    // Included here rather than left to the 'glass:changed' broadcast alone:
    // that broadcast fires from ready-to-show, which can land before the
    // renderer has registered its listener, leaving the document without the
    // class that supplies its entire background.
    glass: wm ? wm.glassMode : 'shaped',
    systemCorners: wm ? (wm.glassMode === 'acrylic' || wm.glassMode === 'blur') : false,
    /**
     * 'hold' | 'latch' | 'unbound'. Reported because the two are genuinely
     * different controls: without the native layer there is no key-up event to
     * be had, and the chord becomes press-to-open / press-again-to-close. The
     * settings screen says which one the user actually has.
     */
    pushToTalk: ptt ? ptt.mode : 'unbound'
  }));
  ipcMain.handle('display:info', () => ({
    availableHeight: wm ? wm.availableHeight() : 800,
    scaleFactor: screen.getPrimaryDisplay().scaleFactor || 1
  }));

  ipcMain.on('ask', (_e, payload) => runFeature(payload && payload.mode, payload && payload.text));
  ipcMain.on('ask:abort', () => { if (abortController) abortController.abort(); });

  ipcMain.on('audio:utterance', (_e, meta, buffer) => {
    if (!state.listening || !buffer) return;
    const channel = (meta && meta.channel) || 'you';

    /**
     * Second gate, deliberately redundant with the worklet's.
     *
     * The worklet already discards mic audio while the gate is closed, so this
     * should never fire. It is here because "the mic was not open, therefore the
     * model never heard it" is the promise the whole feature makes, and a
     * promise enforced in one place is enforced until the next refactor moves
     * that place.
     */
    if (channel === 'you' && !state.micOpen) {
      const sinceRelease = Date.now() - state.micClosedAt;
      if (sinceRelease > MIC_RELEASE_GRACE_MS) {
        log('dropped mic utterance: gate closed', sinceRelease + 'ms ago');
        return;
      }
    }

    enqueueUtterance(channel, Buffer.from(buffer));
  });

  ipcMain.on('listen:state', (_e, active) => {
    state.listening = !!active;
    // A turn is now imminent; make sure the model is resident before the user
    // finishes their first sentence.
    if (active && warmth) warmth.poke();
    if (!active) {
      state.sttFailures = 0;
      state.sttMuted = false;
      state.keyHeld = false;
      state.buttonHeld = false;
    }
    syncPushToTalk();
  });

  ipcMain.on('mic:hold', (_e, on) => {
    state.buttonHeld = !!on;
    updateMicGate();
  });

  ipcMain.on('ui:pill-size', (_e, { w, h }) => { if (wm) wm.setPillSize(w, h); });
  ipcMain.on('ui:panel-size', (_e, { w, h }) => { if (wm) wm.setPanelSize(w, h); });
  ipcMain.on('ui:toggle-panel', (_e, opts) => { if (wm) wm.togglePanel(opts || {}); });
  ipcMain.on('ui:drag-start', () => { if (wm) wm.startDrag(); });
  ipcMain.on('ui:drag-end', () => { if (wm) wm.endDrag(); });
  ipcMain.on('ui:open-settings', () => {
    if (!wm) return;
    wm.openPanel({ focus: true });
    toPanel('open-settings', {});
  });
  ipcMain.on('app:quit', () => { store.flush(); app.quit(); });
  ipcMain.on('ui:menu-open', (_e, open) => { if (wm) wm.setMenuOpen(open); });
  ipcMain.on('ui:status', (_e, p) => broadcast('status', p || {}));
  ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
}

// ---------------------------------------------------------------- shortcuts
function registerShortcuts() {
  const s = store.getSettings().shortcuts || {};
  const bind = (accel, fn) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) {
        console.warn('[nimbus] shortcut already taken by another app:', accel);
      }
    } catch (e) {
      console.warn('[nimbus] bad shortcut', accel, e && e.message);
    }
  };

  bind(s.assist || 'Control+Return', () => runFeature('assist', ''));
  bind(s.solve || 'Control+H', () => runFeature('solve', ''));
  bind(s.toggle || 'Control+Shift+Space', () => {
    if (!wm) return;
    const open = wm.togglePanel({ focus: true });
    if (open) toPanel('panel:focus-input', {});
  });
  bind(s.listen || 'Control+Shift+L', () => broadcast('listen:request', {}));
  /**
   * `shortcuts.talk` is deliberately NOT bound here. Hold-to-talk needs key-up,
   * which globalShortcut does not have, so src/pushtotalk.js owns that chord --
   * either by polling GetAsyncKeyState or, with no native layer, by registering
   * it itself as a latch. Binding it here as well would race that registration.
   */
  // Fallback matches the store default. It used to be Control+Shift+X, which is
  // the accelerator store.js v3 deliberately migrated AWAY from because it is
  // commonly already taken -- so the fallback reintroduced the exact bug.
  bind(s.quit || 'Control+Alt+Shift+Q', () => { store.flush(); app.quit(); });
}

// ---------------------------------------------------------------- lifecycle
app.on('second-instance', () => { if (wm) wm.openPanel({ focus: true }); });

// GPU rasterisation and zero-copy matter more than usual here: the panel is a
// transparent, always-composited surface sitting on top of DWM acrylic.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

app.whenReady().then(() => {
  const allowMedia = (p) =>
    p === 'media' || p === 'microphone' || p === 'audioCapture' || p === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(allowMedia(p)));
  session.defaultSession.setPermissionCheckHandler((_wc, p) => allowMedia(p));

  /**
   * System-audio loopback.
   *
   * Handing back a screen source with audio:'loopback' lets the renderer
   * capture whatever is playing through the default output device using Nimbus's
   * own grant, with no virtual audio cable. This is the path that makes
   * "translate the video I am watching" work, and unlike macOS it needs no
   * third-party driver on Windows.
   */
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (sources.length) callback({ video: sources[0], audio: 'loopback' });
        else callback();
      })
      .catch(() => callback());
  }, { useSystemPicker: false });

  const nat = win32.status();
  if (!nat.available) {
    console.warn('[nimbus] native window effects unavailable:', nat.error);
    console.warn('[nimbus] falling back to CSS glass. Acrylic, region clipping and Alt-Tab exclusion are off.');
  }

  registerIPC();

  wm = new WindowManager({
    stealth: !!((store.getSettings().ui || {}).privacy),
    onEvent: (channel, data) => {
      if (channel === 'pill:moved') {
        store.setSettings({ ui: { pillPosition: { x: data.x, y: data.y } } });
        return;
      }
      broadcast(channel, data);
    }
  }).create();

  const ui0 = store.getSettings().ui || {};
  if (ui0.glass) wm.glassMode = ui0.glass;

  const saved = ui0.pillPosition;
  if (saved) setTimeout(() => wm.restorePosition(saved), 120);

  warmth = new WarmthKeeper({
    getSettings: () => store.getSettings(),
    onEvent: (ch, data) => broadcast(ch, data)
  });
  if ((store.getSettings().warmth || {}).enabled !== false) warmth.start();

  ptt = new PushToTalk({
    onChange: (down) => { state.keyHeld = down; updateMicGate(); }
  });
  syncPushToTalk();

  registerShortcuts();

  // A resolution change, a DPI change or docking a laptop all invalidate the
  // panel's layout caps and every window region, which are computed in device
  // pixels from a scale factor that just changed underneath them.
  const onDisplayChange = () => {
    if (!wm) return;
    wm.refreshRegions();
    wm.broadcast('display:changed', { availableHeight: wm.availableHeight() });
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) wm.create(); });
});

app.on('will-quit', () => {
  if (warmth) warmth.stop();
  if (ptt) ptt.stop();
  globalShortcut.unregisterAll();
  store.flush();          // debounced writes must not be lost on exit
  if (wm) wm.destroy();
});

// The pill is the app. Closing a window is not closing Nimbus, and on Windows
// there is no dock to return from.
app.on('window-all-closed', () => app.quit());
