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
const hardware = require('./src/hardware');
const { createEngine } = require('./src/whisper/engine');
const catalog = require('./src/whisper/catalog');
const { createLLM, testConnection } = require('./src/llm');
const {
  MODES, DIGEST, buildDigest, splitDigest, looksDegenerate,
  COMPACT, buildCompact, parseCompact, compactPrefill, heardPrefill
} = require('./src/prompts');
const { estimateTurns, measureRatio, blendRatio } = require('./src/tokens');
const { WarmthKeeper } = require('./src/warmth');
const { PushToTalk } = require('./src/pushtotalk');
const { createDigest } = require('./src/digest');
const compact = require('./src/compact');
const history = require('./src/history');
const db = require('./src/db');

const DEV = !!process.env.CUE_DEV;
const log = (...a) => { if (DEV) console.log('[nimbus]', ...a); };

// Single instance. Two overlays fighting over the same global shortcuts and
// the same settings file is never what anyone wants.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let wm = null;
let warmth = null;
let ptt = null;
let convo = null;     // the conversation currently on screen (Electron owns `session`)
let engine = null;          // the managed whisper.cpp server, once it exists
let engineDecision = null;  // what the hardware probe chose, before any override

const state = {
  listening: false,
  busy: false,
  sttFailures: 0,
  sttMuted: false,     // set after repeated failures so we stop spamming notices

  // ---- microphone gate ----
  micOpen: false,      // the merged answer: is the mic feeding the model right now
  micClosedAt: 0,      // when it last closed, for the release grace window
  keyHeld: false,      // the global hold-to-talk chord
  buttonHeld: false,   // the pill's talk button

  // Compaction runs on the smart tier and is deliberately NOT part of
  // `busy`: it happens inside a feature run, and sharing that latch would make
  // the compaction refuse to start because the turn it is preparing for is busy.
  compacting: false,
  // Said once per conversation, not once per message: "this will not compress
  // itself" is a standing condition, and repeating it every turn would train the
  // user to dismiss the notice that eventually matters.
  advisedFull: false
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

/**
 * The live transcript, kept rolling rather than complete.
 *
 * Two bounds, not one. The count cap alone lets a machine left listening
 * overnight carry hours-old speech into tomorrow's prompt; the age cap alone
 * lets a loud meeting blow past any reasonable size in minutes. Whichever bites
 * first wins, and both are cheap because pruning happens on push.
 *
 * It is also session-scoped: starting a new conversation or stopping listening
 * empties it. Recall of anything older is the history database's job, and it
 * has an index for it -- this array exists only to be fast.
 */
const transcript = [];        // { channel, text, ts }
const MAX_TRANSCRIPT = 400;
const TRANSCRIPT_TTL_MS = 30 * 60 * 1000;

/**
 * System speech waiting to be written into the conversation as one turn.
 *
 * Utterances arrive every few seconds. Appending each one separately would put
 * a hundred one-line messages in the chat for a single meeting and spend the
 * context window on the whitespace between them, so they are gathered and
 * flushed as a block -- on a pause, on size, or when listening stops.
 */
const heardBuf = { parts: [], chars: 0, from: 0, timer: null };
const HEARD_GAP_MS = 6000;
const HEARD_MAX_CHARS = 1200;

let sttQueue = Promise.resolve();
let abortController = null;
/**
 * The in-flight compaction, so Stop can reach it.
 *
 * Separate from `abortController` because the two are cancelled independently:
 * aborting a compaction must not kill the answer, and a compaction started by
 * the popover button has no request behind it at all. Stop cancels whichever
 * ones are live -- from where the user sits, both are "the thing making me wait".
 */
let compactController = null;

/**
 * The consumer for heard system audio.
 *
 * Deliberately NOT routed through runFeature(). That path is behind one global
 * `state.busy` latch, and a background job sharing it would mean either the
 * user's question is refused because a digest is being written, or a digest is
 * dropped because the user asked something. Neither is acceptable: this holds
 * its own stream and never touches the latch.
 *
 * It runs on the FAST tier. A digest is a low-stakes, high-frequency job whose
 * value decays in minutes, and the smart tier has to stay free for the work that
 * genuinely needs recall.
 */
const DIGEST_TIMEOUT_MS = 60000;

const digest = createDigest({
  getSettings: () => store.getSettings(),
  log: (...a) => log('[digest]', ...a),
  onDigest: (block) => runDigest(block)
});

/**
 * Write up one block of heard speech.
 *
 * Throwing is meaningful here: src/digest.js keeps the block's material pending
 * on a rejection and retries it with whatever has been heard since, so a
 * provider that is briefly down costs a delay rather than a hole in the record.
 */
async function runDigest(block) {
  const settings = store.getSettings();
  const def = DIGEST[block.mode] || DIGEST.summarize;

  const llm = createLLM(settings, 'fast');
  if (!llm.ready) throw new Error(llm.reason || 'No fast model configured.');

  const targetLang = (settings.stt && settings.stt.targetLang) || 'English';
  const inputTokens = estimateTurns(block.turns);

  /**
   * A digest that never returns would hold the queue shut forever, and audio
   * would pile up behind a request that is not coming back. Bound it.
   */
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DIGEST_TIMEOUT_MS);

  const system = def.system(targetLang);
  // Only the modes that actually translate get told about a language. A
  // summarising model handed an unexplained "Target language:" header continues
  // it instead of the summary.
  const prompt = buildDigest({
    turns: block.turns,
    gist: block.gist,
    targetLang: def.wantsLang ? targetLang : null
  });

  let raw = '';
  let usage = null;
  try {
    await llm.stream({
      system,
      turns: [{ role: 'user', text: prompt }],
      maxTokens: def.budget(inputTokens),
      signal: ac.signal,
      onToken: (t) => { raw += t; },
      onUsage: (u) => { usage = u; }
    });
  } finally {
    clearTimeout(timer);
  }

  /**
   * Calibrate from here too. A user who only listens never presses a button, so
   * without this the fast model's tokenizer would stay a guess through an entire
   * meeting -- and the digest is the one call that is guaranteed to have run.
   */
  recordContext({
    provider: llm.provider,
    model: llm.model,
    promptChars: system.length + prompt.length,
    outputChars: raw.length,
    usage,
    hadImage: false
  });

  const { gist, body } = splitDigest(raw);
  const text = body || gist;
  if (!text) throw new Error('The model returned an empty digest.');
  /**
   * Throwing rather than displaying. The block stays pending and is retried with
   * whatever has been heard since, so a one-off collapse costs a delay -- where
   * showing it would also carry its gist into the next block as background.
   */
  if (looksDegenerate(text)) throw new Error('The model returned a degenerate digest.');

  const entry = {
    seq: block.seq,
    kind: def.label,
    reason: block.reason,
    gist,
    text,
    from: block.from,
    to: block.to,
    model: llm.model,
    provider: llm.provider
  };

  broadcast('audio:digest', entry);
  log('[digest] wrote #' + block.seq, '(' + block.reason + ')', gist);

  /**
   * Persisted with role 'note'.
   *
   * history.contextTurns() only ever returns user and assistant turns, so a
   * note survives in the record and in full-text search without becoming prompt
   * on the user's next question. That matters: forty audio digests silently
   * prepended to a chat would consume the context window this feature's other
   * half exists to protect.
   */
  if (!convo) convo = history.create(gist || 'Audio session');
  history.append(convo, 'note', text, {
    kind: def.label, gist, from: block.from, to: block.to,
    model: llm.model, provider: llm.provider
  });
  if (history.save(convo)) broadcast('history:changed', { id: convo.id, title: convo.title });

  return { gist };
}

