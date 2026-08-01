'use strict';
/**
 * Token estimation and context-window inference.
 *
 * Nothing here talks to a tokenizer. Shipping tiktoken or a per-model vocabulary
 * would add tens of megabytes to an installer to answer a question that only has
 * to be approximately right: every consumer of this number uses it to decide
 * WHEN to act, with a margin, not to fill a context window to its last slot.
 *
 * The baseline is chars/4, which is close for English prose and wrong by roughly
 * 2x for CJK. Rather than live with that, the ratio is CALIBRATED per model from
 * the `usage` figures providers return alongside a completion: one real
 * prompt_tokens against the characters we know we sent is a direct measurement
 * of that model's tokenizer on that user's actual language. It converges after a
 * couple of turns and is stored per model in settings.modelInfo.
 *
 * The margin still matters, because the first conversation on a new model is
 * uncalibrated. That is why the compression trigger sits near the middle of the
 * budget and not at its edge.
 */

const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Assumed window for a model nobody has declared one for.
 *
 * 32k, deliberately not something optimistic like 100k. The two failure
 * directions are not symmetric: guessing low costs one compression that was not
 * strictly needed, while guessing high means no warning, no compression, and a
 * request that dies at the provider mid-conversation with a wall of JSON. A
 * cautious guess degrades; an optimistic one breaks.
 */
const DEFAULT_WINDOW = 32768;

/**
 * Ratios outside this band are measurement noise, not a tokenizer.
 *
 * A single short prompt against a server that counts a large fixed template
 * overhead into prompt_tokens can produce a ratio near zero, which would then
 * treble every subsequent estimate. Clamping keeps one bad sample from
 * poisoning the model's calibration.
 */
const MIN_RATIO = 1.5;
const MAX_RATIO = 8;

function clampRatio(r) {
  if (!Number.isFinite(r) || r <= 0) return null;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

/** Rough token count for one string. */
function estimate(text, charsPerToken) {
  const s = typeof text === 'string' ? text : String(text || '');
  if (!s) return 0;
  const r = clampRatio(charsPerToken) || DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(s.length / r);
}

/** Rough token count for a list of transcript turns or chat messages. */
function estimateTurns(turns, charsPerToken) {
  if (!Array.isArray(turns)) return 0;
  let n = 0;
  // Four tokens per turn for the role/delimiter framing every chat format adds.
  for (const t of turns) n += estimate((t && (t.text || t.content)) || '', charsPerToken) + 4;
  return n;
}

/** Characters per token, measured. Returns null when the sample is unusable. */
function measureRatio(chars, tokens) {
  if (!Number.isFinite(chars) || !Number.isFinite(tokens)) return null;
  // Very short prompts are dominated by fixed framing overhead and measure the
  // template, not the tokenizer.
  if (chars < 200 || tokens < 20) return null;
  return clampRatio(chars / tokens);
}

/**
 * Fold a new measurement into the running one.
 *
 * Weighted rather than replaced: a single turn that happened to be a code block
 * or a URL is not representative of the conversation, and letting the newest
 * sample win outright makes the estimate oscillate.
 */
function blendRatio(prev, next) {
  const n = clampRatio(next);
  if (n == null) return clampRatio(prev);
  const p = clampRatio(prev);
  if (p == null) return n;
  return clampRatio(p * 0.7 + n * 0.3);
}

/**
 * A context window stated in the model's own name.
 *
 * "gpt-4-32k", "…-instruct-128k", "…-1m" are all common and are the only free
 * evidence available for a server that declares nothing. Only a k or m suffix
 * counts: parameter counts ("31b", "405b") sit in the same position and mean
 * something else entirely, and reading one as a window would be worse than
 * having no guess at all.
 */
function windowFromName(modelId) {
  const s = String(modelId || '').toLowerCase();
  let best = null;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([km])(?![a-z0-9])/g)) {
    const n = parseFloat(m[1]) * (m[2] === 'm' ? 1000000 : 1000);
    // Below 2k is not a context window; above 2M is not a real claim.
    if (n < 2000 || n > 2000000) continue;
    if (best == null || n > best) best = n;
  }
  return best;
}

/**
 * A provider saying, in a rejection, how big its window actually is.
 *
 * This is the single most authoritative signal available -- more so than
 * /v1/models, which frequently reports a build-time default rather than the
 * n_ctx the server was actually started with. It costs nothing: the request had
 * already failed, and reading the number turns a dead end into a permanent fact.
 */
const LIMIT_PATTERNS = [
  // OpenAI, vLLM, Together, Groq, Fireworks
  /maximum context length is (\d[\d,]*)/i,
  /context length of (\d[\d,]*)/i,
  /context window of (\d[\d,]*)/i,
  // llama.cpp / Ollama
  /n_ctx\D{0,20}?(\d[\d,]*)/i,
  /context size\D{0,20}?(\d[\d,]*)/i,
  // Anthropic
  /prompt is too long: \d[\d,]* tokens > (\d[\d,]*)/i
];

/**
 * Last resort: "... exceeds the model's 8192 token limit".
 *
 * Only consulted when the message is talking about the context at all. A bare
 * "<number> ... limit" also describes a per-minute token QUOTA, and recording a
 * provider's rate limit as its context window would permanently cripple the
 * model -- 6000 tokens per minute is not a 6000-token window, but the app would
 * compress at 3300 tokens forever afterwards and never know why.
 */
const GENERIC_PATTERN = /(\d[\d,]*)\s*(?:token)?\s*(?:context )?limit/i;
const CONTEXT_HINT = /context|prompt|n_ctx|input.{0,12}too long/i;
const RATE_HINT = /rate.?limit|per (?:minute|hour|day|month)|\bt?pm\b|\brpm\b|quota|billing|usage tier/i;

function contextLimitFrom(message) {
  const msg = String(message || '');
  if (!msg) return null;
  for (const re of LIMIT_PATTERNS) {
    const m = re.exec(msg);
    if (!m) continue;
    const n = parseInt(String(m[1]).replace(/,/g, ''), 10);
    if (Number.isFinite(n) && n >= 512 && n <= 10000000) return n;
  }
  if (CONTEXT_HINT.test(msg) && !RATE_HINT.test(msg)) {
    const m = GENERIC_PATTERN.exec(msg);
    if (m) {
      const n = parseInt(String(m[1]).replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n >= 512 && n <= 10000000) return n;
    }
  }
  return null;
}

module.exports = {
  DEFAULT_CHARS_PER_TOKEN, DEFAULT_WINDOW, MIN_RATIO, MAX_RATIO,
  estimate, estimateTurns, measureRatio, blendRatio, windowFromName, contextLimitFrom
};
