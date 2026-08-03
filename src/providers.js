'use strict';
/**
 * Provider registry.
 *
 * The old build hardcoded four providers in three separate places: a literal
 * array in store.js:41, four <button> tags in index.html, and an if/else chain
 * in llm.js. Adding a fifth meant editing all three and any one of them being
 * missed failed silently.
 *
 * It also gated usage on `ready: !!apiKey && !!model`, which is wrong for the
 * entire class of provider this refactor is about: Ollama and llama.cpp have no
 * API key, so a keyless local provider could never become ready.
 *
 * Everything OpenAI-compatible collapses to one transport with a different
 * baseURL. That is already how the existing `nvidia` entry worked -- it just
 * was not generalised.
 */

const crypto = require('crypto');
const tokens = require('./tokens');

const OPENAI_COMPATIBLE = 'openai';

const BUILTIN = {
  /**
   * The model Nimbus downloads and runs itself.
   *
   * It is an ordinary OpenAI-compatible local provider, because that is exactly
   * what llama-server is once it is up. The only thing unusual about it is that
   * its baseURL is not a constant: the engine picks a free port at launch, so
   * the address is filled in by setLocalEndpoint() when the server reports
   * ready, and cleared when it stops. A `null` baseURL here is the honest
   * statement that nothing is listening yet.
   */
  nimbus: {
    id: 'nimbus',
    label: 'In the box',
    kind: OPENAI_COMPATIBLE,
    baseURL: null,
    needsKey: false,
    local: true,
    managed: true,          // Nimbus starts and stops this one. See src/local.
    vision: false,
    defaults: { fast: '', smart: '' }
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    kind: OPENAI_COMPATIBLE,
    baseURL: null,
    needsKey: true,
    keyPlaceholder: 'sk-...',
    vision: true,
    defaults: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    needsKey: true,
    keyPlaceholder: 'sk-ant-...',
    vision: true,
    defaults: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-5' }
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    kind: 'gemini',
    needsKey: true,
    keyPlaceholder: 'AIza...',
    vision: true,
    defaults: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' }
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: OPENAI_COMPATIBLE,
    baseURL: 'https://integrate.api.nvidia.com/v1',
    needsKey: true,
    keyPlaceholder: 'nvapi-...',
    vision: true,
    defaults: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' }
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    kind: OPENAI_COMPATIBLE,
    baseURL: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    local: true,
    /**
     * Provider-level vision is an AFFIRMATIVE hint only: `true` means every
     * model this provider serves can see. There is no such thing as a provider
     * whose models all cannot -- Ollama serves llava and llama3.2 from the same
     * endpoint -- so `false` here means "not all of them", i.e. ask per model.
     * See visionFor().
     */
    vision: false,
    defaults: { fast: 'llama3.2', smart: 'qwen2.5:14b' }
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: OPENAI_COMPATIBLE,
    baseURL: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    local: true,
    vision: false,
    defaults: { fast: '', smart: '' }
  }
};

const BUILTIN_ORDER = ['nimbus', 'ollama', 'lmstudio', 'openai', 'anthropic', 'gemini', 'nvidia'];

/**
 * Where the managed local server is listening, once it is, and the token that
 * gets in.
 *
 * Process state, not settings: the port is chosen at launch and the token is
 * minted at launch, so both are meaningless across restarts and writing them to
 * disk would only create a stale address to be wrong about. main.js calls this
 * from the engine's state listener.
 *
 * The token is not privacy theatre. llama-server sets `Access-Control-Allow-
 * Origin: *`, so a loopback bind keeps other machines out but keeps no web page
 * out: any site the user visits can script a request to 127.0.0.1 and read the
 * reply. Requiring a bearer token the page cannot know closes that, because the
 * server is the only other thing that has it. See src/local/engine.js.
 */
let managedEndpoint = '';
let managedKey = '';

function setLocalEndpoint(url, key) {
  managedEndpoint = String(url || '');
  managedKey = managedEndpoint ? String(key || '') : '';
}

function localEndpoint() {
  return managedEndpoint;
}

/** Placeholder key. The OpenAI SDK throws on an empty apiKey even when the
 *  endpoint ignores auth entirely, which is the normal case for local servers. */
const NO_KEY = 'cue-local';

function customList(settings) {
  return Array.isArray(settings && settings.customProviders) ? settings.customProviders : [];
}

