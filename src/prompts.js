'use strict';
/**
 * Feature definitions. Each mode declares which inputs it needs and how to
 * build its prompt.
 *
 * ctx = { transcript: [{ channel:'you'|'them', text, ts }], userText, targetLang }
 */

function formatTranscript(turns, limit, channel) {
  let src = turns;
  if (channel) src = src.filter((t) => t.channel === channel);
  const recent = limit ? src.slice(-limit) : src;
  return recent.map((t) => (t.channel === 'them' ? 'Them: ' : 'You: ') + t.text).join('\n');
}

const MODES = {
  // One-shot "do the useful thing". Screen + recent conversation.
  assist: {
    needsScreen: true,
    userBubble: null,
    small: false,
    system:
      'You are Nimbus, a discreet real-time copilot overlaid on the user\'s screen. ' +
      'Look at the screenshot and the recent conversation, decide what the user needs RIGHT NOW, and deliver it with no preamble. ' +
      'If the screen shows a coding problem: give a short approach, then a correct solution in a fenced code block, then time and space complexity. ' +
      'If it is a conversation: answer the current question, or say exactly what the user should say next, in the first person. ' +
      'Be concise and specific. Never say "I can see" and never describe the screenshot.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 12);
      return 'Recent conversation:\n' + (t || '(none)') + '\n\nRespond with what I need right now.';
    }
  },

  say: {
    needsScreen: false,
    userBubble: 'What do I say?',
    small: false,
    system:
      'You are Nimbus, suggesting replies during a live conversation. ' +
      '"Them" is the other person; "You" is the user. Based on what Them just said and what You already said, ' +
      'draft ONE short, natural, confident reply the user can say out loud, in the first person. ' +
      'No quotes, no preamble, 1-3 sentences.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 14);
      return 'Conversation so far:\n' + (t || '(nothing heard yet)') + '\n\nWhat should I say next?';
    }
  },

  followup: {
    needsScreen: false,
    userBubble: 'Follow-ups',
    small: true,
    system:
      'You are Nimbus. Given the conversation, suggest 2-4 sharp, relevant follow-up questions the user could ask next. ' +
      'Return them as a short bullet list and nothing else.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 20);
      return 'Conversation so far:\n' + (t || '(none)') + '\n\nSuggest follow-up questions.';
    }
  },

  recap: {
    needsScreen: false,
    userBubble: 'Recap',
    small: true,
    system:
      'You are Nimbus. Summarise the conversation for someone who joined late: key points, decisions, action items. ' +
      'Short bullets under bold headers. Be brief.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 0);
      return 'Full transcript:\n' + (t || '(nothing captured yet)') + '\n\nRecap this.';
    }
  },

  /**
   * Live translation of whatever is playing.
   *
   * Uses the 'them' channel only -- that is the system-audio loopback, i.e. the
   * video, call or stream. Including the mic channel here would fold the user's
   * own speech into the translation.
   */
  translate: {
    needsScreen: false,
    userBubble: 'Translate',
    small: false,
    system:
      'You are Nimbus, translating audio the user is listening to. ' +
      'Translate the supplied lines into the target language, preserving speaker order and tone. ' +
      'Output ONLY the translation, one line per source line. No transliteration, no commentary, no source text. ' +
      'If a line is already in the target language, pass it through unchanged.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 25, 'them')
        || formatTranscript(ctx.transcript, 25);
      const lang = ctx.targetLang || 'English';
      return 'Target language: ' + lang + '\n\nLines:\n' + (t || '(nothing captured yet)');
    }
  },

  /**
   * Explicit, on-demand screen capture.
   *
   * Distinct from `assist`, which also looks at the screen but decides for
   * itself what you need. This one just says: here is my screen, look at it.
   *
   * Note the privacy interaction: when capture protection is on, Nimbus's own
   * windows are excluded from the screenshot it takes, so the overlay never
   * appears in the image it sends. The privacy setting is what makes this
   * usable as a teleprompter you can also ask about.
   */
  screenshot: {
    needsScreen: true,
    userBubble: 'Look at my screen',
    small: false,
    system:
      'You are Nimbus. The screenshot is the user\'s current screen. Describe what matters, ' +
      'answer any question visible in it, or summarise the content, whichever is most useful. ' +
      'Be specific and brief. No preamble, and do not narrate that you are looking at an image.',
    build(ctx) {
      return ctx.userText
        ? 'About what is on my screen: ' + ctx.userText
        : 'What is on my screen right now?';
    }
  },

  ask: {
    /**
     * Typed questions do NOT capture the screen.
     *
     * They used to. Every question, however self-contained, paid for a full
     * screenshot: slower first token, a large image uploaded to whichever
     * provider is configured, and -- on any text-only model -- a rejected
     * request plus a warning banner about a screenshot the user never asked to
     * send. Sending the screen to a third party should be a deliberate act, and
     * it already has three deliberate entry points: the "My screen" action,
     * Assist, and Solve.
     */
    needsScreen: false,
    userBubble: null, // the typed text becomes the bubble
    small: false,
    system:
      'You are Nimbus, a real-time copilot with access to the user\'s live conversation. ' +
      'Answer directly and concisely, grounded in what was said. No preamble.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 12);
      return (t ? 'Recent conversation:\n' + t + '\n\n' : '') + 'Question: ' + ctx.userText;
    }
  },

  solve: {
    needsScreen: true,
    userBubble: 'Solve what is on screen',
    small: false,
    system:
      'You are an expert competitive programmer. The screenshot contains a coding problem. ' +
      'Respond with: (1) a one-line restatement, (2) a short approach, (3) a clean, correct solution in a fenced code block ' +
      'using the language shown on screen (else Python), (4) time and space complexity.',
    build() { return 'Solve the coding problem shown in the screenshot.'; }
  }
};

