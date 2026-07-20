'use strict';
/**
 * Keep-warm loop for single-slot local inference servers.
 *
 * ---------------------------------------------------------------------------
 * MEASURED on a Strix Halo box running Lemonade (128GB unified, NPU):
 *
 *   qwen3.5-2b-FLM, consecutive calls:
 *     call 1   7487ms      <- cold
 *     call 2    647ms
 *     call 5    622ms      <- warm, 12x faster
 *
 *   alternating two models:
 *     2b (warm)   620ms
 *     -> 4b      8323ms    <- reload
 *     -> 2b      7929ms    <- reload again
 *
 *   after a 20s idle gap:
 *     2b        15146ms    <- unloaded, and reload is slower than first load
 *
 * Three conclusions, all of which shape the app:
 *
 *   1. Local models are not slow, they are COLD. Warm TTFT of 622ms beats the
 *      cloud endpoint measured on the same box (2746ms).
 *   2. The server holds ONE chat model. Switching costs a full reload, so a
 *      fast/smart pair pointing at different models turns every toggle into an
 *      8-10s stall.
 *   3. It unloads on idle. An assistant that waits for you to speak is idle by
 *      definition, so the FIRST utterance after any pause pays ~15s. That is
 *      the common case, not an edge case.
 *
 * This module fixes (3) directly and warns about (2). It is the highest
 * value-to-effort change in the whole latency budget.
 * ---------------------------------------------------------------------------
 *
 * The ping is a 1-token completion, which is the cheapest thing that still
 * counts as use. Anything less (a /models GET) does not reset an inference
 * server's idle timer, because the model was never touched.
 */

const providers = require('./providers');

// Comfortably inside the ~20s idle window measured above, with room for a
// slow ping not to leave a gap.
const DEFAULT_INTERVAL_MS = 12000;
const PING_TIMEOUT_MS = 20000;

class WarmthKeeper {
  constructor({ getSettings, onEvent } = {}) {
    this.getSettings = getSettings;
    this.onEvent = onEvent || (() => {});
    this.timer = null;
    this.inFlight = false;
    this.enabled = false;
    this.lastPing = null;
    this.lastError = null;
    this.currentKey = null;   // provider::model actually kept warm
    this.stats = { pings: 0, failures: 0, lastMs: null };
    // Rolling TTFT measurements per provider::model, so the UI can show which
    // model is actually fast on THIS machine rather than guessing from size.
    this.ttft = new Map();
  }

  key(p) { return p ? p.id + '::' + p.model : null; }

  /** Record a real user-facing TTFT so the picker can surface it. */
  recordTTFT(providerId, model, ms) {
    if (!providerId || !model || !(ms > 0)) return;
    const k = providerId + '::' + model;
    const prev = this.ttft.get(k);
    // Exponential moving average; a single cold outlier should not define the
    // model, and a single warm hit should not hide that it goes cold.
    const next = prev ? Math.round(prev * 0.7 + ms * 0.3) : Math.round(ms);
    this.ttft.set(k, next);
  }

  getTTFT(providerId, model) {
    return this.ttft.get(providerId + '::' + model) || null;
  }

  /**
   * Warn when the fast/smart pair would thrash a single-slot server.
   * Returns null when there is nothing to say.
   */
  switchWarning(settings) {
    const s = settings || this.getSettings();
    const f = providers.resolveTier(s, 'fast');
    const m = providers.resolveTier(s, 'smart');
    if (!f || !m) return null;

    // Different providers is FINE and in fact ideal: two servers, no eviction.
    // The costly case is one local server being asked to hold two models.
    if (f.id !== m.id) return null;
    if (!f.local) return null;
    if (!f.model || !m.model || f.model === m.model) return null;

    return 'Fast and Smart use different models on the same local server. Local servers '
      + 'usually hold one model at a time, so toggling Smart forces a reload (measured '
      + '8-10s here). Point one tier at a different provider, or use the same model for both.';
  }

  start() {
    if (this.timer) return;
    this.enabled = true;
    this.timer = setInterval(() => this._tick(), DEFAULT_INTERVAL_MS);
    this._tick(); // warm immediately rather than waiting a full interval
    this.onEvent('warmth:state', { enabled: true });
  }

  stop() {
    this.enabled = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.currentKey = null;
    this.onEvent('warmth:state', { enabled: false });
  }

  /** Warm right now, e.g. the moment listening is switched on. */
  poke() { if (this.enabled) this._tick(); }

  async _tick() {
    if (this.inFlight || !this.enabled) return;

    const settings = this.getSettings();
    // Warm whichever provider the ACTIVE tier routes to -- with independent
    // routes the two tiers may be different servers entirely.
    const p = providers.resolveTier(settings, settings.smart ? 'smart' : 'fast');

    // Only local endpoints benefit. Pinging a metered cloud API on a timer
    // would burn tokens for nothing.
    if (!p || !p.ready || !p.local || p.kind !== providers.OPENAI_COMPATIBLE) return;

    this.inFlight = true;
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);

    try {
      const base = (p.baseURL || '').replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (p.hasKey) headers.Authorization = 'Bearer ' + p.apiKey;

      const res = await fetch(base + '/chat/completions', {
        method: 'POST', headers, signal: ctrl.signal,
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
          temperature: 0
        })
      });
      await res.text().catch(() => '');

      const ms = Date.now() - t0;
      this.stats.pings++;
      this.stats.lastMs = ms;
      this.lastPing = Date.now();
      this.lastError = null;

      const k = this.key(p);
      // A ping that took seconds means we arrived after an unload, or the model
      // changed under us. Either way the next real request is now warm.
      if (k !== this.currentKey) {
        this.currentKey = k;
        this.onEvent('warmth:loaded', { provider: p.id, model: p.model, ms });
      }
    } catch (e) {
      this.stats.failures++;
      this.lastError = (e && e.name === 'AbortError')
        ? 'warm ping timed out after ' + PING_TIMEOUT_MS + 'ms'
        : ((e && e.message) || String(e));
    } finally {
      clearTimeout(timer);
      this.inFlight = false;
    }
  }

  status() {
    return {
      enabled: this.enabled,
      warmModel: this.currentKey,
      lastPingMs: this.stats.lastMs,
      pings: this.stats.pings,
      failures: this.stats.failures,
      lastError: this.lastError,
      intervalMs: DEFAULT_INTERVAL_MS
    };
  }
}

module.exports = { WarmthKeeper, DEFAULT_INTERVAL_MS };