/** Every provider the user can pick, built-in and custom, in display order. */
function list(settings) {
  const out = BUILTIN_ORDER.map((id) => ({
    ...BUILTIN[id],
    ...(BUILTIN[id].managed ? { baseURL: managedEndpoint || null } : {})
  }));
  for (const c of customList(settings)) {
    if (!c || !c.id || BUILTIN[c.id]) continue;
    out.push({
      id: c.id,
      label: c.label || c.id,
      kind: OPENAI_COMPATIBLE, // custom entries are OpenAI-compatible by definition
      baseURL: c.baseURL || '',
      needsKey: c.needsKey !== false,
      keyPlaceholder: 'optional',
      local: !!c.local,
      vision: !!c.vision,
      custom: true,
      defaults: { fast: '', smart: '' }
    });
  }
  return out;
}

function get(settings, id) {
  return list(settings).find((p) => p.id === id) || null;
}

/** Display name for a provider, honouring a user rename. */
function labelOf(settings, id) {
  const over = (((settings.models || {})[id] || {}).label || '').trim();
  if (over) return over;
  const p = get(settings, id);
  return p ? p.label : id;
}

/**
 * Merge a provider descriptor with the user's stored key, model and overrides.
 * Returns null for an unknown id rather than throwing.
 */
function resolve(settings, id) {
  const p = get(settings, id || settings.provider);
  if (!p) return null;

  const keys = settings.apiKeys || {};
  const rawKey = (keys[p.id] || '').trim();
  // The per-provider fields predate routes and still carry the old two names,
  // so the three tiers fold back onto them: anything below Smart reads `fast`.
  const tier = activeTier(settings) === 'smart' ? 'smart' : 'fast';
  const models = (settings.models || {})[p.id] || {};
  const model = (models[tier] || p.defaults[tier] || '').trim();

  // A user-set override wins over the descriptor default.
  const baseURL = (models.baseURL || p.baseURL || null);
  // Capabilities belong to the MODEL, never the provider. See visionFor().
  const vision = visionFor(settings, p.id, model);
  const contextWindow = contextWindowFor(settings, p.id, model);

  // A user-supplied display name wins. Pointing the built-in "Ollama" slot at an
  // unrelated OpenAI-compatible server made every error message read
  // "Ollama: ..." for a server that has nothing to do with Ollama.
  const label = (models.label || '').trim() || p.label;

  const hasKey = !!rawKey;
  const keySatisfied = p.needsKey ? hasKey : true;
  /**
   * A managed provider is ready only while its own server is up.
   *
   * Every other provider is an address someone else is responsible for, so a
   * configured route is as much as this module can check. This one Nimbus runs,
   * and between "not downloaded", "downloading" and "unloaded because a real
   * provider took over" it is un-ready far more often than it is ready.
   */
  const endpointSatisfied = !p.managed || !!baseURL;

  return {
    ...p,
    label,
    baseURL,
    vision,
    contextWindow,
    // Normalised to a boolean. Only the local built-ins declare `local`, so
    // cloud providers were returning undefined -- falsy, and therefore working
    // by accident, but it made `p.local === false` untrue for a cloud provider.
    local: !!p.local,
    // The managed server mints its own token per launch; nothing the user typed
    // applies to it, and there is no settings field that could hold it.
    apiKey: p.managed ? (managedKey || NO_KEY) : (hasKey ? rawKey : (p.needsKey ? '' : NO_KEY)),
    model,
    tier,
    hasKey,
    // The corrected readiness gate: a keyless local provider with a model set
    // is ready. The old `!!apiKey && !!model` made that state unreachable.
    ready: keySatisfied && endpointSatisfied && !!model,
    reason: !keySatisfied
      ? `Add an API key for ${label} in Settings.`
      : (!endpointSatisfied ? `${label} is not running. Download it in Settings.`
        : (!model ? `Pick a ${tier} model for ${label} in Settings.` : null))
  };
}