// The old build called this mode "leetcode". Keep the alias so an existing
// keybinding or saved setting does not silently resolve to nothing.
MODES.leetcode = MODES.solve;

/**
 * Audio digest prompts.
 *
 * Deliberately not MODES entries. A MODE is something a human invokes about the
 * current moment; these run on a timer against a block of heard speech, with no
 * screen, no conversation history and no user question. src/digest.js decides
 * when, this decides what to ask for.
 *
 * ---- the output contract -------------------------------------------------
 *
 * Every digest answers in the same two-part shape:
 *
 *     GIST: <one line>
 *     <body>
 *
 * The GIST line is the load-bearing part. It is fed back in as the header of the
 * NEXT block, which is what turns forty disconnected summaries of a two-hour
 * video into one thread. Losing it would not break a single digest, it would
 * break continuity across all of them -- so the parser below falls back to the
 * first sentence rather than returning nothing.
 */
const DIGEST_RULES =
  'The transcript is produced automatically and contains recognition errors, run-together words and '
  + 'missing punctuation. Read through them. Never invent a name, number or claim that is not there; '
  + 'if a passage is unintelligible, say so in three words rather than guessing.\n'
  + 'Answer in exactly this shape and nothing else:\n'
  + 'GIST: <one sentence, at most 20 words, present tense, what is happening right now>\n'
  + 'then the body described below. No preamble, no headings, no closing remark, '
  + 'and never refer to "the transcript", "the audio" or yourself.';