// ---------------------------------------------------------------- helpers
function broadcast(channel, data) { if (wm) wm.broadcast(channel, data); }
function toPanel(channel, data) { if (wm) wm.sendToPanel(channel, data); }
function notify(message, level) { broadcast('status', { message, level: level || 'info' }); }

// ------------------------------------------------------------ context budget
/**
 * How much of the model's context window the conversation is using.
 *
 * Everything here is an estimate that improves with use. Two things are learned
 * from ordinary traffic, both free:
 *
 *   the ratio    one real prompt_tokens against the characters we know we sent
 *                measures that model's tokenizer on this user's actual language,
 *                which is the difference between chars/4 being right and being
 *                wrong by half for CJK.
 *   the window   a request the provider ACCEPTED proves the window is at least
 *                that big; a request it rejected with a stated maximum proves
 *                exactly how big. Neither costs a round trip.
 */
function recordContext({ provider, model, promptChars, outputChars, usage, hadImage }) {
  if (!provider || !model) return;
  const settings = store.getSettings();
  const facts = {};

  const promptTokens = usage && typeof usage.promptTokens === 'number' ? usage.promptTokens : null;
  const completionTokens = usage && typeof usage.completionTokens === 'number' ? usage.completionTokens : null;

  /**
   * Calibration is skipped when a screenshot was attached. An image is worth
   * hundreds of tokens and almost no characters, so measuring the ratio from
   * that turn would report a tokenizer several times denser than it is and then
   * inflate every later estimate for this model.
   */
  if (!hadImage && promptTokens != null && promptChars > 0) {
    const measured = measureRatio(promptChars, promptTokens);
    if (measured != null) {
      const blended = blendRatio(providers.charsPerTokenFor(settings, provider, model), measured);
      if (blended != null) facts.charsPerToken = Math.round(blended * 100) / 100;
    }
  }

  const cpt = facts.charsPerToken || providers.charsPerTokenFor(settings, provider, model);
  let floor = null;
  if (promptTokens != null) {
    // The reply occupies the same window as the prompt, so both halves count.
    floor = promptTokens + (completionTokens || 0);
  } else if (promptChars > 0) {
    /**
     * No usage reported, so fall back to our own estimate of a prompt that
     * demonstrably fit -- discounted by a fifth.
     *
     * The estimate can overshoot, and an overshooting "floor" is the one wrong
     * direction that matters: it would claim a window bigger than the model has
     * and remove the warning that exists to stop a request dying mid-answer.
     * The discount keeps it a lower bound under ordinary estimation error.
     */
    const ratio = cpt || 4;
    floor = Math.floor(((promptChars + (outputChars || 0)) / ratio) * 0.8);
  }
  if (floor && floor >= 512) facts.contextWindow = floor;

  if (!Object.keys(facts).length) return;
  const patch = providers.learnModel(settings, provider, model, facts, 'server', { windowSource: 'observed' });
  if (patch) broadcast('settings:changed', store.setSettings(patch));
}

/** A provider stated its real maximum while rejecting us. Nothing beats that. */
function recordContextLimit(provider, model, limit) {
  if (!provider || !model || !limit) return;
  const patch = providers.learnModel(
    store.getSettings(), provider, model, { contextWindow: limit }, 'server', { windowSource: 'error' }
  );
  if (patch) broadcast('settings:changed', store.setSettings(patch));
}

/**
 * A ceiling that exists only so a broken compaction cannot grow the request
 * without limit. Nothing should ever reach it: the trigger fires at a fraction
 * of the window, long before this many turns fit inside one.
 */
const HARD_CONTEXT_TURNS = 400;

/**
 * How many turns may be sent.
 *
 * With compression off this is the user's setting, and the oldest turns are
 * dropped once it is exceeded -- which is what the setting says it does.
 *
 * With compression ON the setting is deliberately ignored. A fixed turn cap
 * would keep silently discarding the start of the conversation, which is the
 * exact behaviour compression exists to replace, and worse: while the cap is
 * doing the discarding the measured fill never climbs, so the trigger would
 * never be reached and compression would never run at all. Zero still means
 * zero -- someone who asked for no history meant it.
 */