/**
 * Routes: one provider AND model per reasoning tier.
 *
 * The old shape was a single global `settings.provider`, with a boolean choosing
 * between a fast/smart pair INSIDE that provider. That makes the app
 * provider-bound: you could not run a small local model for quick answers and
 * a large cloud model for hard ones, which is the obvious setup for anyone who
 * has both.
 *
 * A route is `{ provider, model }`. Tiers are fully independent, so:
 *
 *     simple  -> (in the box)   / small local model  (1.4.0; borrows General now)
 *     general -> ollama         / llama3.2           (622ms warm, local, private)
 *     smart   -> anthropic      / claude-sonnet-5    (slower, far more capable)
 *
 * This also sidesteps the single-slot reload problem measured in warmth.js: if
 * the two tiers live on DIFFERENT servers, toggling between them costs nothing,
 * because neither server has to evict anything.
 */
const TIERS = ['simple', 'general', 'smart'];

/** What each tier is called on screen, and what picking it means. */
const TIER_LABELS = {
  simple: 'Simple',
  general: 'General',
  smart: 'Smart'
};

/**
 * Every routable slot, including the optional vision hand-off.
 *
 * TIERS is the ladder the indicator cycles through; 'vision' is not one of
 * those, but it is a route and has to resolve like one. Keeping the two lists
 * separate is what was missing: `createLLM(settings, 'vision')` fell through to
 * the provider-id branch, looked for a provider literally called "vision",
 * found none, and crashed -- so the vision hand-off in main.js could never fire.
 */
const ROUTE_TIERS = [...TIERS, 'vision'];

/** The tier currently answering. Anything unrecognised means General. */
function activeTier(settings) {
  const t = settings && settings.tier;
  return TIERS.includes(t) ? t : 'general';
}

function routeFor(settings, tier) {
  const t = ROUTE_TIERS.includes(tier) ? tier : activeTier(settings);
  const routes = (settings && settings.routes) || {};
  let r = routes[t] || {};
  /**
   * Simple borrows General until it has a model of its own.
   *
   * The tier is a promise about how much thinking is applied, not about which
   * binary is running, and the floor of that promise has to exist on a machine
   * where nothing is configured yet. An unset Simple route therefore answers
   * from General rather than being an unpickable tier that reports itself
   * broken. 1.4.0 fills it in and this fallback stops mattering.
   *
   * The MODEL decides, not the provider: a Simple route naming a provider but
   * no model would otherwise fall through to that provider's own default entry,
   * which is a different model from General's and nobody asked for it.
   */
  if (t === 'simple' && !(r.model || '').trim()) r = routes.general || {};
  return { tier: t, provider: r.provider || null, model: (r.model || '').trim() };
}

/**
 * Resolve the provider for a tier, honouring that tier's own provider choice.
 *
 * Falls back to the legacy single-provider shape when no route is configured,
 * so an un-migrated settings file still works.
 */
function resolveTier(settings, tier) {
  const route = routeFor(settings, tier);
  // An unset vision route means "no hand-off", not "fall back to the global
  // provider" -- falling back would send screen questions to the same text-only
  // model the hand-off exists to avoid.
  if (route.tier === 'vision' && !route.provider) return null;
  const providerId = route.provider || settings.provider;
  const base = resolve(settings, providerId);
  if (!base) return null;

  // The route's model wins over the provider's own fast/smart entry. Falling
  // back keeps a partially-configured route usable instead of dead.
  const model = route.model || base.model;

  return {
    ...base,
    model,
    // resolve() answered for the provider's own fast/smart entry, which is a
    // DIFFERENT model from the one this route actually calls. Re-asking here is
    // what stops one provider's text-only model from being described by the
    // capabilities of another.
    vision: visionFor(settings, providerId, model),
    contextWindow: contextWindowFor(settings, providerId, model),
    tier: route.tier,
    routed: !!route.provider,
    ready: (base.needsKey ? base.hasKey : true) && (!base.managed || !!base.baseURL) && !!model,
    reason: (base.needsKey && !base.hasKey)
      ? `Add an API key for ${base.label} in Settings.`
      : (base.managed && !base.baseURL) ? `${base.label} is not running. Download it in Settings.`
        : (!model ? `Pick a model for the ${route.tier} tier in Settings.` : null)
  };
}

/**
 * Is there a provider that is not ours to run?
 *
 * The supervisor asks this to decide whether the downloaded model should be
 * resident at all: the promise is that a user never has both a real provider
 * and our own model in memory. General and Smart are the tiers that answer real
 * questions, so a working route on either is what counts -- a Simple route
 * pointed at somebody else's local server counts too, since it is theirs to run.
 *
 * Configured, not reachable. This module has never opened a socket and should
 * not start: the store ships with an Ollama route filled in, so on a machine
 * that never installed Ollama this returns a provider that answers nothing.
 * Callers that are about to act on the answer check liveness themselves --
 * see externalWorking() in main.js.
 */