const DIGEST = {
  summarize: {
    label: 'summary',
    system: () =>
      'You are Nimbus, keeping a running account of audio playing on the user\'s machine -- a meeting, '
      + 'a call, a lecture or a video. You are not addressed and you never reply to anyone in it.\n'
      + DIGEST_RULES + '\n'
      + 'Body: 2 to 4 bullets, each at most 20 words, each carrying something concrete -- who said what, '
      + 'a decision, a number, a name, a question left open. Omit filler and pleasantries. '
      + 'If this stretch carried nothing of substance, write the GIST line alone with no bullets.',
    /** Roughly one short paragraph; a digest that runs long is a digest nobody reads. */
    budget: () => 300
  },

  translate: {
    label: 'translation',
    system: (lang) =>
      'You are Nimbus, translating audio the user is listening to into ' + lang + '. '
      + 'Preserve speaker order and tone. A line already in ' + lang + ' passes through unchanged.\n'
      + DIGEST_RULES + '\n'
      + 'Write the GIST line in ' + lang + '. '
      + 'Body: the translation, one line per source line, and nothing else -- no transliteration, '
      + 'no source text, no commentary.',
    // Output tracks input length rather than a fixed ceiling: truncating a
    // translation halfway through loses content, where truncating a summary
    // only loses detail.
    budget: (inputTokens) => Math.min(1400, Math.max(400, inputTokens * 2))
  },

  both: {
    label: 'translation',
    system: (lang) =>
      'You are Nimbus, following audio the user is listening to and rendering it into ' + lang + '.\n'
      + DIGEST_RULES + '\n'
      + 'Write the GIST line in ' + lang + '. '
      + 'Body: first the translation, one line per source line; then a blank line; then 2 to 3 bullets '
      + 'of at most 20 words each covering what actually mattered. Nothing else.',
    budget: (inputTokens) => Math.min(1600, Math.max(600, inputTokens * 2 + 200))
  }
};

/**
 * Build the user turn for one digest block.
 *
 * The carried gist goes FIRST and is labelled as settled background, because a
 * model handed two blocks of speech with no marking will summarise both and the
 * digest stream starts repeating itself every few minutes.
 */
function buildDigest({ turns, gist, targetLang }) {
  const heard = formatTranscript(turns, 0, 'them') || formatTranscript(turns, 0);
  const head = gist
    ? 'Already covered, for continuity only -- do not repeat it:\n' + gist + '\n\n'
    : '';
  const lang = targetLang ? 'Target language: ' + targetLang + '\n\n' : '';
  return lang + head + 'New audio:\n' + (heard || '(nothing intelligible)');
}

/**
 * Split a digest reply into its carried gist and its displayable body.
 *
 * Tolerant by design. A model that ignores the contract still produced a useful
 * summary, and throwing it away to punish the formatting would be the wrong
 * trade -- so an absent GIST line is recovered from the first sentence instead.
 */
function splitDigest(raw) {
  const text = String(raw || '').trim();
  if (!text) return { gist: '', body: '' };

  const lines = text.split('\n');
  const first = lines[0].trim();
  const m = first.match(/^\**\s*GIST\s*:?\**\s*(.*)$/i);
  if (m) {
    return { gist: m[1].trim(), body: lines.slice(1).join('\n').trim() };
  }

  // No contract line. Recover one so the thread does not break at this block.
  const sentence = text.split(/(?<=[.!?])\s/)[0] || first;
  return { gist: sentence.trim().slice(0, 160), body: text };
}

// ------------------------------------------------------------------ compaction
/**
 * Compressing a conversation so it can carry on in a smaller window.
 *
 * The sections are mandatory and fixed. Compression quality cannot be
 * guaranteed -- a model will drop something a summary of any length would have
 * kept -- but the SHAPE can be, and a fixed shape is what makes the loss
 * survivable: FACTS exists so identifiers survive verbatim even when the prose
 * around them is flattened, and OPEN exists so the thing the user was in the
 * middle of does not quietly vanish because it had not been decided yet.
 *
 * Written for the smart tier. Compression is the one job where paying for the
 * better model is obviously right: everything downstream reads this and nothing
 * reads the originals again.
 */
const COMPACT_SECTIONS = ['GOAL', 'STATE', 'DECISIONS', 'OPEN', 'FACTS', 'RECENT'];