function contextTurnLimit(settings) {
  const cap = (settings.history || {}).contextTurns;
  const n = typeof cap === 'number' ? cap : null;
  if (n === 0) return 0;
  if ((settings.context || {}).autoCompact === false) return n;
  return HARD_CONTEXT_TURNS;
}

/**
 * The context actually sent with the next message.
 *
 * history.contextTurns() hands back a compaction as a single entry with role
 * 'summary'; the wording that wraps it lives in src/prompts.js. Assembling both
 * in one place is what keeps the fill bar honest -- the bar has to measure the
 * same thing the request will carry, prefill and all, or it reads low by a
 * couple of hundred tokens exactly when that margin matters.
 */
function assembleContext(settings) {
  if (!convo) return [];
  const raw = history.contextTurns(convo, contextTurnLimit(settings));
  const out = [];
  for (const t of raw) {
    if (t.role === 'summary') { for (const p of compactPrefill(t.text)) out.push(p); }
    else if (t.role === 'heard') { for (const p of heardPrefill(t.text)) out.push(p); }
    else out.push(t);
  }
  return out;
}

/**
 * What the fill bar draws.
 *
 * Measured against the USABLE budget, not the raw window: the reply has to fit
 * in the same space, so those tokens are spent whether or not they have been
 * written yet. A bar that reads 90% and then fails on the answer would be worse
 * than no bar at all.
 */
function contextSnapshot() {
  const settings = store.getSettings();
  const llm = createLLM(settings, settings.smart ? 'smart' : 'fast');
  if (!llm.ready || !llm.model) return null;

  const budget = providers.contextBudgetFor(settings, llm.provider, llm.model);
  const cpt = providers.charsPerTokenFor(settings, llm.provider, llm.model);
  const reply = Math.max(256, ((settings.reply || {}).maxTokens) || 4096);
  const prior = assembleContext(settings);
  const used = estimateTurns(prior, cpt);
  const usable = Math.max(1024, budget.tokens - reply);
  const folded = convo ? compact.lastSummary(convo.messages || []) : null;
  const compactor = providers.compactorFor(settings);

  return {
    used,
    usable,
    reply,
    // Whether compression would run on the same model that is answering. The
    // fill bar needs it to explain why nothing is happening on its own.
    single: !compactor.ok || !compactor.distinct,
    compactor: compactor.ok ? (compactor.label || compactor.provider) + ' · ' + compactor.model : null,
    compactorReason: compactor.reason,
    window: budget.tokens,
    pct: Math.min(1, used / usable),
    guessed: budget.guessed,
    source: budget.source,
    calibrated: cpt != null,
    turns: prior.length,
    compacted: !!folded,
    provider: llm.provider,
    label: llm.label,
    model: llm.model,
    tier: llm.tier
  };
}

function pushContext() {
  const snap = contextSnapshot();
  if (snap) broadcast('context:usage', snap);
}

// -------------------------------------------------------------- compaction
/** A compaction that never returns would hold up the answer it exists to enable. */
const COMPACT_TIMEOUT_MS = 90000;

/**
 * How full a conversation gets before Nimbus says so, when it will not act on
 * its own. Above the automatic trigger, because a reminder that fires at the
 * same time automatic compaction would have run is a reminder about nothing.
 */
const ADVISE_PCT = 0.8;

/**
 * Fold the older part of this conversation into one structured summary.
 *
 * Always the SMART tier, whatever the current turn is routed to. This is the
 * call that decides what the rest of the conversation will remember, so it is
 * the one place where paying for the better model is unambiguously right: get it
 * wrong here and every later answer is built on the mistake, with the originals
 * still on disk but no longer in view.
 *
 * Never throws. A failed compaction leaves the conversation exactly as it was,
 * which is a worse conversation but a working one.
 */
async function runCompaction({ auto } = {}) {
  if (!convo || !Array.isArray(convo.messages)) {
    return { ok: false, reason: 'There is nothing to compress yet.' };
  }
  if (state.compacting) return { ok: false, reason: 'A compression is already running.' };

  const settings = store.getSettings();
  const cfg = settings.context || {};
  // Taken before anything is appended, and handed to grade() so the verbatim
  // band can be trimmed to something that actually fits the window.
  const before = contextSnapshot();
  const plan = compact.grade(convo.messages, {
    keepHot: cfg.keepHot,
    budget: before ? before.usable : null
  });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  /**
   * The smart tier when there is one, otherwise whatever is answering.
   *
   * Falling back rather than refusing: a summary written by the small model is
   * worse than one written by a good model, and better than the silent
   * truncation that is the only other option. Refusing here would leave a user
   * with one model in exactly the state this feature exists to fix.
   */
  let llm = createLLM(settings, 'smart');
  if (!llm.ready) llm = createLLM(settings, settings.smart ? 'smart' : 'fast');
  if (!llm.ready) {
    return { ok: false, reason: llm.reason || 'No model is configured to compress with.' };
  }

  state.compacting = true;
  broadcast('compact:state', { active: true, auto: !!auto, turns: plan.folded });

  const ac = new AbortController();
  compactController = ac;
  // The signal alone cannot say who pulled it, and a timeout and a deliberate
  // Stop deserve different words -- one is a fault, the other is the user
  // getting what they asked for.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, COMPACT_TIMEOUT_MS);

  try {
    const system = COMPACT.system;
    const prompt = buildCompact(plan);
    let raw = '';
    let usage = null;

    await llm.stream({
      system,
      turns: [{ role: 'user', text: prompt }],
      maxTokens: COMPACT.budget(plan.inputTokens),
      signal: ac.signal,
      onToken: (t) => { raw += t; },
      onUsage: (u) => { usage = u; }
    });

    const doc = parseCompact(raw);
    if (!doc.ok) {
      // Structure is the whole contract. Free prose injected under a "this is
      // your context" banner is indistinguishable from a hallucination, and it
      // would replace turns that are still perfectly usable.
      throw new Error('The model answered the conversation instead of compressing it.');
    }
    if (doc.missing.length) {
      log('[compact] missing sections:', doc.missing.join(', '));
    }

    recordContext({
      provider: llm.provider,
      model: llm.model,
      promptChars: system.length + prompt.length,
      outputChars: raw.length,
      usage,
      hadImage: false
    });

    history.append(convo, 'summary', doc.text, {
      kind: 'compaction',
      covers: plan.covers,
      folded: plan.folded,
      model: llm.model,
      provider: llm.provider
    });
    if (history.save(convo)) broadcast('history:changed', { id: convo.id, title: convo.title });

    const after = contextSnapshot();
    const entry = {
      turns: plan.folded,
      // The summary itself, so the panel can drop the marker in place instead of
      // reloading the session and scrolling the user away from what they read.
      text: doc.text,
      ts: Date.now(),
      before: before ? before.used : null,
      after: after ? after.used : null,
      missing: doc.missing,
      model: llm.model,
      provider: llm.provider,
      auto: !!auto
    };
    broadcast('compact:done', entry);
    log('[compact] folded', plan.folded, 'turns',
      before && after ? before.used + ' -> ' + after.used + ' tok' : '');
    return { ok: true, ...entry };
  } catch (e) {
    const cancelled = !!(e && e.aborted) && !timedOut;
    const message = cancelled
      ? 'Compression stopped.'
      : (e && e.aborted) ? 'The compression timed out.'
        : (e && e.message) || String(e);
    log('[compact] failed:', message);
    if (e && e.contextLimit) recordContextLimit(e.provider, e.model, e.contextLimit);
    // Nothing was appended, so the conversation is exactly as it was: a
    // cancelled compaction costs the round trip and nothing else.
    return { ok: false, cancelled, reason: message };
  } finally {
    clearTimeout(timer);
    compactController = null;
    state.compacting = false;
    broadcast('compact:state', { active: false });
    pushContext();
  }
}