function externalReady(settings) {
  for (const t of TIERS) {
    const r = resolveTier(settings, t);
    if (r && r.ready && !r.managed) return r;
  }
  return null;
}

/**
 * The three tiers, and whether each one is available yet.
 *
 * Tiers are earned, not hidden. A user with nothing configured can still see
 * that General and Smart exist and read one sentence saying what would turn
 * them on -- which is the difference between an app that looks limited and an
 * app that looks broken.
 *
 * Simple is never locked: routeFor() falls back to General, and 1.4.0 gives it
 * a model that needs no configuration at all. General wants any working route.
 * Smart wants its own route to be working, because that is the whole point of
 * a tier you step up to; falling back to the same model as General would make
 * the step a lie.
 */
function tiers(settings) {
  const active = activeTier(settings);
  const general = resolveTier(settings, 'general');
  const smart = resolveTier(settings, 'smart');
  const anyReady = (general && general.ready) || (smart && smart.ready);

  const state = {
    simple: { unlocked: true, reason: null },
    general: {
      unlocked: !!anyReady,
      reason: 'Connect a provider or a local server in Settings.'
    },
    smart: {
      unlocked: !!(smart && smart.ready),
      reason: (smart && smart.reason) || 'Set a model for the Smart tier in Settings.'
    }
  };

  return TIERS.map((id) => {
    const r = resolveTier(settings, id);
    return {
      id,
      label: TIER_LABELS[id],
      active: id === active,
      unlocked: state[id].unlocked,
      reason: state[id].unlocked ? null : state[id].reason,
      provider: r ? r.id : null,
      model: r ? r.model : null,
      ready: !!(r && r.ready)
    };
  });
}

/**
 * Which model would compress this conversation, and whether it is a step up.
 *
 * Compaction decides what every later answer is built on, so running it on a
 * model that is already struggling with the length is a real trade-off rather
 * than a free win. It is still better than the silent truncation it replaces, so
 * this reports rather than refuses and the caller decides.
 *
 * `distinct` compares General against Smart, not the compressor against whatever
 * happens to be answering right now. With Smart selected, the smart model is
 * both the answerer and the compressor, and that is the best case rather than a
 * degraded one -- comparing those two would flag it as "one model" and warn
 * about the strongest configuration the user can have.
 *
 * Same provider AND same model is what counts as one model. A different provider
 * serving the same model name is still one model in every way that matters here,
 * and two models on one provider are two models.
 */
function compactorFor(settings) {
  const general = resolveTier(settings, 'general');
  const smart = resolveTier(settings, 'smart');

  if (!smart || !smart.ready) {
    return {
      ok: false,
      distinct: false,
      provider: smart ? smart.id : null,
      model: smart ? smart.model : null,
      reason: (smart && smart.reason) || 'No smart model is configured.'
    };
  }

  const same = !!general && general.id === smart.id && general.model === smart.model;

  return {
    ok: true,
    distinct: !same,
    provider: smart.id,
    label: smart.label,
    model: smart.model,
    reason: null
  };
}

/**
 * Capability classification for a /v1/models entry.
 *
 * Servers disagree wildly about what they put here, so this reads whatever is
 * present and degrades to heuristics. Lemonade (and a few others) return a
 * `labels` array that states capabilities outright:
 *
 *   ["cloud"]                              -> a chat model, text only
 *   ["vision","reasoning","tool-calling"]  -> chat model that accepts images
 *   ["transcription","realtime-transcription"] -> speech to text
 *   ["tts"]                                -> text to speech
 *
 * That is strictly better than guessing from the model name, which is what most
 * clients do. When labels are absent we fall back to name matching, which is
 * wrong often enough that the UI must stay overridable by hand.
 */
const CTX_FIELDS = [
  'max_context_window',  // Lemonade
  'context_length',      // LM Studio, llama.cpp
  'max_model_len',       // vLLM
  'n_ctx',               // llama.cpp server
  'context_window',
  'max_position_embeddings'
];

