'use strict';
/**
 * Audio digest — the consumer the listening pipeline never had.
 *
 * System audio was captured, VAD-segmented, transcribed, pushed onto the
 * transcript ring and broadcast to the UI, and then nothing read it. Every mode
 * that could act on it (translate, recap) only runs when a human presses a
 * button. So the app listened to a two-hour meeting and produced, on its own,
 * exactly nothing.
 *
 * This owns the decision of WHEN a block of heard speech is worth handing to a
 * model. It does not know what a model is: the caller supplies `onDigest`, which
 * receives a finished block and returns the one-line gist that heads the next
 * one. That split is deliberate -- the trigger logic below is the part with edge
 * cases, and it can be exercised without spending a token.
 *
 * ---- when a block fires -------------------------------------------------
 *
 * Three triggers, first one wins:
 *
 *   silence   >5s with no system audio. The natural boundary, and in a meeting
 *             or a call it is the one that fires almost every time.
 *   size      the pending block reaches ~900 tokens. This is the real guard
 *             against long-input drift: a wall-clock interval means one thing
 *             for a conversation with pauses and something three times larger
 *             for continuous narration, so content, not the clock, decides.
 *   ceiling   3 minutes regardless. A freshness floor for media that never
 *             pauses and never gets dense enough to trip the size cap.
 *
 * The clock ceiling is the weakest of the three and exists only so a user
 * watching an unbroken two-hour video is not left staring at nothing.
 *
 * ---- why a watermark rather than a drain --------------------------------
 *
 * Audio does not stop while a digest is being written. Turns that arrive during
 * a call accumulate behind the in-flight block and are spliced off only when
 * that block SUCCEEDS. A failed digest therefore leaves its material in place to
 * be retried with whatever arrived since, instead of being silently lost -- the
 * complaint this whole feature answers is audio going in and nothing coming out,
 * and a queue that drops on error would reintroduce it in a quieter form.
 */

const { estimateTurns } = require('./tokens');

const DEFAULTS = {
  /** Silence after which a block is considered finished. */
  silenceMs: 5000,
  /** Hard freshness ceiling for audio that never pauses. */
  ceilingMs: 180000,
  /** Size cap on the pending block, in estimated tokens. */
  maxTokens: 900,
  /**
   * Floor below which a block is never worth a model call.
   *
   * An energy VAD triggers on doors, coughs and keyboard clicks, and each one
   * transcribes to a few words and then trips the 5s silence timer on its own.
   * Without this a quiet room generates a steady drip of paid calls that
   * summarise nothing. Sub-threshold blocks are held, not discarded: if speech
   * follows, they become the head of the real block.
   */
  minWords: 40,
  /** Consecutive failures after which digesting stops until something changes. */
  maxFailures: 3
};

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings
 * @param {(...args) => void} deps.log
 * @param {(block) => Promise<{gist?: string}|void>} deps.onDigest
 */