/**
 * Compress before the next request, if the conversation has grown enough.
 *
 * Runs INSIDE the feature run rather than on a timer: the only moment the answer
 * is worth delaying for is the moment before a request that would otherwise be
 * over-long, and a background timer would fire in the middle of the user reading
 * a reply and change what the assistant remembers with no visible cause.
 */
async function maybeCompact() {
  const settings = store.getSettings();
  const snap = contextSnapshot();
  const verdict = compact.shouldCompact(snap, settings);
  if (!verdict.yes) { adviseFull(snap, verdict); return; }
  notify('Compressing the conversation so it keeps fitting…', 'info');
  const res = await runCompaction({ auto: true });
  // A cancel is not a failure. The user pressed Stop and got what they asked
  // for; telling them it "could not" compress would read as a fault.
  if (!res.ok && !res.cancelled && res.reason) notify('Could not compress: ' + res.reason, 'warn');
}

/**
 * The on-screen reminder for a conversation that is filling up and will NOT be
 * compressed automatically.
 *
 * Two ways to end up here. Either only one model is configured, so compaction
 * would be that model summarising a conversation it is already straining to
 * hold; or the window is a pure guess, so acting on it could destroy detail to
 * solve a problem that does not exist. Both are decisions the user should make,
 * and neither is an error, so this is a card with buttons rather than a warning.
 *
 * Said once per conversation. Repeating it every turn would train the user to
 * dismiss the notice that eventually matters.
 */
function adviseFull(snap, verdict) {
  if (!snap || state.advisedFull) return;
  if (snap.pct < ADVISE_PCT) return;
  if (verdict.reason !== 'single' && verdict.reason !== 'guessed') return;

  state.advisedFull = true;
  broadcast('compact:advice', {
    kind: verdict.reason,
    pct: snap.pct,
    model: snap.model,
    window: snap.window,
    compactor: snap.compactor,
    compactorReason: snap.compactorReason
  });
}

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
  /**
   * Polled whenever the mic is on push-to-talk, listening or not.
   *
   * It used to also require state.listening, which made the chord a no-op in
   * exactly the situation people press it in: Nimbus idle, something worth
   * saying, hold the key and talk. Nothing happened and nothing explained why,
   * which is what "the shortcut is buggy" actually meant. Holding it now starts
   * listening (see the onChange wiring in start()) instead of being swallowed.
   *
   * The poll is 24ms of GetAsyncKeyState against a couple of virtual keys, so
   * running it while idle costs nothing measurable.
   */
  if (micModeOf() === 'ptt') ptt.start();
  else ptt.stop();
  updateMicGate();
}

// ---------------------------------------------------------- local engine
/**
 * The managed whisper.cpp server.
 *
 * Nimbus ships no model and no inference binary: the installer probes the
 * machine, and on first run the build matching that hardware -- CUDA, ROCm,
 * Vulkan or plain CPU -- is downloaded along with a model sized to the memory
 * available. Everything after that is cached, so this is a first-run cost.
 *
 * The engine owns its port and reports it back; whenever it is managed and
 * ready, its endpoint overrides stt.localBaseURL, which is what lets the
 * transport in src/stt.js stay a dumb HTTP client that knows nothing about
 * processes.
 */
let engineSyncTimer = null;

function engineChoice(settings) {
  const cfg = (settings && settings.stt) || {};
  const eng = cfg.engine || {};
  const auto = engineDecision || {};
  return {
    build: eng.build && eng.build !== 'auto' ? eng.build : (auto.build || 'cpu'),
    modelTier: eng.model && eng.model !== 'auto' ? eng.model : (auto.modelTier || 'base'),
    /**
     * CrisperWhisper by default: it is a Whisper fine-tune that transcribes what
     * was said instead of a tidied paraphrase, which is what a meeting or an
     * interview needs. The catalog drops back to stock Whisper on its own for
     * languages it was never trained on, so 'auto' is safe everywhere.
     */
    family: eng.family && eng.family !== 'auto' ? eng.family : 'crisper',
    language: cfg.language,
    port: eng.port || 8081,
    threads: eng.threads || 0
  };
}