function readContextWindow(m) {
  for (const f of CTX_FIELDS) {
    const v = m && m[f];
    if (typeof v === 'number' && v > 0) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  // Some servers nest it.
  const meta = (m && (m.meta || m.metadata || m.settings)) || null;
  if (meta) for (const f of CTX_FIELDS) {
    const v = meta[f];
    if (typeof v === 'number' && v > 0) return v;
  }
  return null;
}

const STT_NAME = /whisper|wav2vec|parakeet|distil-whisper|speech[-_]?to[-_]?text|\bstt\b|transcrib/i;
const TTS_NAME = /kokoro|piper|bark|xtts|styletts|speecht5|text[-_]?to[-_]?speech|\btts\b|voice/i;
const VISION_NAME = /vision|vl\b|-vl-|llava|moondream|internvl|qwen2?\.?5?-vl|gpt-4o|gemini|claude-3|pixtral|minicpm-v/i;
const EMBED_NAME = /embed|bge-|gte-|e5-|nomic-embed|rerank/i;

/**
 * Declared input/output modalities, which several servers state outright even
 * when they publish no `labels` array:
 *
 *   vLLM                   input: ["text","image"]  output: ["text","thought"]
 *   OpenRouter             architecture.input_modalities / output_modalities
 *   others                 modalities: { input: [...], output: [...] }
 *
 * This is authoritative and was being thrown away. The consequence was concrete:
 * a server that says a model accepts images had that ignored, VISION_NAME failed
 * to match the model id, and every screen question silently went out without the
 * screenshot -- so the app answered a question it could not see.
 */
function readModalities(m) {
  const arch = (m && m.architecture) || {};
  const mod = (m && m.modalities) || {};
  const pick = (...cands) => {
    for (const c of cands) if (Array.isArray(c)) return c.map((x) => String(x).toLowerCase());
    return null;
  };
  const input = pick(m && m.input, arch.input_modalities, mod.input);
  const output = pick(m && m.output, arch.output_modalities, mod.output);
  if (!input && !output) return null;
  return { input: input || [], output: output || [] };
}

function classifyModel(m) {
  const id = (m && (m.id || m.name)) || '';
  const labels = Array.isArray(m && m.labels) ? m.labels.map((x) => String(x).toLowerCase()) : [];
  const hasLabels = labels.length > 0;
  const modal = readModalities(m);

  const isStt = hasLabels
    ? labels.some((l) => l.includes('transcription') || l === 'stt' || l === 'asr')
    : STT_NAME.test(id);
  const isTts = hasLabels ? labels.includes('tts') : TTS_NAME.test(id);
  const isEmbed = hasLabels
    ? labels.some((l) => l.includes('embed') || l.includes('rerank'))
    : EMBED_NAME.test(id);

  // Vision is the one that matters most: sending an image to a text-only model
  // is a hard failure, and on some servers it fails INSIDE a 200 response.
  // Precedence is stated-capability first, name-guessing only as a last resort.
  const vision = hasLabels ? labels.includes('vision')
    : modal ? modal.input.includes('image')
    : VISION_NAME.test(id);

  // Audio IN does not make a transcription model: an omni chat model accepts
  // speech alongside text and is still the thing you talk to, not the thing that
  // transcribes for you. Only a model with no text input is an STT endpoint.
  const audio = modal ? modal.input.includes('audio') : false;

  return {
    id,
    // Servers that ship a human-readable name are worth showing it for; an id
    // like "qwen3.5-397b-a17b" tells a user much less than "Qwen 3.5 397B".
    name: (m && m.name && m.name !== id) ? String(m.name) : '',
    labels,
    // A chat model is anything that is not clearly a non-chat role.
    chat: !isStt && !isTts && !isEmbed,
    stt: isStt,
    tts: isTts,
    embed: isEmbed,
    vision,
    audio,
    // Whether the capabilities above are authoritative or a guess. The UI says
    // so, because a wrong guess here produces a confusing backend error.
    capabilitiesKnown: hasLabels || !!modal,
    contextWindow: readContextWindow(m),
    // "thought" in the output modalities is a reasoning model announcing that it
    // will spend tokens thinking before it answers. src/llm.js needs to know.
    reasoning: hasLabels ? labels.includes('reasoning') : !!(modal && modal.output.includes('thought')),
    tools: labels.includes('tool-calling'),
    // Some servers list models that are registered but not loaded.
    status: (m && m.status) ? String(m.status) : ''
  };
}

/**
 * Per-model capabilities.
 *
 * Vision used to be a single boolean per PROVIDER. That cannot be right: one
 * OpenAI-compatible endpoint commonly serves a vision model and a text-only one
 * side by side, and the settings UI wrote the flag from whichever model happened
 * to be selected in an unrelated field. The observed failure was exact -- a
 * provider serving both gemma (sees) and deepseek (does not) was stamped
 * `vision: false`, so every screen question went out without the screenshot and
 * the model answered a question it could not see.
 *
 * Capabilities are therefore keyed by provider AND model. `settings.modelInfo`
 * is a learned cache: what a server declared in /v1/models, what a request
 * proved at runtime, or what the user set by hand.
 */
function capabilityKey(providerId, modelId) {
  return `${providerId}::${String(modelId || '').trim()}`;
}

function modelInfoFor(settings, providerId, modelId) {
  const model = String(modelId || '').trim();
  if (!model) return null;
  return ((settings && settings.modelInfo) || {})[capabilityKey(providerId, model)] || null;
}

/**
 * Can this exact model accept an image?
 *
 *   true  — known to see.
 *   false — known NOT to see; a screenshot must not be attached.
 *   null  — UNKNOWN, which is not the same as no.
 *
 * The tri-state is the whole point. Collapsing unknown to false is what made
 * vision feel broken: a capable model stayed blind until the user found a
 * checkbox, and the checkbox was then overwritten. Callers treat null as
 * "attach it and find out" -- a model that cannot see rejects the request, and
 * that rejection is recorded here, so the wrong guess costs one retry once.
 */
function visionFor(settings, providerId, modelId) {
  const info = modelInfoFor(settings, providerId, modelId);
  if (info && typeof info.vision === 'boolean') return info.vision;
  // Names are evidence FOR vision and never against it: "gemma-4-31b-it" looks
  // text-only and is not, which is precisely the case that broke.
  if (VISION_NAME.test(String(modelId || ''))) return true;
  const p = get(settings, providerId);
  if (p && p.vision === true) return true;
  return null;
}

function contextWindowFor(settings, providerId, modelId) {
  const info = modelInfoFor(settings, providerId, modelId);
  return info && typeof info.contextWindow === 'number' ? info.contextWindow : null;
}

/**
 * How big this model's context window is, and how much that answer is worth.
 *
 * Always returns a number, because the alternative -- refusing to say anything
 * about a model nobody declared a window for -- means no fill bar and no warning
 * for exactly the self-hosted endpoints most likely to have a small one.
 *
 * `source` is what the caller shows the user. A 'guess' is rendered as an
 * estimate and never triggers automatic compression on its own: it can warn and
 * it can offer, but acting on a number nobody vouched for would compress
 * conversations that had plenty of room left.
 */
function contextBudgetFor(settings, providerId, modelId) {
  const info = modelInfoFor(settings, providerId, modelId);
  if (info && typeof info.contextWindow === 'number') {
    return {
      tokens: info.contextWindow,
      source: info.windowSource || info.source || 'server',
      guessed: false
    };
  }
  const named = tokens.windowFromName(modelId);
  if (named) return { tokens: named, source: 'name', guessed: true };
  return { tokens: tokens.DEFAULT_WINDOW, source: 'guess', guessed: true };
}

/** Measured characters-per-token for this model, or null if never calibrated. */
function charsPerTokenFor(settings, providerId, modelId) {
  const info = modelInfoFor(settings, providerId, modelId);
  return info && typeof info.charsPerToken === 'number' ? info.charsPerToken : null;
}

/**
 * Fold what we just learned about a model into a settings patch.
 *
 * `source` records how we know, so weaker evidence cannot quietly undo stronger:
 *
 *   user   — said so by hand. Final.
 *   probe  — a real request the model accepted or rejected. Ground truth, and
 *            therefore stronger than a claim: servers do misdeclare.
 *   server — /v1/models said so.
 *   guess  — the model name looked like it.
 *
 * `override` exists for a user-initiated refresh, which must be able to clear a
 * stale probe result: a Refresh button that cannot change the answer is broken.
 */
const INFO_RANK = { guess: 0, server: 1, probe: 2, user: 3 };

/**
 * Evidence ranking for the context window, kept SEPARATE from the vision rank.
 *
 * The two facts are learned from different events and would otherwise interfere:
 * a window observed from an ordinary successful request would raise the record's
 * rank and then block a later, better answer about vision -- or vice versa. One
 * shared `source` field cannot describe two independently-sourced facts.
 *
 *   observed — a request of this size was accepted, so the window is at least
 *              this big. A floor, never an exact figure.
 *   server   — /v1/models declared it. Often a build-time default rather than
 *              the n_ctx the server was actually started with.
 *   error    — the provider REJECTED a request and stated its own maximum. The
 *              strongest evidence available short of the user, and free: the
 *              request had already failed.
 *   user     — typed in by hand. Final.
 */
const WINDOW_RANK = { guess: 0, name: 0, observed: 1, server: 2, error: 3, user: 4 };

/**
 * Fold what we just learned about a model into a settings patch.
 *
 * `facts` may carry any of: vision, contextWindow, charsPerToken. Each is
 * guarded by the evidence that applies to it -- `source` for vision,
 * `windowSource` for the window -- so learning one never suppresses the other.
 */
function learnModel(settings, providerId, modelId, facts, source = 'server', { override = false, windowSource } = {}) {
  const model = String(modelId || '').trim();
  if (!providerId || !model) return null;
  const key = capabilityKey(providerId, model);
  const prev = ((settings && settings.modelInfo) || {})[key] || {};

  const next = { ...prev };
  let changed = false;

  if (typeof facts.vision === 'boolean') {
    if (override || !(INFO_RANK[prev.source] > INFO_RANK[source])) {
      if (next.vision !== facts.vision || prev.source !== source) changed = true;
      next.vision = facts.vision;
      next.source = source;
    }
  } else if (prev.source !== source && (override || !(INFO_RANK[prev.source] > INFO_RANK[source]))) {
    // Keep the old behaviour for callers that pass a source but no vision fact.
    if (facts.contextWindow == null && facts.charsPerToken == null) {
      next.source = source;
      changed = true;
    }
  }

  if (typeof facts.contextWindow === 'number') {
    const ws = windowSource || source;
    const prevWs = prev.windowSource || (typeof prev.contextWindow === 'number' ? (prev.source || 'server') : null);
    const beaten = prevWs && WINDOW_RANK[prevWs] > WINDOW_RANK[ws];
    /**
     * An 'observed' floor may only ever RAISE the number.
     *
     * It is evidence that a prompt of that size fit, which says nothing about
     * the ceiling. Letting it lower a known window would shrink a 128k model to
     * whatever the last short question happened to be.
     */
    const lowering = typeof next.contextWindow === 'number' && facts.contextWindow < next.contextWindow;
    const allowed = override || (!beaten && !(ws === 'observed' && lowering));
    if (allowed && next.contextWindow !== facts.contextWindow) {
      next.contextWindow = facts.contextWindow;
      next.windowSource = ws;
      changed = true;
    } else if (allowed && next.windowSource !== ws) {
      next.windowSource = ws;
      changed = true;
    }
  }

  if (typeof facts.charsPerToken === 'number') {
    // A measurement, not a claim: no ranking, the newest blended value wins.
    if (next.charsPerToken !== facts.charsPerToken) {
      next.charsPerToken = facts.charsPerToken;
      changed = true;
    }
  }

  // Nothing new to say is not a write.
  return changed ? { modelInfo: { [key]: next } } : null;
}

/**
 * Turn an HTTP status from a bare endpoint into the sentence a user can act on.
 * "HTTP 401 from https://.../models" tells you nothing about which of the two
 * fields on screen is wrong.
 */
function httpHint(status, base, p) {
  const who = (p && p.label) || 'the server';
  if (status === 401 || status === 403) {
    return p && p.hasKey
      ? `${who} rejected the API key (HTTP ${status}). Check the key, and that it belongs to ${base}.`
      : `${who} requires an API key (HTTP ${status}). Paste one into the API key field.`;
  }
  if (status === 404) {
    return `No model list at ${base}/models (HTTP 404). The base URL usually has to end in /v1.`;
  }
  if (status === 429) return `${who} is rate-limiting this key (HTTP 429). Wait and retry.`;
  if (status >= 500) return `${who} returned HTTP ${status}. The server is up but erroring.`;
  return `HTTP ${status} from ${base}/models`;
}

/**
 * A model list changes when a server restarts, not between two keystrokes -- but
 * the settings UI re-asks every time a provider row opens, a tier switches or a
 * tab is re-entered. Each of those was a fresh HTTP round trip, and against a
 * cold local server that is the difference between an instant list and a stall.
 *
 * Failures are cached far more briefly than successes: long enough to absorb a
 * burst of re-renders against a server that is down, short enough that a server
 * which just came up is not reported dead.
 */
const DISCOVERY_TTL_MS = 60000;
const DISCOVERY_FAIL_TTL_MS = 2000;
const discoveryCache = new Map();

/**
 * Provider + endpoint + key identify a distinct model list, so changing any of
 * the three has to miss. The key is hashed, never stored: this map is
 * process-lifetime state and nothing holding credentials should be.
 *
 * '|' as the delimiter, not a control character: an id is a slug, a base URL
 * carries no bare '|', and a fingerprint is hex, so it cannot collide -- and a
 * literal control byte in source makes git treat the whole file as binary.
 */
function discoveryKey(id, base, apiKey) {
  const fp = apiKey ? crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16) : '';
  return `${id}|${base}|${fp}`;
}