function createDigest({ getSettings, log, onDigest }) {
  const say = log || (() => {});

  /** Turns heard but not yet digested, oldest first. */
  let pending = [];
  let inFlight = false;
  let silenceTimer = null;
  let ceilingTimer = null;
  let failures = 0;
  let muted = false;
  let listening = false;
  /** Gist of the previous block, so a long session reads as one thread. */
  let lastGist = '';
  let seq = 0;

  function cfg() {
    const a = (getSettings() || {}).audio || {};
    const num = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
    return {
      mode: a.digest || 'summarize',
      silenceMs: num(a.digestSilenceMs, DEFAULTS.silenceMs),
      ceilingMs: num(a.digestCeilingMs, DEFAULTS.ceilingMs),
      maxTokens: num(a.digestMaxTokens, DEFAULTS.maxTokens),
      minWords: num(a.digestMinWords, DEFAULTS.minWords)
    };
  }

  function clearSilence() { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; } }
  function clearCeiling() { if (ceilingTimer) { clearTimeout(ceilingTimer); ceilingTimer = null; } }

  function armSilence(ms) {
    clearSilence();
    silenceTimer = setTimeout(() => { silenceTimer = null; fire('silence'); }, ms);
  }

  function armCeiling(ms) {
    if (ceilingTimer) return;   // the ceiling measures the block, not the last turn
    ceilingTimer = setTimeout(() => { ceilingTimer = null; fire('ceiling'); }, ms);
  }

  function wordsIn(turns) {
    let n = 0;
    for (const t of turns) {
      const w = String((t && t.text) || '').trim();
      if (w) n += w.split(/\s+/).length;
    }
    return n;
  }

  /**
   * A transcribed turn arrived.
   *
   * Only 'them' is digested. The user's own microphone is push-to-talk in the
   * default configuration and is addressed to Nimbus, not overheard -- narrating
   * it back to them would be noise, and it is already the input to every mode.
   */
  function push(turn) {
    if (!turn || turn.channel !== 'them' || !String(turn.text || '').trim()) return;
    const c = cfg();
    if (c.mode === 'off' || muted) return;

    /**
     * A heard turn is itself proof that listening is on, so take it as such
     * rather than depending on the 'listen:state' message having arrived first.
     * The flag only gates re-arming after a digest completes, and getting it
     * wrong would silently stop the second and every later block.
     */
    listening = true;
    pending.push(turn);

    if (estimateTurns(pending) >= c.maxTokens) {
      say('digest: size cap', estimateTurns(pending) + 'tok');
      fire('size');
      return;
    }

    armSilence(c.silenceMs);
    armCeiling(c.ceilingMs);
  }

  /**
   * Try to close the pending block.
   *
   * Returns without doing anything when a digest is already running: the timers
   * stay disarmed and the newly arrived turns simply wait, because whatever is
   * in flight will re-arm on completion with the full pending set in view.
   */
  function fire(reason) {
    if (inFlight || !pending.length) { if (!pending.length) clearCeiling(); return; }
    const c = cfg();
    if (c.mode === 'off' || muted) { clearSilence(); clearCeiling(); return; }

    // Not enough speech to be worth a call. Hold it and re-check later rather
    // than digesting a cough or discarding the start of a real sentence.
    if (wordsIn(pending) < c.minWords) {
      say('digest: held', wordsIn(pending) + 'w below floor', '(' + reason + ')');
      clearSilence();
      clearCeiling();
      armCeiling(c.ceilingMs);
      return;
    }

    clearSilence();
    clearCeiling();

    const block = {
      seq: ++seq,
      reason,
      mode: c.mode,
      gist: lastGist,
      turns: pending.slice(),
      from: pending[0].ts,
      to: pending[pending.length - 1].ts
    };
    const taken = block.turns.length;

    inFlight = true;
    say('digest: firing', '#' + block.seq, reason, taken + ' turns',
      estimateTurns(block.turns) + 'tok', Math.round((block.to - block.from) / 1000) + 's');

    Promise.resolve()
      .then(() => onDigest(block))
      .then((res) => {
        // Splice exactly what was sent. Anything that arrived during the call is
        // at the tail and stays pending.
        pending.splice(0, taken);
        if (res && typeof res.gist === 'string' && res.gist.trim()) lastGist = res.gist.trim();
        failures = 0;
      })
      .catch((e) => {
        // Leave `pending` untouched: the block is retried on the next trigger,
        // carrying whatever else has been heard since.
        failures++;
        say('digest: failed', '#' + block.seq, (e && e.message) || String(e), 'retries', failures);
        if (failures >= DEFAULTS.maxFailures && !muted) {
          muted = true;
          say('digest: muted after', failures, 'failures');
        }
      })
      .then(() => {
        inFlight = false;
        if (!listening || muted || !pending.length) return;
        const now = cfg();
        // Audio resumed while that was being written. Give it a real boundary
        // unless it has already outgrown one.
        if (estimateTurns(pending) >= now.maxTokens) fire('size');
        else { armSilence(now.silenceMs); armCeiling(now.ceilingMs); }
      });
  }

  /**
   * Listening turned on or off.
   *
   * Turning it off flushes: the last stretch of a meeting is exactly the part a
   * user wants written up, and the alternative is losing it because nobody
   * stopped talking for five seconds before the session ended.
   */
  function setListening(on) {
    const was = listening;
    listening = !!on;
    if (listening) {
      if (!was) { failures = 0; muted = false; }
      return;
    }
    clearSilence();
    clearCeiling();
    fire('stop');
  }

  /** Settings changed; whatever was failing may have just been fixed. */
  function reset() { failures = 0; muted = false; }

  /** Drop everything, cancel timers. For shutdown. */
  function stop() {
    clearSilence();
    clearCeiling();
    pending = [];
    listening = false;
  }

  function stats() {
    return {
      pending: pending.length,
      pendingTokens: estimateTurns(pending),
      pendingWords: wordsIn(pending),
      inFlight, failures, muted, listening, seq
    };
  }

  return { push, setListening, reset, stop, stats, flush: () => fire('manual') };
}

module.exports = { createDigest, DEFAULTS };
