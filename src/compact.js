'use strict';
/**
 * Context compaction — deciding what to compress, and how hard.
 *
 * The context window is finite and a conversation is not. Before this, the only
 * defence was history.contextTurns() slicing to the last twelve turns, which is
 * truncation: turn thirteen simply stopped existing, silently, with nothing on
 * screen to say so. The user noticed only when the assistant forgot something it
 * had been told.
 *
 * Compaction replaces that with a graded fold. Nothing is deleted -- every
 * original message stays in SQLite and in the full-text index, so History and
 * search always show the real conversation -- but what is SENT to the model
 * becomes one structured summary plus the recent turns verbatim.
 *
 * ---- the three bands ----------------------------------------------------
 *
 *   hot    the last few exchanges. Sent word for word, never compressed. This
 *          is where "explain that differently" finds its referent, and a
 *          paraphrase of the thing the user is looking at is worse than useless.
 *   warm   the exchanges just before those. Folded into the RECENT section as
 *          one line each: enough to know what was discussed and in what order,
 *          without the wording.
 *   cold   everything older. Folded into the narrative sections, where only
 *          decisions, open threads and hard identifiers survive.
 *
 * The bands are positional rather than semantic because relevance is not
 * something this can measure. Recency is a crude proxy, but it is an honest one,
 * and it never drops the thing the user just said.
 *
 * ---- append-only ---------------------------------------------------------
 *
 * The summary is APPENDED, not inserted. history.save() writes incrementally
 * keyed on (session, array index), so inserting a message in the middle would
 * renumber every message after it and corrupt the mapping between what is in
 * memory and what is on disk. Instead the summary records `covers`: the index of
 * the last message it folded in. Everything after that index is still live.
 */

const { estimateTurns } = require('./tokens');

const DEFAULTS = {
  /**
   * Fraction of the USABLE budget at which compaction runs on its own.
   *
   * Deliberately near the middle rather than the edge. Compaction is itself a
   * model call with a prompt built from the conversation, so triggering at 90%
   * would mean assembling a request that does not fit in order to make requests
   * fit. Half also leaves room for one long answer plus the turn after it, which
   * is what stops a session from compacting on every single message.
   */
  triggerPct: 0.55,
  /** Exchanges kept verbatim. Six is three back-and-forths. */
  keepHot: 6,
  /** Below this there is nothing worth a round trip. */
  minFold: 4,
  /** Of the folded turns, at most this many are treated as warm. */
  maxWarm: 6
};

/** Messages that are conversation rather than annotation. */
function isTurn(m) {
  return m
    && (m.role === 'user' || m.role === 'assistant')
    && String(m.content || '').trim().length > 0;
}

/**
 * Find the most recent compaction and what it already accounts for.
 *
 * Only the last one matters. Each compaction folds in the one before it, so
 * older summaries are superseded and injecting more than one would present the
 * same material at two different levels of detail.
 */
function lastSummary(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'summary' && String(m.content || '').trim()) {
      const covers = Number.isFinite(m.covers) ? m.covers : -1;
      return { index: i, covers, text: String(m.content) };
    }
  }
  return null;
}

/**
 * Split a conversation into what to fold and what to keep.
 *
 * Returns `{ ok: false, reason }` rather than throwing when there is nothing
 * worth doing: "not enough to compress" is an ordinary outcome, and the manual
 * button needs something to say.
 */
