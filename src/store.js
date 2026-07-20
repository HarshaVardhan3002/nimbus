'use strict';
/**
 * JSON settings store. Deliberately no native dependency so `npm install`
 * never needs a toolchain.
 *
 * Two changes from the old version beyond the new schema:
 *   - Writes are atomic (temp file + rename). The previous writeFileSync could
 *     leave a truncated cue-data.json if the process died mid-write, and the
 *     load path would then silently fall back to defaults, which looks exactly
 *     like "the app forgot my API keys".
 *   - Saves are debounced. Settings are written on every keystroke in the
 *     settings sheet.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Settings location.
 *
 * The app was renamed cue -> Nimbus, which moves Electron's userData directory
 * and would silently orphan every existing setting: API keys, routes, the
 * enrolled voiceprint. So the old location is checked once and carried over.
 */
const DIR = app.getPath('userData');
const FILE = path.join(DIR, 'nimbus-data.json');
const TMP = FILE + '.tmp';
const LEGACY = [
  path.join(DIR, 'cue-data.json'),
  path.join(path.dirname(DIR), 'cue', 'cue-data.json')
];

function adoptLegacy() {
  if (fs.existsSync(FILE)) return;
  for (const old of LEGACY) {
    try {
      if (old !== FILE && fs.existsSync(old)) {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.copyFileSync(old, FILE);
        console.log('[nimbus] adopted settings from', old);
        return;
      }
    } catch { /* a failed adopt just means defaults */ }
  }
}

const SCHEMA = 5;