/**
 * Settings as the transcriber should see them.
 *
 * A managed engine picks its own port -- 8081 may already be taken -- so the
 * stored base URL is stale by construction and is replaced with the live one.
 * The model name goes along for the ride because whisper.cpp serves whatever
 * it was started with and ignores the field entirely.
 */
function sttSettings() {
  const s = store.getSettings();
  const cfg = s.stt || {};
  if (!(cfg.engine || {}).manage || !engine) return s;
  const st = engine.status();
  if (st.phase !== 'ready' || !st.endpoint) return s;
  return { ...s, stt: { ...cfg, localBaseURL: st.endpoint, localModel: 'whisper-1' } };
}

async function startEngine({ force = false, reprobe = false } = {}) {
  const s = store.getSettings();
  const cfg = s.stt || {};
  const managed = (cfg.engine || {}).manage !== false && (cfg.provider || 'local') === 'local';

  if (!managed) {
    if (engine) engine.stop();
    return null;
  }

  if (!engine) {
    engine = createEngine({
      userDataDir: app.getPath('userData'),
      log: (m) => console.log('[nimbus] ' + m)
    });
    engine.on((st) => broadcast('stt:engine', st));
  }

  const report = await hardware.probe({ userDataDir: app.getPath('userData'), force: reprobe });
  engineDecision = hardware.classify(report);
  console.log('[nimbus] hardware: ' + hardware.describe(engineDecision));

  try {
    return await engine.ensure({ ...engineChoice(s), force });
  } catch (e) {
    /**
     * A failed install is reported once and then left alone. It is nearly
     * always a network problem, and retrying on a timer would mean re-pulling
     * hundreds of megabytes in the background without being asked.
     */
    notify('Could not set up local transcription: ' + ((e && e.message) || e), 'error');
    return null;
  }
}

/**
 * Re-sync after a settings save, debounced.
 *
 * ensure() is a no-op when nothing relevant changed, but the settings sheet
 * saves on every keystroke, and a half-typed port number should not start a
 * server on it.
 */
function scheduleEngineSync() {
  clearTimeout(engineSyncTimer);
  engineSyncTimer = setTimeout(() => { startEngine().catch(() => {}); }, 1500);
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
  const settings = sttSettings();
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
  pushTranscript(turn);
  broadcast('transcript', turn);
  log('transcript', channel, text);

  // Heard audio now has somewhere to go. Ignores the 'you' channel; see digest.js.
  digest.push(turn);

  /**
   * Transcription is a way of talking to the model, so it lands in the
   * conversation rather than in the margin beside it. The two channels are not
   * the same act and do not go to the same place:
   *
   *   you    the user talking. Staged in the composer, unsent. Recognition is
   *          wrong often enough that auto-sending would mean arguing with the
   *          model about words nobody said, so Enter stays in the user's hands.
   *   them   everyone else. Written into the chat as its own kind of turn,
   *          tagged so the model reads it as overheard rather than addressed.
   *
   * Digests keep running alongside this. They are the compressed record of a
   * long session, not the live channel, and the pill is where they belong.
   */
  if (channel === 'you') stageForUser(text, turn.ts);
  else if (transcriptToChat()) pushHeard(turn);

  maybeWake(text, channel);
}

/**
 * Put the user's own words in the composer, where the Enter key is.
 *
 * The panel is opened first if it was closed. Text staged into a hidden window
 * is text the user cannot read, edit or send, and they just held a key down and
 * spoke -- they are asking for the composer whether or not it is on screen.
 *
 * Focused, because the next action is Enter or a correction and both need it.
 */
function stageForUser(text, ts) {
  if (!transcriptToChat()) return;
  if (wm && !wm.panelOpen) wm.openPanel({ focus: true });
  toPanel('transcript:stage', { text, ts });
}

/** Append to the live transcript, dropping whatever is too old or too much. */
function pushTranscript(turn) {
  transcript.push(turn);
  const cutoff = turn.ts - TRANSCRIPT_TTL_MS;
  let stale = 0;
  while (stale < transcript.length && transcript[stale].ts < cutoff) stale++;
  const over = transcript.length - MAX_TRANSCRIPT;
  const drop = Math.max(stale, over);
  if (drop > 0) transcript.splice(0, drop);
}

/** Empty the live transcript and anything staged from it. Session boundaries. */
function resetTranscript() {
  transcript.length = 0;
  flushHeard('reset');
}

function transcriptToChat() {
  const s = store.getSettings().stt || {};
  return s.toChat !== false;
}

// ------------------------------------------------------- heard, into the chat
function pushHeard(turn) {
  if (!heardBuf.parts.length) heardBuf.from = turn.ts;
  heardBuf.parts.push(turn.text);
  heardBuf.chars += turn.text.length + 1;
  heardBuf.to = turn.ts;

  if (heardBuf.chars >= HEARD_MAX_CHARS) { flushHeard('size'); return; }

  if (heardBuf.timer) clearTimeout(heardBuf.timer);
  heardBuf.timer = setTimeout(() => flushHeard('pause'), HEARD_GAP_MS);
  if (heardBuf.timer.unref) heardBuf.timer.unref();
}

/**
 * Write the gathered system speech into the conversation as one turn.
 *
 * 'reset' discards instead of writing: it fires when the session is being torn
 * down or replaced, and the block belongs to the conversation that is ending,
 * not the one starting.
 */