function grade(messages, opts) {
  const o = opts || {};
  let keepHot = Math.max(2, o.keepHot || DEFAULTS.keepHot);
  const minFold = Math.max(1, o.minFold || DEFAULTS.minFold);
  const maxWarm = Math.max(1, o.maxWarm || DEFAULTS.maxWarm);

  if (!Array.isArray(messages) || !messages.length) {
    return { ok: false, reason: 'There is nothing to compress yet.' };
  }

  const prev = lastSummary(messages);
  const floor = prev ? prev.covers : -1;

  /** Turns not yet accounted for by a previous compaction, with their indexes. */
  const live = [];
  for (let i = 0; i < messages.length; i++) {
    if (i <= floor) continue;
    if (!isTurn(messages[i])) continue;
    live.push({ index: i, role: messages[i].role, text: messages[i].content });
  }

  /**
   * A hot band measured in MESSAGES can be bigger than the whole window.
   *
   * One rambling answer that ran to the reply ceiling is a single message, and
   * six of those are pinned verbatim by a keepHot of six -- so compaction folds
   * the old turns, reports a 1% saving, and the context stays over budget for
   * the rest of the conversation. Every later compaction then has less and less
   * to work with while the thing actually filling the window is untouchable.
   *
   * So when the caller knows the budget, the band shrinks until what it holds
   * fits. Never below two: the last user message and the answer it is about are
   * what "explain that again" resolves against, and folding those is the one
   * thing this must never do.
   */
  const budget = typeof o.budget === 'number' && o.budget > 0 ? o.budget : null;
  if (budget) {
    while (keepHot > 2 && estimateTurns(live.slice(-keepHot), o.cpt) > budget) keepHot--;
  }

  const foldable = live.slice(0, Math.max(0, live.length - keepHot));
  if (foldable.length < minFold) {
    return {
      ok: false,
      reason: 'Only ' + live.length + ' exchange' + (live.length === 1 ? '' : 's')
        + ' since the last compression, and the last ' + keepHot
        + ' are always kept word for word — not enough left to be worth folding.'
    };
  }

  const warmCount = Math.min(maxWarm, Math.max(1, Math.ceil(foldable.length / 3)));
  const cold = foldable.slice(0, foldable.length - warmCount);
  const warm = foldable.slice(foldable.length - warmCount);

  return {
    ok: true,
    previous: prev ? prev.text : '',
    cold,
    warm,
    hot: live.slice(live.length - keepHot),
    /** What the band ended up being, after any budget-driven shrink. */
    keptHot: keepHot,
    /** Index of the last message this compaction accounts for. */
    covers: foldable[foldable.length - 1].index,
    folded: foldable.length,
    inputTokens: estimateTurns(cold.concat(warm)) + estimateTurns(prev ? [{ text: prev.text }] : [])
  };
}

/** Should this conversation be compacted before the next request goes out? */
function shouldCompact(snapshot, settings) {
  const c = (settings && settings.context) || {};
  if (c.autoCompact === false) return { yes: false, reason: 'off' };
  if (!snapshot) return { yes: false, reason: 'unknown' };

  /**
   * One model configured: warn on screen rather than acting.
   *
   * With a second, stronger tier the trade is obvious -- spend one better call
   * to keep the conversation coherent. With only one model, compaction is that
   * same model summarising a conversation it is already straining to hold, and
   * the summary it produces is what everything afterwards is built on. That is
   * the user's call to make, so this surfaces the choice and leaves the manual
   * button live. `single` is set by the caller, which is the only layer that can
   * see the route table.
   */
  if (snapshot.single) return { yes: false, reason: 'single' };

  /**
   * A pure guess never triggers a compression on its own.
   *
   * When nothing has declared a window, the 32k fallback is a cautious
   * assumption, not a measurement, and acting on it would compress
   * conversations that had plenty of room left -- destroying detail to solve a
   * problem that did not exist. It can still warn, and the manual button is
   * always available. A window read from the model's own name is weak evidence
   * but it is evidence, so that one does trigger.
   */
  if (snapshot.source === 'guess') return { yes: false, reason: 'guessed' };

  const trigger = typeof c.triggerPct === 'number' ? c.triggerPct : DEFAULTS.triggerPct;
  return { yes: snapshot.pct >= trigger, reason: 'full', trigger };
}

module.exports = { DEFAULTS, grade, lastSummary, shouldCompact, isTurn };