/** Drop cached lists. Called when settings change so edits are never masked. */
function clearDiscoveryCache() { discoveryCache.clear(); }

/**
 * Ask an OpenAI-compatible server what it actually has loaded.
 *
 * This runs in the MAIN process on purpose. The renderer's CSP is
 * `default-src 'self'`, so it cannot fetch http://127.0.0.1:11434 -- a
 * renderer-side implementation would be silently blocked. Ollama, LM Studio,
 * Lemonade and vLLM all expose /v1/models, so one code path covers them.
 *
 * Returns classified objects, not bare id strings, so the UI can offer only
 * speech models for transcription and only vision models where an image is
 * going to be attached.
 *
 * Pass `force` for a user-initiated refresh, which must always hit the network:
 * a Refresh button that can return a cached answer is a broken Refresh button.
 */
async function discoverModels(settings, id, { timeoutMs = 6000, force = false } = {}) {
  const p = resolve(settings, id);
  if (!p) return { ok: false, error: 'unknown provider', models: [] };
  if (p.kind !== OPENAI_COMPATIBLE) {
    return { ok: false, error: `${p.label} has no model-list endpoint; type the model name.`, models: [] };
  }
  const base = (p.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');

  const ck = discoveryKey(id, base, p.apiKey === NO_KEY ? '' : p.apiKey);
  if (!force) {
    const hit = discoveryCache.get(ck);
    if (hit && hit.expires > Date.now()) return hit.value;
  }

  const remember = (value) => {
    discoveryCache.set(ck, {
      value,
      expires: Date.now() + (value.ok ? DISCOVERY_TTL_MS : DISCOVERY_FAIL_TTL_MS)
    });
    return value;
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    // Any real key, whether the user typed it or the managed server minted it.
    // NO_KEY is a placeholder for servers that ignore auth; sending it is noise.
    if (p.apiKey && p.apiKey !== NO_KEY) headers.Authorization = `Bearer ${p.apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal });
    if (!res.ok) return remember({ ok: false, error: httpHint(res.status, base, p), models: [] });
    const json = await res.json();
    const raw = json && Array.isArray(json.data) ? json.data : [];
    const models = raw
      .map(classifyModel)
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    return remember({
      ok: true,
      models,
      baseURL: base,
      // True when the server told us capabilities rather than us guessing.
      classified: models.some((m) => m.capabilitiesKnown)
    });
  } catch (e) {
    const msg = e && e.name === 'AbortError'
      ? `No response from ${base} within ${timeoutMs}ms. Is the server running?`
      : (e && e.message) || String(e);
    return remember({ ok: false, error: msg, models: [] });
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  BUILTIN, BUILTIN_ORDER, NO_KEY, OPENAI_COMPATIBLE,
  list, get, labelOf, resolve, resolveTier, routeFor, activeTier, tiers,
  setLocalEndpoint, localEndpoint, externalReady,
  TIERS, TIER_LABELS, ROUTE_TIERS,
  capabilityKey, modelInfoFor, visionFor, contextWindowFor, contextBudgetFor,
  charsPerTokenFor, learnModel, compactorFor, INFO_RANK, WINDOW_RANK,
  discoverModels, clearDiscoveryCache, classifyModel, readContextWindow, readModalities, httpHint
};