function flushHeard(reason) {
  if (heardBuf.timer) { clearTimeout(heardBuf.timer); heardBuf.timer = null; }
  const parts = heardBuf.parts.splice(0, heardBuf.parts.length);
  const from = heardBuf.from;
  const to = heardBuf.to;
  heardBuf.chars = 0;
  if (!parts.length || reason === 'reset') return;

  const text = parts.join(' ');
  if (!convo) convo = history.create('Audio session');
  history.append(convo, 'heard', text, { channel: 'them', from, to });
  if (history.save(convo)) broadcast('history:changed', { id: convo.id, title: convo.title });

  const entry = { text, from, to, reason, ts: Date.now() };
  toPanel('transcript:heard', entry);
  pushContext();
  log('[heard] ' + parts.length + ' utterance(s), ' + text.length + ' chars (' + reason + ')');
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

/**
 * What can this exact model do, according to the server that serves it?
 *
 * Returns true / false / null, where null genuinely means unknown. Most
 * OpenAI-compatible servers publish input modalities in /v1/models, so this
 * usually settles vision without any failed request at all -- and the answer is
 * cached in settings, so it is asked once per model rather than once per turn.
 *
 * Best-effort by design: a server that is down or says nothing leaves the answer
 * unknown, and the caller proceeds optimistically rather than refusing.
 */
async function learnCapabilities(providerId, modelId) {
  const model = (modelId || '').trim();
  if (!providerId || !model) return null;

  const cached = providers.modelInfoFor(store.getSettings(), providerId, model);
  // Already settled by the server or by hand; do not re-ask.
  if (cached && (cached.source === 'server' || cached.source === 'user' || cached.source === 'probe')) {
    return typeof cached.vision === 'boolean' ? cached.vision : null;
  }

  try {
    const d = await providers.discoverModels(store.getSettings(), providerId, { timeoutMs: 2500 });
    const m = d && d.ok && (d.models || []).find((x) => x.id === model);
    if (m && m.capabilitiesKnown) {
      const patch = providers.learnModel(
        store.getSettings(), providerId, model,
        { vision: !!m.vision, contextWindow: m.contextWindow || undefined }, 'server'
      );
      if (patch) broadcast('settings:changed', store.setSettings(patch));
      return !!m.vision;
    }
  } catch { /* discovery is optional; an unknown answer is still usable */ }

  return providers.visionFor(store.getSettings(), providerId, model);
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
       * Order matters. Ask the server what this model can do FIRST -- most
       * OpenAI-compatible servers declare input modalities, which settles the
       * question without a failed request -- and only then decide whether a
       * hand-off is needed. The old code asked a per-provider boolean that no
       * model owned, so a vision-capable model was declared blind and the
       * hand-off could not rescue it either.
       *
       * Only a KNOWN-blind model triggers the hand-off. Unknown means attach
       * and find out; see src/llm.js.
       */
      let sees = await learnCapabilities(llm.provider, llm.model);

      if (sees === false) {
        const vr = (settings.routes || {}).vision || {};
        if (vr.provider && (vr.model || '').trim()) {
          const vlm = createLLM(store.getSettings(), 'vision');
          if (vlm.ready && (await learnCapabilities(vlm.provider, vlm.model)) !== false) {
            activeLLM = vlm;
            sees = true;
            notify('Screen question routed to ' + vlm.label + ' / ' + vlm.model + ' for vision.', 'info');
          }
        }
      }

      if (sees === false) {
        notify('"' + activeLLM.model + '" cannot accept images, so no screenshot was attached. '
          + 'Set a Vision route in Settings to send screen questions to a model that can see.', 'warn');
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
    /**
     * Fold before assembling, not after answering. Compaction changes what
     * `prior` contains, so it has to happen while there is still a decision to
     * make about this request -- and doing it here means the user waits once,
     * visibly, rather than having the assistant quietly forget between turns.
     */
    if (conversational) await maybeCompact();
    const prior = conversational ? assembleContext(settings) : [];
    const turns = prior.concat([{ role: 'user', text: built }]);

    history.append(convo, 'user', userBubble || userText || def.userBubble || '(action)', { mode });

    const askedAt = Date.now();
    let sawFirstToken = false;
    let usage = null;
    // What we know we put on the wire, for calibrating this model's tokenizer.
    const charsOf = (ts) => String(def.system || '').length
      + ts.reduce((n, t) => n + String(t.text || '').length, 0);
    let promptChars = charsOf(turns);

    /**
     * One attempt. Wrapped so the overflow recovery below can make a second one
     * against a compacted context without restating every handler.
     */
    const streamOnce = (sendTurns) => activeLLM.stream({
      system: def.system,
      turns: sendTurns,
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
      onUsage: (u) => { usage = u; },
      onNotice: (n) => {
        notify(n.message, n.level || 'info');
        /**
         * The retry just proved THIS MODEL cannot take an image. Record it
         * against the model, so the next screen question skips the screenshot
         * instead of paying for the same failed round trip -- and so the other
         * models on the same endpoint keep their own capabilities.
         *
         * Ranked 'probe': a request that failed is weaker evidence than a
         * server's declaration and than the user saying so by hand, and
         * providers.learnModel will not let it overwrite either.
         */
        if (n.visionFailed && n.provider && n.model) {
          const patch = providers.learnModel(
            store.getSettings(), n.provider, n.model, { vision: false }, 'probe'
          );
          if (patch) broadcast('settings:changed', store.setSettings(patch));
        }
      }
    });

    let full;
    try {
      full = await streamOnce(turns);
    } catch (e) {
      /**
       * The cap, hit for real.
       *
       * The provider just refused the request for length, which is both the best
       * evidence there is about this model's window and the exact situation
       * compaction exists for. So: learn the number, fold, and try once. One
       * retry only -- if a compacted context is still too long, the next thing to
       * change is the model or the reply budget, not the conversation.
       */
      if (!e || !e.contextOverflow || !conversational) throw e;
      recordContextLimit(e.provider, e.model, e.contextLimit);
      notify('That was longer than "' + activeLLM.model + '" can take. Compressing and retrying…', 'warn');

      const res = await runCompaction({ auto: true });
      // Rethrow the ORIGINAL error: "too long" is what the user needs to act on,
      // and a compaction failure on top of it is noise about the recovery.
      if (!res.ok) throw e;

      const refreshed = assembleContext(settings);
      // The question was appended before the request went out, so it is now both
      // the tail of the assembled context and the turn about to be sent. Drop the
      // copy rather than asking it twice.
      if (refreshed.length && refreshed[refreshed.length - 1].role === 'user') refreshed.pop();
      const retryTurns = refreshed.concat([{ role: 'user', text: built }]);
      promptChars = charsOf(retryTurns);
      sawFirstToken = false;
      usage = null;
      full = await streamOnce(retryTurns);
    }

    if (typeof full === 'string' && full.trim()) {
      history.append(convo, 'assistant', full, {
        model: activeLLM.model, provider: activeLLM.provider, tier: activeLLM.tier
      });
    }
    recordContext({
      provider: activeLLM.provider,
      model: activeLLM.model,
      promptChars,
      outputChars: typeof full === 'string' ? full.length : 0,
      usage,
      hadImage: !!imageDataUrl
    });
    broadcast('llm:done', {});
  } catch (e) {
    if (e && e.aborted) broadcast('llm:done', {});
    else broadcast('llm:error', { message: (e && e.message) || String(e) });
    /**
     * A context-length rejection is the only error worth learning from: the
     * provider just stated its own maximum, which is better evidence than
     * anything /v1/models reports. Recording it is what turns "this failed
     * again" into a bar that fills up and a compression that happens first.
     */
    if (e && e.contextLimit) recordContextLimit(e.provider, e.model, e.contextLimit);
  } finally {
    /**
     * Persisted in `finally`, not on the success path.
     *
     * The user's question is appended before the request goes out, so a provider
     * that errors or a reply the user aborts used to throw that question away --
     * exactly the conversations you most want to find again. The write is
     * incremental and idempotent, so doing it here costs one INSERT.
     */
    if (convo && convo.messages.length && history.save(convo)) {
      broadcast('history:changed', { id: convo.id, title: convo.title });
    }
    // Also on the failure path: the question was still appended, so the bar
    // would otherwise sit at a stale figure until the next successful turn.
    pushContext();
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
    // Same reasoning for the digest's own failure count, and for discovery: a
    // cached model list from before the edit would report the old endpoint's
    // answer for the new one.
    digest.reset();
    providers.clearDiscoveryCache();
    // The mic mode and the talk chord both live in settings, so every save is a
    // chance that the gate's inputs just changed underneath it.
    syncPushToTalk();
    // A changed engine build, model, port or language means a different server.
    if (patch && patch.stt) scheduleEngineSync();
    broadcast('settings:changed', next);
    // The route, the reply budget and a manual window override all live in
    // settings, so any save can change what the bar should read.
    pushContext();
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
  ipcMain.handle('providers:discover', async (_e, id, opts) => {
    const force = !!(opts && opts.force);
    const res = await providers.discoverModels(store.getSettings(), id, { force });
    /**
     * Fold every declared capability into the per-model cache while we have it.
     *
     * Doing it here means opening Settings teaches the app about the whole
     * endpoint at once, so the first screen question already knows the answer.
     * A forced refresh overrides a previous runtime probe -- that is the only
     * way a model wrongly marked blind can be un-marked from the UI.
     */
    if (res && res.ok) {
      let patch = null;
      for (const m of res.models || []) {
        if (!m.capabilitiesKnown) continue;
        const one = providers.learnModel(
          store.getSettings(), id, m.id,
          { vision: !!m.vision, contextWindow: m.contextWindow || undefined },
          'server', { override: force }
        );
        if (one) patch = { modelInfo: { ...(patch || {}).modelInfo, ...one.modelInfo } };
      }
      if (patch) broadcast('settings:changed', store.setSettings(patch));
    }
    return res;
  });

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
   * The managed engine, for the Settings pane.
   *
   * Reports three separate things on purpose: what the hardware probe found,
   * what is installed on disk, and what the running server is actually doing.
   * They disagree in the cases that matter -- a machine that probed as CUDA but
   * fell back to Vulkan because the asset was missing, or an accelerated build
   * that started but whose backend never bound to a device.
   */
  ipcMain.handle('engine:status', async () => {
    const s = store.getSettings();
    return {
      status: engine ? engine.status() : { phase: 'idle', running: false },
      decision: engineDecision,
      hardware: engineDecision ? hardware.describe(engineDecision) : '',
      choice: engineChoice(s),
      installed: engine ? await engine.installed() : { builds: [], models: [], saved: {} },
      options: catalog.options()
    };
  });

  /**
   * Install, switch or repair.
   *
   * Any build stays selectable whatever the probe decided: driver quirks are
   * real, and the person at the keyboard can see benchmarks we cannot.
   */
  ipcMain.handle('engine:install', async (_e, opts) => {
    const patch = {};
    if (opts && opts.build) patch.build = opts.build;
    if (opts && opts.model) patch.model = opts.model;
    if (opts && opts.family) patch.family = opts.family;
    if (Object.keys(patch).length) store.setSettings({ stt: { engine: patch } });
    clearTimeout(engineSyncTimer);
    const st = await startEngine({ force: true, reprobe: !!(opts && opts.reprobe) });
    return st || (engine ? engine.status() : null);
  });

  ipcMain.handle('engine:stop', () => {
    if (engine) engine.stop();
    return engine ? engine.status() : null;
  });

  /** Re-run the hardware probe: a card can be swapped in after install. */
  ipcMain.handle('engine:probe', async () => {
    const report = await hardware.probe({ userDataDir: app.getPath('userData'), force: true });
    engineDecision = hardware.classify(report);
    return { decision: engineDecision, hardware: hardware.describe(engineDecision) };
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
  ipcMain.handle('history:list', (_e, opts) => history.list(opts));
  ipcMain.handle('history:search', (_e, q) => history.search(q));
  ipcMain.handle('history:count', () => history.count());
  ipcMain.handle('history:rename', (_e, id, title) => history.rename(id, title));
  ipcMain.handle('history:load', (_e, id) => {
    const s = history.load(id);
    // The live transcript belongs to the session it was heard in. Carrying it
    // across would file this meeting's audio under last week's conversation.
    if (s) { resetTranscript(); convo = s; state.advisedFull = false; broadcast('history:opened', s); pushContext(); }
    return s;
  });
  ipcMain.handle('history:new', () => {
    resetTranscript();
    convo = null;     // created lazily on the next message, so empty sessions never persist
    state.advisedFull = false;
    broadcast('history:opened', { id: null, title: 'New conversation', messages: [] });
    pushContext();
    return true;
  });

  // Pull, for a panel that has just opened and missed every broadcast so far.
  ipcMain.handle('context:get', () => contextSnapshot());
  /**
   * Compress on demand.
   *
   * Deliberately allowed below the automatic threshold: the user may know the
   * next question opens a long thread, and waiting for the bar to fill would
   * mean paying the delay in the middle of that thread instead of before it.
   */
  ipcMain.handle('context:compact', () => runCompaction({ auto: false }));
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
  ipcMain.on('ask:abort', () => {
    // Both, because the user pressed Stop while waiting -- and when a compaction
    // is running ahead of a request, the compaction IS what they are waiting on.
    if (compactController) compactController.abort();
    if (abortController) abortController.abort();
  });

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

  /**
   * The VAD saying whether a channel is live, so the digest can tell a pause in
   * the audio from a gap between transcriptions. Cheap and frequent: no work is
   * done here beyond handing it on.
   */
  ipcMain.on('audio:speech', (_e, p) => {
    if (!state.listening || !p) return;
    digest.speech(p.channel, p.active);
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
      // Written, not discarded: it was genuinely heard, and a block held back
      // because the user stopped listening mid-sentence is the one most likely
      // to matter.
      flushHeard('stop');
    }
    // Turning listening off flushes whatever was heard last, which is usually
    // the part of a meeting worth having written up.
    digest.setListening(state.listening);
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

  // Before any IPC is registered: the history handlers assume an open store,
  // and userData is only guaranteed resolvable once the app is ready.
  history.init();

  const nat = win32.status();
  if (!nat.available) {
    console.warn('[nimbus] native window effects unavailable:', nat.error);
    console.warn('[nimbus] falling back to CSS glass. Acrylic, region clipping and Alt-Tab exclusion are off.');
  }

  registerIPC();

  wm = new WindowManager({
    stealth: !!((store.getSettings().ui || {}).privacy),
    onEvent: (channel, data) => {
      /**
       * A drag moves the pill for this session only.
       *
       * Persisting it is what put the pill off-centre on every launch after the
       * first: one nudge and Nimbus reopened there forever, on whichever
       * display and at whichever offset, with nothing on screen explaining why.
       * It now always opens centred on the top edge, and dragging is a
       * temporary "get out of the way" rather than a preference.
       */
      if (channel === 'pill:moved') return;
      broadcast(channel, data);
    }
  }).create();

  const ui0 = store.getSettings().ui || {};
  if (ui0.glass) wm.glassMode = ui0.glass;

  /**
   * Re-centre once the renderer has reported its real width.
   *
   * create() can only centre the seed size, and the pill is narrower than the
   * seed, so the launch position was always off by half the difference.
   */
  setTimeout(() => wm.centerPill(), 300);

  warmth = new WarmthKeeper({
    getSettings: () => store.getSettings(),
    onEvent: (ch, data) => broadcast(ch, data)
  });
  if ((store.getSettings().warmth || {}).enabled !== false) warmth.start();

  ptt = new PushToTalk({
    onChange: (down) => {
      state.keyHeld = down;
      /**
       * Holding the talk key while idle turns listening on rather than doing
       * nothing. The renderer owns the capture devices, so this asks rather
       * than sets; it comes back as listen:state, which calls syncPushToTalk,
       * which opens the gate with keyHeld still true.
       *
       * The pre-roll buffer in the worklet covers the round trip, so the first
       * word survives the delay instead of being clipped.
       */
      if (down && !state.listening) broadcast('listen:request', {});
      updateMicGate();
    }
  });
  syncPushToTalk();

  registerShortcuts();

  // A resolution change, a DPI change or docking a laptop all invalidate the
  // panel's layout caps and every window region, which are computed in device
  // pixels from a scale factor that just changed underneath them.
  const onDisplayChange = () => {
    if (!wm) return;
    wm.refreshRegions();
    // Docking a laptop or changing resolution moves the midpoint of the top
    // edge, so the anchor has to be recomputed, not just the regions.
    wm.centerPill();
    wm.broadcast('display:changed', { availableHeight: wm.availableHeight() });
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) wm.create(); });

  /**
   * Set up local transcription in the background.
   *
   * Deferred rather than awaited: on a first run this downloads a build and a
   * model, and the app has to be usable -- and its progress visible -- while
   * that happens. Every later launch finds both on disk and only starts the
   * server, which is a couple of seconds.
   */
  setTimeout(() => { startEngine().catch(() => {}); }, 2000);
});

app.on('will-quit', () => {
  if (warmth) warmth.stop();
  if (ptt) ptt.stop();
  // The server is our child process: leaving it running would hold the port and
  // a model's worth of memory after Nimbus is gone.
  if (engine) engine.stop();
  digest.stop();
  globalShortcut.unregisterAll();
  store.flush();          // debounced writes must not be lost on exit
  db.close();             // checkpoints the WAL, so the next launch opens clean
  if (wm) wm.destroy();
});

// The pill is the app. Closing a window is not closing Nimbus, and on Windows
// there is no dock to return from.
app.on('window-all-closed', () => app.quit());