const COMPACT = {
  system:
    'You are compressing an ongoing conversation between a user and an assistant so that it can '
    + 'continue inside a smaller context window. You are not answering the user, and you are not '
    + 'continuing the conversation.\n\n'
    + 'Write exactly these sections, in this order, each starting on its own line with the section '
    + 'name followed by a colon. Nothing before the first section and nothing after the last.\n\n'
    + 'GOAL: what the user is ultimately trying to do. One sentence.\n'
    + 'STATE: where the work stands right now. At most three sentences.\n'
    + 'DECISIONS: settled choices, one per line starting with "- ", each with its reason if one was '
    + 'given. Write "- none" if there were none.\n'
    + 'OPEN: questions still unanswered and work still to do, one per line starting with "- ". '
    + 'Write "- none" if there are none.\n'
    + 'FACTS: identifiers that must survive word for word -- names, file paths, numbers, versions, '
    + 'URLs, error strings, exact wording the user gave you. One per line starting with "- ". '
    + 'Copy them exactly: never round a number, shorten a path or tidy a quote. '
    + 'Write "- none" if there are none.\n'
    + 'RECENT: the most recent exchanges in order, one line each, "user: ..." or "assistant: ...", '
    + 'at most 15 words per line.\n\n'
    + 'Rules. Never invent anything: if it was not said, it does not go in. Keep the user\'s own '
    + 'wording for anything they will refer back to. Add no headings of your own, no preamble and '
    + 'no closing remark.',

  /**
   * Output budget.
   *
   * Scaled to what is being folded but firmly capped: a compression that is
   * half the size of the conversation has not compressed anything, and the whole
   * point is to leave room for the turns that come next.
   */
  budget: (inputTokens) => Math.min(1200, Math.max(400, Math.round(inputTokens / 6)))
};

/**
 * The user turn for one compaction.
 *
 * A previous compression goes in first and is labelled as settled, for the same
 * reason the digest carries its gist: a model handed two undifferentiated blocks
 * rewrites both, and the older material slowly loses detail on every pass.
 */
function buildCompact({ previous, cold, warm }) {
  const render = (turns) => (turns || [])
    .map((t) => (t.role === 'assistant' ? 'assistant: ' : 'user: ') + String(t.text || '').trim())
    .filter((s) => s.length > 10)
    .join('\n\n');

  const parts = [];
  if (previous) {
    parts.push('Already compressed earlier in this conversation. Carry it forward and fold the new '
      + 'material into it; do not repeat it as a separate section.\n\n' + previous);
  }
  const older = render(cold);
  if (older) parts.push('Earlier conversation to compress:\n\n' + older);
  const recent = render(warm);
  if (recent) parts.push('Most recent exchanges. These belong in RECENT:\n\n' + recent);
  return parts.join('\n\n----\n\n');
}

/**
 * Validate a compression without being precious about it.
 *
 * A reply that carries most of the sections is usable even if the model dropped
 * one, and rejecting it would throw away a paid call and leave the conversation
 * exactly as over-long as it was. Only something with no recognisable structure
 * at all is refused, because injecting free prose under a "this is your context"
 * banner is how a compression turns into a hallucination.
 */
function parseCompact(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, text: '', missing: COMPACT_SECTIONS.slice() };

  const missing = [];
  for (const name of COMPACT_SECTIONS) {
    if (!new RegExp('^\\**\\s*' + name + '\\s*:?\\**', 'im').test(text)) missing.push(name);
  }
  // Two or more sections is enough shape to trust. Fewer means the model
  // answered the conversation instead of compressing it.
  return { ok: missing.length <= COMPACT_SECTIONS.length - 2, text, missing };
}

/**
 * The compression, as turns to put in front of the user's next message.
 *
 * Two turns, not one. The wrapper alone asks the model not to respond to the
 * injection, and most will comply -- but a canned acknowledgement makes it
 * structurally impossible, because from the model's point of view the material
 * has already been received and answered. It costs about five tokens and it
 * removes an entire failure mode where the first message after a compaction gets
 * a summary of the summary instead of an answer.
 */
function compactPrefill(text) {
  const doc = String(text || '').trim();
  if (!doc) return [];
  return [
    {
      role: 'user',
      text: 'Context from earlier in this conversation, compressed so it fits. Read it, understand '
        + 'it, and continue from it.\n'
        + 'This is background, not a request. Do not reply to it, do not summarise it and do not '
        + 'acknowledge it -- answer only the message that follows it.\n\n'
        + doc
    },
    { role: 'assistant', text: 'Understood. Continuing from that context.' }
  ];
}

module.exports = {
  MODES, formatTranscript,
  DIGEST, buildDigest, splitDigest,
  COMPACT, COMPACT_SECTIONS, buildCompact, parseCompact, compactPrefill
};
