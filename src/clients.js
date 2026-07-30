'use strict';
/**
 * Shared SDK client cache.
 *
 * Provider SDK clients are cached rather than rebuilt per request. Each client
 * owns an HTTP agent with a live connection pool; constructing one per call
 * throws that pool away, so every request pays a fresh TCP and TLS handshake to
 * the provider. On a short chat reply that handshake is the dominant cost, and
 * on transcription -- which runs once per utterance -- it is paid constantly.
 *
 * This lives in its own module because both llm.js and stt.js need it and
 * neither should depend on the other to get it.
 */

const crypto = require('crypto');

/**
 * Bounded so cycling credentials cannot grow the map without limit. The entries
 * are just connection pools: dropping one costs the next handshake, nothing more.
 */
const CLIENT_CACHE_MAX = 8;
const cache = new Map();

/**
 * Get or build a client.
 *
 * Keyed by the three things that define a distinct connection: which SDK, which
 * endpoint, which credential. Editing a key in settings therefore builds a new
 * client on the next request instead of being pinned to a stale pool.
 *
 * The credential is hashed rather than used raw: this map is process-lifetime
 * state, and a key that never has to appear as a bare string should not.
 *
 * @param {string}   kind     SDK discriminator, e.g. 'openai'
 * @param {string}   baseURL  endpoint, '' for SDKs with a fixed one
 * @param {string}   apiKey   credential, '' for keyless local servers
 * @param {Function} build    called only on a miss
 */
function cachedClient(kind, baseURL, apiKey, build) {
  const fp = crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16);
  const key = `${kind} ${baseURL || ''} ${fp}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size >= CLIENT_CACHE_MAX) cache.clear();
  const made = build();
  cache.set(key, made);
  return made;
}

module.exports = { cachedClient };
