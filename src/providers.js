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

const OPENAI_COMPATIBLE = 'openai';

const BUILTIN = {
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
    // Most local checkpoints are text-only. Default off so a screen-capture
    // mode does not silently 400 on a model that cannot accept an image.
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

const BUILTIN_ORDER = ['ollama', 'lmstudio', 'openai', 'anthropic', 'gemini', 'nvidia'];

/** Placeholder key. The OpenAI SDK throws on an empty apiKey even when the
 *  endpoint ignores auth entirely, which is the normal case for local servers. */
const NO_KEY = 'cue-local';

function customList(settings) {
  return Array.isArray(settings && settings.customProviders) ? settings.customProviders : [];
}

/** Every provider the user can pick, built-in and custom, in display order. */
function list(settings) {
  const out = BUILTIN_ORDER.map((id) => ({ ...BUILTIN[id] }));
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
  const tier = settings.smart ? 'smart' : 'fast';
  const models = (settings.models || {})[p.id] || {};
  const model = (models[tier] || p.defaults[tier] || '').trim();

  // A user-set override wins over the descriptor default.
  const baseURL = (models.baseURL || p.baseURL || null);
  const vision = typeof models.vision === 'boolean' ? models.vision : p.vision;
  const contextWindow = typeof models.contextWindow === 'number' ? models.contextWindow : null;

  // A user-supplied display name wins. Pointing the built-in "Ollama" slot at an
  // unrelated OpenAI-compatible server made every error message read
  // "Ollama: ..." for a server that has nothing to do with Ollama.
  const label = (models.label || '').trim() || p.label;

  const hasKey = !!rawKey;
  const keySatisfied = p.needsKey ? hasKey : true;

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
    apiKey: hasKey ? rawKey : (p.needsKey ? '' : NO_KEY),
    model,
    tier,
    hasKey,
    // The corrected readiness gate: a keyless local provider with a model set
    // is ready. The old `!!apiKey && !!model` made that state unreachable.
    ready: keySatisfied && !!model,
    reason: !keySatisfied
      ? `Add an API key for ${label} in Settings.`
      : (!model ? `Pick a ${tier} model for ${label} in Settings.` : null)
  };
}

/**
 * Routes: one provider AND model per reasoning tier.
 *
 * The old shape was a single global `settings.provider`, with `smart` choosing
 * between a fast/smart pair INSIDE that provider. That makes the app
 * provider-bound: you could not run a small local model for quick answers and
 * a large cloud model for hard ones, which is the obvious setup for anyone who
 * has both.
 *
 * A route is `{ provider, model }`. Tiers are fully independent, so:
 *
 *     fast  -> ollama        / llama3.2          (622ms warm, local, private)
 *     smart -> anthropic     / claude-sonnet-5   (slower, far more capable)
 *
 * This also sidesteps the single-slot reload problem measured in warmth.js: if
 * the two tiers live on DIFFERENT servers, toggling between them costs nothing,
 * because neither server has to evict anything.
 */
const TIERS = ['fast', 'smart'];

/**
 * Every routable slot, including the optional vision hand-off.
 *
 * TIERS is the fast/smart PAIR the Smart toggle switches between; 'vision' is
 * not one of those, but it is a route and has to resolve like one. Keeping the
 * two lists separate is what was missing: `createLLM(settings, 'vision')` fell
 * through to the provider-id branch, looked for a provider literally called
 * "vision", found none, and crashed -- so the vision hand-off in main.js could
 * never fire.
 */
const ROUTE_TIERS = ['fast', 'smart', 'vision'];

function routeFor(settings, tier) {
  const t = ROUTE_TIERS.includes(tier) ? tier : (settings && settings.smart ? 'smart' : 'fast');
  const routes = (settings && settings.routes) || {};
  const r = routes[t] || {};
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
    tier: route.tier,
    routed: !!route.provider,
    ready: (base.needsKey ? base.hasKey : true) && !!model,
    reason: (base.needsKey && !base.hasKey)
      ? `Add an API key for ${base.label} in Settings.`
      : (!model ? `Pick a model for the ${route.tier} tier in Settings.` : null)
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
 *   Academic Cloud / vLLM  input: ["text","image"]  output: ["text","thought"]
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

  const ck = discoveryKey(id, base, p.hasKey ? p.apiKey : '');
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
    if (p.hasKey) headers.Authorization = `Bearer ${p.apiKey}`;
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
  list, get, labelOf, resolve, resolveTier, routeFor, TIERS, ROUTE_TIERS,
  discoverModels, clearDiscoveryCache, classifyModel, readContextWindow, readModalities, httpHint
};
