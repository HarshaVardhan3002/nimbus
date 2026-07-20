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
      'You are cue, a discreet real-time copilot overlaid on the user\'s screen. ' +
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
      'You are cue, suggesting replies during a live conversation. ' +
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
      'You are cue. Given the conversation, suggest 2-4 sharp, relevant follow-up questions the user could ask next. ' +
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
      'You are cue. Summarise the conversation for someone who joined late: key points, decisions, action items. ' +
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
      'You are cue, translating audio the user is listening to. ' +
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
    needsScreen: true,
    userBubble: null, // the typed text becomes the bubble
    small: false,
    system:
      'You are cue, a real-time copilot with access to the user\'s screen and live conversation. ' +
      'Answer directly and concisely, grounded in what is on screen and what was said. No preamble.',
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

module.exports = { MODES, formatTranscript };