const DEFAULTS = {
  schema: SCHEMA,

  // Legacy single-provider selection. Kept so an un-migrated file still
  // resolves, but `routes` is authoritative.
  provider: 'ollama',
  smart: false,

  /**
   * Per-tier routing. Each reasoning level binds its OWN provider and model,
   * so the app is not bound to one provider. See providers.resolveTier().
   */
  routes: {
    fast:  { provider: 'ollama', model: '' },
    smart: { provider: 'ollama', model: '' },
    /**
     * Optional. Used ONLY when a request carries an image and the active tier's
     * model cannot accept one. Lets a text-only chat model stay selected while
     * screen questions are handed to something that can actually see.
     */
    vision: { provider: '', model: '' }
  },
  onboarded: false,

  apiKeys: {
    openai: '', anthropic: '', gemini: '', nvidia: '', ollama: '', lmstudio: ''
  },

  // Per-provider model + capability overrides. baseURL here overrides the
  // registry default, which is how you point "ollama" at another machine.
  models: {
    openai:    { fast: 'gpt-4o-mini', smart: 'gpt-4o', vision: true },
    anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-5', vision: true },
    gemini:    { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro', vision: true },
    nvidia:    { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct', vision: true },
    ollama:    { fast: 'llama3.2', smart: 'qwen2.5:14b', vision: false, baseURL: 'http://127.0.0.1:11434/v1' },
    lmstudio:  { fast: '', smart: '', vision: false, baseURL: 'http://127.0.0.1:1234/v1' }
  },

  // [{ id, label, baseURL, needsKey, local, vision }]
  customProviders: [],

  stt: {
    // 'local' | 'openai' | 'gemini' | 'off'
    provider: 'local',
    // Any OpenAI-compatible /v1/audio/transcriptions server:
    // faster-whisper-server, whisper.cpp server, Speaches, LM Studio.
    localBaseURL: 'http://127.0.0.1:8000/v1',
    localModel: 'Systran/faster-whisper-base.en',
    remoteModel: 'whisper-1',
    language: 'en'
  },

  audio: {
    listenOnLaunch: false,
    captureMic: true,
    captureSystem: true,
    // Frame-level VAD. Values are in the 0..1 normalised-energy domain used by
    // renderer/vad-processor.js.
    vadThreshold: 0.010,
    // How long silence must persist before an utterance is considered finished.
    // Too low and you cut people off mid-sentence; too high and you add latency.
    silenceHangoverMs: 550,
    minUtteranceMs: 320,
    maxUtteranceMs: 15000,
    // Speech that starts before the trigger fires is still captured, so the
    // first syllable is not clipped.
    preRollMs: 300,
    wakeWord: 'hey nimbus',
    wakeWordEnabled: false,
    autoRespondOnWake: true
  },

  // Local single-slot servers unload the model on idle; measured 15s reload
  // after a 20s gap versus 622ms warm. See src/warmth.js.
  warmth: {
    enabled: true,
    intervalMs: 12000
  },

  history: {
    // Prior turns fed back to the model. Every turn is prompt the model must
    // re-read, so this trades follow-up quality against latency.
    contextTurns: 12
  },

  ui: {
    pillPosition: null,      // { x, y }; null = top centre of primary display
    textZoom: 1,
    // 'shaped' | 'acrylic' | 'blur' | 'off'
    //
    // Default is 'shaped', NOT acrylic. DWM paints its backdrop over the whole
    // window rectangle and ignores SetWindowRgn, so any real-blur mode shows a
    // square slab behind the rounded pill. Shape wins over blur by default
    // because the silhouette is the identity of the thing.
    glass: 'shaped',
    // 'obsidian' (near-black) | 'porcelain' (white). Surfaces are neutral in
    // both; colour in this app means state, not decoration.
    theme: 'obsidian',
    reduceMotion: false,
    /**
     * WDA_EXCLUDEFROMCAPTURE. Named `privacy`, not `stealth`.
     *
     * The point is not hiding from a person; it is keeping a teleprompter
     * script, live notes or a transcript out of an OBS recording, a Zoom share
     * or a Teams call. That is a privacy control over your own screen content,
     * and calling it stealth invited the wrong reading of the feature.
     */
    privacy: false
  },

  shortcuts: {
    assist: 'Control+Return',
    solve: 'Control+H',
    toggle: 'Control+Shift+Space',
    listen: 'Control+Shift+L',
    // Not Control+Shift+X: that is taken by default on many Windows setups and
    // registration silently loses to whoever grabbed it first.
    quit: 'Control+Alt+Shift+Q'
  }
};

let data = null;
let saveTimer = null;

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (isPlainObject(over[k]) && isPlainObject(base[k])) out[k] = deepMerge(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

function anyKey(d) {
  return Object.values(d.apiKeys || {}).some((v) => v && v.trim());
}

function load() {
  if (data) return data;
  adoptLegacy();
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { disk = {}; }

  /**
   * Migrations.
   *
   * deepMerge lets the saved file win over DEFAULTS, which is right for user
   * choices and wrong for a default we have since discovered to be broken. A
   * setting the user never deliberately chose should not be preserved forever
   * just because it was written to disk once.
   */
  const from = Number(disk.schema) || 1;
  if (from < 5) {
    // v5: ui.stealth renamed to ui.privacy. Carry the user's choice across.
    if (disk.ui && typeof disk.ui.stealth === 'boolean') {
      disk.ui.privacy = disk.ui.stealth;
      delete disk.ui.stealth;
    }
  }
  if (from < 4) {
    /**
     * v4: tiers become independent routes.
     *
     * Seed both routes from whatever single provider was configured, so the
     * behaviour after upgrading is identical to before and the user opts into
     * splitting them rather than being surprised by it.
     */
    const prov = disk.provider || 'ollama';
    const m = (disk.models || {})[prov] || {};
    disk.routes = disk.routes || {
      fast:  { provider: prov, model: (m.fast || '').trim() },
      smart: { provider: prov, model: (m.smart || '').trim() }
    };
  }
  if (from < 3) {
    // v3: Control+Shift+X is commonly already taken, so registration silently
    // lost. Drop the stored copy and let the new default apply.
    if (disk.shortcuts) delete disk.shortcuts.quit;
    // v3: stealth (WDA_EXCLUDEFROMCAPTURE) went from always-on to opt-in.
    if (disk.ui) delete disk.ui.stealth;
  }

  /**
   * Stamp the schema AFTER every migration block, not inside one of them.
   *
   * It used to be assigned inside `if (from < 3)`, so a file already at 3 would
   * run the v4 migration and never record that it had -- leaving `schema: 3` on
   * disk forever and re-running migrations on every launch. Harmless while they
   * are idempotent, and a silent corruption risk the moment one is not.
   */
  const migrated = from < SCHEMA;
  if (migrated) disk.schema = SCHEMA;

  data = deepMerge(DEFAULTS, disk);

  // Persist immediately so the migration is recorded. load() is otherwise
  // read-only, which is why the stamp never reached disk before.
  if (migrated) save({ immediate: true });

  // If the selected provider is unusable, fall back to something that is.
  // Local providers need no key, so they are always candidates.
  const sel = data.provider;
  const selNeedsKey = !['ollama', 'lmstudio'].includes(sel)
    && !(data.customProviders || []).some((c) => c.id === sel && c.needsKey === false);
  if (selNeedsKey && !(data.apiKeys[sel] || '').trim()) {
    const withKey = Object.keys(data.apiKeys).find((p) => (data.apiKeys[p] || '').trim());
    if (withKey) data.provider = withKey;
    else if (!anyKey(data)) data.provider = 'ollama';
  }
  return data;
}

function writeNow() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2));
    fs.renameSync(TMP, FILE); // atomic on the same volume
  } catch (e) {
    console.error('[nimbus] settings write failed:', e && e.message);
  }
}

function save({ immediate = false } = {}) {
  if (immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeNow();
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 400);
}

module.exports = {
  FILE,
  DEFAULTS,
  getSettings() { return load(); },
  setSettings(patch, opts) {
    load();
    data = deepMerge(data, patch || {});
    save(opts);
    return data;
  },
  flush() { save({ immediate: true }); }
};
