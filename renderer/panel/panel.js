/* Nimbus — panel window: chat, settings, and exact size reporting. */
(function () {
  'use strict';

  const { icon } = window.ICONS;
  const app = window.nimbus;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const panel = $('#panel');
  const messages = $('#messages');
  const notice = $('#notice');
  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');
  const sendBtn = $('#send');

  let settings = null;
  let providerList = [];
  let editingProvider = null;
  // Which stored conversation is on screen, so a rename in the history list can
  // update the header without a round trip to ask which one that is.
  let currentId = null;
  // Last model list per provider id. Routes point at different providers, so one
  // shared "last discovery" described whichever endpoint was asked most recently
  // and was wrong for every other row on screen.
  const discoveryFor = {};
  // 'hold' | 'latch' | 'unbound', from native:status. Decides whether the
  // push-to-talk row can honestly call itself hold-to-talk.
  let pttMode = 'hold';
  let busy = false;
  let aiEl = null;
  let caretEl = null;
  // Reasoning models stream their scratchpad on a separate channel. It used to
  // be dropped on the floor, so a model that thought for 20s looked frozen.
  let thinkEl = null;
  let thinkBody = null;
  let thinkStart = 0;

  // ---- icons ---------------------------------------------------------------
  const ACT_ICONS = {
    assist: 'sparkles', say: 'wand-sparkles', followup: 'message-circle',
    recap: 'refresh-cw', translate: 'languages', screenshot: 'monitor'
  };
  $$('.act').forEach((b) => { b.querySelector('.ic').innerHTML = icon(ACT_ICONS[b.dataset.mode] || 'sparkles', { size: 15 }); });
  $('#smart .ic').innerHTML = icon('zap', { size: 13 });
  $('#send').innerHTML = icon('corner-down-left', { size: 15 });
  $('#s-close').innerHTML = icon('x', { size: 16 });
  $('#h-close').innerHTML = icon('x', { size: 16 });
  $('#advice-x').innerHTML = icon('x', { size: 13 });
  $('#history-btn').innerHTML = icon('history', { size: 15 });
  $('#new-btn').innerHTML = icon('plus', { size: 16 });
  $('#add-provider .ic').innerHTML = icon('plus', { size: 13 });
  $('#refresh-models .ic').innerHTML = icon('refresh-cw', { size: 12 });
  $('#test-provider .ic').innerHTML = icon('zap', { size: 12 });
  $('#refresh-stt .ic').innerHTML = icon('mic', { size: 12 });
  $('#ptt-reset .ic').innerHTML = icon('refresh-cw', { size: 12 });
  $('#engine-install .ic').innerHTML = icon('zap', { size: 12 });
  $('#engine-reprobe .ic').innerHTML = icon('monitor', { size: 12 });

  // ---- viewport-independent layout caps ------------------------------------
  function applyAvailableHeight(h) {
    if (!h || h < 200) return;
    document.documentElement.style.setProperty('--avail-h', h + 'px');
  }

  // ---- size reporting ------------------------------------------------------
  /**
   * The single source of truth for the window's height. Main springs the OS
   * window to this number, so the window is never taller than the pixels the
   * user can actually see and never blocks a click below the last row.
   */
  let lastH = 0;
  function reportSize() {
    const h = Math.ceil(panel.getBoundingClientRect().height);
    if (h === lastH || h < 1) return;
    lastH = h;
    app.panelSize(panel.offsetWidth, h);
  }
  new ResizeObserver(reportSize).observe(panel);

  /**
   * Flag a capped box while there is content below its bottom edge.
   *
   * The settings sheet and the history list both stop at a hard border in the
   * middle of a row, which reads as a clipping bug rather than as more to see.
   * The CSS fades that edge, but only while this class is on -- a list that
   * already fits keeps its last row at full strength.
   */
  function watchOverflow(sel) {
    const el = document.querySelector(sel);
    if (!el) return;
    const mark = () => el.classList.toggle('has-more',
      el.scrollHeight - el.scrollTop - el.clientHeight > 2);
    el.addEventListener('scroll', mark, { passive: true });
    // The box is capped, so filling it changes the content and not the box:
    // arriving rows need a mutation to be noticed, a tab switch needs a resize.
    new ResizeObserver(mark).observe(el);
    new MutationObserver(mark).observe(el, { childList: true, subtree: true });
    mark();
  }
  ['.s-scroll', '.h-list'].forEach(watchOverflow);

  // Specular highlight tracks the cursor.
  panel.addEventListener('mousemove', (e) => {
    const r = panel.getBoundingClientRect();
    panel.style.setProperty('--sheen-x', ((e.clientX - r.left) / r.width * 100) + '%');
    panel.style.setProperty('--sheen-y', ((e.clientY - r.top) / r.height * 100) + '%');
  });

  // ---- markdown ------------------------------------------------------------
  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }
  /**
   * Maths, lifted out before markdown gets near it.
   *
   * TeX and markdown fight over the same punctuation: `a_1` is a subscript to
   * one and an italic run to the other, `\*` is an operator to one and an
   * escape to the other, and esc() would turn every `<` in an inequality into
   * an entity. So each formula is pulled out first, replaced by an opaque
   * token, and put back rendered once the markdown pass has finished.
   *
   * The token is deliberately plain alphanumerics: it has to survive esc() and
   * every inline() regex untouched.
   */
  const MATH_TOKEN = (i) => 'kaTeXmathTOKEN' + i + 'END';
  const CODE_TOKEN = (i) => 'kaTeXcodeTOKEN' + i + 'END';

  function liftMath(text, out) {
    const grab = (tex, display) => {
      out.push({ tex, display });
      return MATH_TOKEN(out.length - 1);
    };

    /**
     * Code is protected first and unconditionally.
     *
     * `$HOME` in a shell snippet and `$i` in a loop are not formulae, and a
     * message about awk or jq is exactly the kind that would otherwise come out
     * as unreadable italic maths. An unterminated fence is included on purpose:
     * mid-stream the closing ``` has not arrived yet, and treating the tail as
     * prose would render half a code block as equations for a second.
     */
    const code = [];
    const hide = (m) => { code.push(m); return CODE_TOKEN(code.length - 1); };

    const lifted = String(text)
      .replace(/```[\s\S]*?(?:```|$)/g, hide)
      .replace(/`[^`\n]*`/g, hide)
      // Longest delimiters first, or $$..$$ is eaten as two empty $..$ pairs.
      .replace(/\$\$([\s\S]+?)\$\$/g, (_m, t) => grab(t, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, t) => grab(t, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, t) => grab(t, false))
      /**
       * Single `$`. Guarded so prices are not swallowed: no space just inside
       * either delimiter, no newline within, and a body that is not merely a
       * number -- which is what makes "$5 and $10 for the licence" safe.
       */
      .replace(/\$(?!\s)([^\n$]*[^\s$])\$/g, (m, t) =>
        (/^[\d.,]+$/.test(t) ? m : grab(t, false)));

    return lifted.replace(/kaTeXcodeTOKEN(\d+)END/g, (m, i) => {
      const c = code[Number(i)];
      return c === undefined ? m : c;
    });
  }

  function dropMath(html, list) {
    if (!list.length) return html;
    return html.replace(/kaTeXmathTOKEN(\d+)END/g, (m, i) => {
      const item = list[Number(i)];
      if (!item) return m;
      // throwOnError:false renders the offending source in red rather than
      // taking the whole message down with it -- a half-streamed formula must
      // never blank an answer.
      try {
        return window.katex.renderToString(item.tex, {
          displayMode: item.display,
          throwOnError: false,
          output: 'htmlAndMathml'
        });
      } catch {
        return '<code>' + esc(item.tex) + '</code>';
      }
    });
  }

  function renderMarkdown(text) {
    const math = [];
    text = liftMath(text, math);
    const lines = text.split('\n');
    let html = '', inCode = false, listType = null, buf = [];
    const closeList = () => { if (listType) { html += listType === 'ul' ? '</ul>' : '</ol>'; listType = null; } };
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (!inCode) { flushP(); closeList(); html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }

      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { flushP(); closeList(); html += '<p><strong>' + inline(h[2]) + '</strong></p>'; continue; }

      const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (ol) {
        flushP();
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += '<li>' + inline(ol[2]) + '</li>';
        continue;
      }
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (ul) {
        flushP();
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += '<li>' + inline(ul[1]) + '</li>';
        continue;
      }
      if (!line.trim()) { flushP(); closeList(); continue; }
      buf.push(line.trim());
    }
    flushP(); closeList();
    if (inCode) html += '</code></pre>';
    return dropMath(html, math);
  }

  // ---- messages ------------------------------------------------------------
  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  /**
   * Hover copy affordance.
   *
   * Copies the RAW source, not the rendered DOM. For an assistant turn that
   * means the original markdown -- innerText would flatten fenced code blocks
   * and lose the fences, which is exactly the content most worth copying.
   */
  function attachCopy(el, getText) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.title = 'Copy';
    btn.setAttribute('aria-label', 'Copy message');
    btn.innerHTML = icon('copy', { size: 13 });
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(getText());
        btn.classList.add('done');
        btn.innerHTML = icon('check', { size: 13 });
        setTimeout(() => {
          btn.classList.remove('done');
          btn.innerHTML = icon('copy', { size: 13 });
        }, 1300);
      } catch {
        btn.title = 'Clipboard blocked';
      }
    });
    el.appendChild(btn);
  }

  function addUser(text) {
    const wrap = document.createElement('div');
    wrap.className = 'turn turn-user';
    const b = document.createElement('div');
    b.className = 'bubble-user';
    b.textContent = text;
    wrap.appendChild(b);
    attachCopy(wrap, () => text);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  /**
   * An audio digest: what Nimbus heard while nobody asked it anything.
   *
   * Rendered as marginalia rather than as a turn -- no bubble, dimmer, clamped
   * to a couple of lines until clicked. It is not a participant in the
   * conversation and must not read like one, or a long meeting turns the chat
   * into a wall of unread machine output with the user's own thread lost in it.
   */
  function addDigest(d) {
    const text = (d && d.text) || '';
    if (!text.trim()) return;

    const wrap = document.createElement('details');
    wrap.className = 'digest';

    const sum = document.createElement('summary');
    const when = new Date(d.to || Date.now())
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const secs = d.from && d.to ? Math.round((d.to - d.from) / 1000) : 0;

    const tag = document.createElement('span');
    tag.className = 'digest-tag';
    // The glyph says which of the two jobs produced this, since a translation
    // and a summary of the same stretch look nothing alike.
    tag.innerHTML = icon(d.kind === 'translation' ? 'languages' : 'volume-2', { size: 12 });

    const line = document.createElement('span');
    line.className = 'digest-gist';
    // The gist, not the body: one glanceable line is the whole point of the
    // collapsed state, and the body is one click away.
    line.textContent = d.gist || text.split('\n')[0];

    const meta = document.createElement('span');
    meta.className = 'digest-meta';
    meta.textContent = secs ? when + ' · ' + secs + 's' : when;

    sum.appendChild(tag);
    sum.appendChild(line);
    sum.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'digest-body';
    body.innerHTML = renderMarkdown(text);

    wrap.appendChild(sum);
    wrap.appendChild(body);
    attachCopy(wrap, () => text);

    // Only follow the tail if the user is already reading it. Yanking the view
    // down mid-sentence because a meeting produced a summary is hostile.
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    messages.appendChild(wrap);
    if (atBottom) messages.scrollTop = messages.scrollHeight;
    reportSize();
  }

  /**
   * System speech, in the conversation.
   *
   * A turn, unlike a digest -- it has a bubble and it sits in the thread --
   * because the model really does read it and pretending otherwise would make
   * the chat a dishonest picture of the context. It is visibly not the user's
   * turn though: its own colour, an ear on it, and the speaker attributed, so
   * nobody reads their own words into someone else's mouth.
   */
  function addHeard(h) {
    const text = (h && h.text) || '';
    if (!text.trim()) return;

    const wrap = document.createElement('div');
    wrap.className = 'turn turn-heard';

    const tag = document.createElement('div');
    tag.className = 'heard-tag';
    tag.innerHTML = icon('volume-2', { size: 12 });
    const label = document.createElement('span');
    label.textContent = 'System audio';
    tag.appendChild(label);

    const when = new Date(h.to || h.ts || Date.now())
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const meta = document.createElement('span');
    meta.className = 'heard-meta';
    meta.textContent = when;
    tag.appendChild(meta);

    const el = document.createElement('div');
    el.className = 'heard';
    el.textContent = text;      // transcript, not markdown: it is speech, verbatim

    wrap.appendChild(tag);
    wrap.appendChild(el);
    attachCopy(wrap, () => text);

    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    messages.appendChild(wrap);
    if (atBottom) messages.scrollTop = messages.scrollHeight;
    reportSize();
  }

  /**
   * The user's own speech, staged in the composer rather than sent.
   *
   * Appended to whatever is already typed, so dictating in pieces works and so
   * half-written text is never destroyed by something the mic picked up. The
   * caret lands at the end and the box takes focus: the next thing the user
   * does is either press Enter or fix a word, and both need it focused.
   */
  let stageFlash = null;
  function stageTranscript(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const cur = input.value;
    const sep = !cur ? '' : (/\s$/.test(cur) ? '' : ' ');
    input.value = cur + sep + t;
    syncPlaceholder();
    // Speech lands in the composer ready to send, so this is one of the few
    // places that takes the keyboard without the user pointing at anything.
    claimInput(input);
    input.setSelectionRange(input.value.length, input.value.length);
    composer.classList.add('staged');
    clearTimeout(stageFlash);
    stageFlash = setTimeout(() => composer.classList.remove('staged'), 900);
  }

  /**
   * A compaction marker: the point where earlier turns stopped being sent
   * verbatim.
   *
   * Shown, not hidden, because the alternative is what this replaced -- silent
   * truncation, where the assistant forgot and nothing on screen said why. The
   * originals are all still above it and still searchable; this only marks what
   * the model now reads instead of them, and opening it shows exactly that.
   */
  function addFold(m) {
    const text = String((m && m.content) || '');
    if (!text.trim()) return;

    const wrap = document.createElement('details');
    wrap.className = 'digest fold';

    const sum = document.createElement('summary');

    const tag = document.createElement('span');
    tag.className = 'digest-tag';
    tag.innerHTML = icon('history', { size: 12 });

    const line = document.createElement('span');
    line.className = 'digest-gist';
    const n = Number(m.folded) || 0;
    line.textContent = n
      ? n + (n === 1 ? ' earlier message' : ' earlier messages') + ' compressed to fit the context'
      : 'Earlier messages compressed to fit the context';

    const meta = document.createElement('span');
    meta.className = 'digest-meta';
    meta.textContent = new Date(m.ts || Date.now())
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    sum.appendChild(tag);
    sum.appendChild(line);
    sum.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'digest-body fold-body';
    // Deliberately not markdown: this is a fixed-section document, and letting
    // its headings render as prose would hide the structure the model relies on.
    body.textContent = text;

    wrap.appendChild(sum);
    wrap.appendChild(body);
    attachCopy(wrap, () => text);

    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    messages.appendChild(wrap);
    if (atBottom) messages.scrollTop = messages.scrollHeight;
    reportSize();
  }

  function startAi(small) {
    const wrap = document.createElement('div');
    wrap.className = 'turn turn-ai';
    aiEl = document.createElement('div');
    aiEl.className = 'ai' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'caret';
    aiEl.appendChild(caretEl);
    wrap.appendChild(aiEl);
    messages.appendChild(wrap);
  }

  /**
   * The thinking block, streamed live and collapsed the moment a real answer
   * starts. Kept visible on failure: when a reasoning model burns its whole
   * budget without answering, this is the only thing that explains the error.
   */
  function appendReasoning(t) {
    if (!aiEl) startAi(false);
    if (!thinkEl) {
      thinkStart = Date.now();
      thinkEl = document.createElement('details');
      thinkEl.className = 'think';
      thinkEl.open = true;
      const sum = document.createElement('summary');
      sum.textContent = 'Thinking…';
      thinkBody = document.createElement('div');
      thinkBody.className = 'think-body';
      thinkEl.appendChild(sum);
      thinkEl.appendChild(thinkBody);
      aiEl.parentElement.insertBefore(thinkEl, aiEl);
    }
    thinkBody.textContent += t;
    thinkBody.scrollTop = thinkBody.scrollHeight;
    messages.scrollTop = messages.scrollHeight;
    reportSize();
  }

  function sealThinking(label) {
    if (!thinkEl) return;
    const secs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
    thinkEl.querySelector('summary').textContent = label || ('Thought for ' + secs + 's');
    thinkEl.open = false;
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    // First real content ends the thinking phase.
    if (thinkEl && thinkEl.open) { sealThinking(); reportSize(); }
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'tok';
    span.textContent = t;
    aiEl.insertBefore(span, caretEl);
    messages.scrollTop = messages.scrollHeight;
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    sealThinking();
    aiEl.innerHTML = renderMarkdown(raw);
    if (raw.trim() && aiEl.parentElement) attachCopy(aiEl.parentElement, () => raw);
    aiEl = null; caretEl = null; thinkEl = null; thinkBody = null;
    reportSize();
  }

  let noticeTimer = null;
  function showNotice(message, level) {
    notice.textContent = message;
    notice.className = 'notice show ' + (level || 'info');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, level === 'error' ? 14000 : 8000);
    reportSize();
  }
  function hideNotice() { notice.className = 'notice'; reportSize(); }

  // ---- the standing "will not compress itself" card ------------------------
  /**
   * Shown once per conversation, by main. Two causes, two different things the
   * user can do about it, so the body says which one this is instead of offering
   * a generic "context is full".
   */
  function showAdvice(a) {
    if (!a) return;
    const card = $('#advice');
    const single = a.kind === 'single';
    adviceKind = a.kind;
    $('.advice-ic').innerHTML = icon('sparkles', { size: 13 });
    $('#advice-title').textContent = single
      ? 'This conversation will not compress itself'
      : 'This conversation may be near its limit';
    $('#advice-body').textContent = single
      ? 'It is about ' + Math.round((a.pct || 0) * 100) + '% full. Only one model is set up, so '
        + 'compressing would mean "' + a.model + '" summarising a conversation it is already '
        + 'stretching to hold. Nimbus will not do that on its own — but nothing is deleted if you '
        + 'ask it to, and setting a stronger model for the smart tier makes it automatic.'
      : 'It is about ' + Math.round((a.pct || 0) * 100) + '% full against an assumed '
        + Math.round((a.window || 0) / 1000) + 'k window — "' + a.model + '" never said how much it '
        + 'takes. Nimbus will not compress on a guess. Set the real window in Settings, or compress '
        + 'now if replies have started losing the thread.';
    card.classList.remove('hidden');
    reportSize();
  }
  function hideAdvice() { $('#advice').classList.add('hidden'); reportSize(); }

  /** Which advice is on screen, so its button knows where it is sending you. */
  let adviceKind = null;

  /**
   * Both things the card suggests -- a stronger smart model, a real context
   * window -- sit behind the advanced disclosure, and the card is the only
   * place that names them. Opening settings on the default tab with the
   * disclosure shut would land the user on a screen that does not contain the
   * control they were just told to change, so this turns it on and scrolls
   * the row into view.
   */
  async function openAdviceSettings() {
    const kind = adviceKind;
    hideAdvice();
    if (!(settings.ui || {}).advanced) {
      settings.ui = Object.assign({}, settings.ui, { advanced: true });
      await app.settingsSet({ ui: { advanced: true } });
    }
    showSettings(true);
    showTab('models');
    applyAdvanced(true);
    const target = kind === 'single'
      ? $('#route-smart-model')
      : $('#f-' + (settings.smart ? 'smart' : 'fast') + '-window');
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.focus();
    }
  }

  function setBusy(v) {
    busy = v;
    sendBtn.classList.toggle('busy', v);
    // While a request is in flight the send button becomes a stop button.
    // `abort` was wired through preload and main and never called from anywhere,
    // so a slow or runaway answer could not be cancelled at all.
    sendBtn.innerHTML = icon(v ? 'stop-square' : 'corner-down-left', { size: 15 });
    sendBtn.title = v ? 'Stop (Esc)' : 'Send (Enter)';
    sendBtn.setAttribute('aria-label', v ? 'Stop generating' : 'Send');
    $$('.act').forEach((b) => { b.disabled = v; });
  }

  // ---- send ----------------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    hideNotice();
    app.ask({ mode, text: text || '' });
  }

  $$('.act').forEach((b) => b.addEventListener('click', () => runMode(b.dataset.mode, '')));

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    reportSize();
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  /**
   * Asking main for the keyboard, only when something is actually typed into.
   *
   * The window does not activate on click, so the caret stays wherever the user
   * left it in whatever they were working in -- an editor keeps its selection,
   * its completion popup and its undo position while they click around in here.
   * The cost is that a text field in an unactivated window receives no
   * keystrokes, so focus has to be asked for explicitly the moment one takes
   * DOM focus. Escape gives it straight back.
   *
   * Delegated on focusin rather than bound per field: settings, history search
   * and the rename box are all built after this runs, and one of them being
   * missed reads as a dead keyboard for no visible reason.
   */
  const EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, [contenteditable="true"]';

  /**
   * pointerdown, not focusin: an unactivated window does not hand DOM focus to
   * anything, so waiting for a focus event here waits forever. The press is the
   * only signal that arrives, and the field is focused afterwards -- once main
   * has actually taken the keyboard and said so.
   */
  let wantsFocus = null;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const el = t.closest(EDITABLE) || (t.closest('#input-area') ? input : null);
    if (!el) return;
    wantsFocus = el;
    app.requestFocus();
  }, true);

  /**
   * Focus a field the code decided to focus, rather than the user's pointer.
   *
   * A bare el.focus() is silently ineffective while the window is unactivated,
   * so anything that opens a field ready to be typed in has to ask for the
   * keyboard as well.
   */
  function claimInput(el) {
    const target = el || input;
    wantsFocus = target;
    app.requestFocus();
    target.focus();
  }

  /**
   * No separate "Nimbus has the keyboard" indicator: DOM focus now exists only
   * while main has actually taken it, so #composer.focused already says it.
   */
  app.on('focus:mode', ({ typing }) => {
    if (typing) {
      const el = wantsFocus;
      wantsFocus = null;
      if (el && el.isConnected) el.focus();
      return;
    }
    // Focus went back to another window. Anything still holding DOM focus here
    // would keep drawing a caret that no longer receives anything.
    wantsFocus = null;
    const el = document.activeElement;
    if (el && el !== document.body && el.blur) el.blur();
  });

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = '';
    syncPlaceholder();
    runMode('ask', text);
  }
  // A compaction can be running with no request behind it, started from the
  // popover. It is still the thing the user is waiting on, so Stop still stops it.
  function stop() { if (busy || compacting) app.abort(); }
  sendBtn.addEventListener('click', () => (busy ? stop() : send()));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // Mid-IME composition, Enter commits the candidate. Stealing it there would
    // make the app unusable for anyone typing a non-Latin script.
    if (e.isComposing || e.keyCode === 229) return;
    // Shift+Enter is the ONLY way to get a newline. Everything else sends.
    if (e.shiftKey) return;
    // Before any work: a throw further down must never fall through to the
    // textarea's default and insert a line break.
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey) runMode('assist', ''); else send();
  }, true);

  $('#smart').addEventListener('click', async () => {
    settings.smart = !settings.smart;
    $('#smart').classList.toggle('on', settings.smart);
    await app.settingsSet({ smart: settings.smart });
    refreshModelChip();
  });

  $('#model-chip').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleContextPop();
  });
  async function compactNow() {
    if (compacting) { app.abort(); return; }
    // Optimistic, because main broadcasts compact:state only once it has decided
    // there is something to do -- and a button that stays idle after a click
    // reads as a dead button.
    compacting = true;
    paintCompactBtn();
    try {
      const res = await app.compactNow();
      // A cancel is the user getting what they asked for, not a failure.
      if (res && !res.ok && !res.cancelled) showNotice(res.reason || 'Could not compress.', 'warn');
      if (res && res.ok) hideAdvice();
    } catch (err) {
      showNotice((err && err.message) || 'Could not compress.', 'warn');
    } finally {
      compacting = false;
      paintCompactBtn();
    }
  }

  $('#ctx-compact').addEventListener('click', (e) => { e.stopPropagation(); compactNow(); });
  $('#advice-compact').addEventListener('click', () => compactNow());
  $('#advice-x').addEventListener('click', () => hideAdvice());
  $('#advice-settings').addEventListener('click', () => openAdviceSettings());
  // Click-away, like every other transient surface in the panel. Registered on
  // the document rather than a backdrop so it never steals a click from the
  // composer underneath it.
  document.addEventListener('click', (e) => {
    const pop = $('#ctx-pop');
    if (pop.classList.contains('hidden')) return;
    if (pop.contains(e.target) || $('#model-chip').contains(e.target)) return;
    toggleContextPop(false);
  });

  // ---- settings view -------------------------------------------------------
  /**
   * Exactly one view is visible. Chat, history and settings are peers rather
   * than a modal stack, so there is never a question about what Esc closes.
   */
  function showView(name) {
    $('#view-chat').classList.toggle('hidden', name !== 'chat');
    $('#view-history').classList.toggle('hidden', name !== 'history');
    $('#view-settings').classList.toggle('hidden', name !== 'settings');
    if (name === 'settings') renderSettings();
    if (name === 'history') renderHistory();
    reportSize();
  }
  function showSettings(show) { showView(show ? 'settings' : 'chat'); }

  // ---- settings sections ---------------------------------------------------
  /**
   * One section visible at a time. The groups are display:none by default in
   * CSS, so this MUST run before the settings view is first shown or the panel
   * renders as an empty box under the tab bar.
   */
  function showTab(tab) {
    $$('.s-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.s-group[data-tab]').forEach((g) => g.classList.toggle('on', g.dataset.tab === tab));
    reportSize();
  }
  $$('.s-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---- history -------------------------------------------------------------
  function fmtWhen(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const days = Math.floor((now - d) / 86400000);
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  /**
   * Rename in place.
   *
   * Titles are derived from the first thing you said, which is a good guess and
   * sometimes a bad name. Editing happens on the row rather than in a dialog:
   * a modal here would take focus from the panel, and an Electron dialog blocks
   * the whole window.
   */
  function beginRename(row, titleEl, s) {
    if (row.querySelector('.h-rename')) return;
    const box = document.createElement('input');
    box.type = 'text';
    box.className = 'h-rename';
    box.value = s.title;
    box.spellcheck = false;
    titleEl.replaceWith(box);
    claimInput(box);
    box.select();

    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      settled = true;
      const next = box.value.trim();
      if (commit && next && next !== s.title) {
        await app.historyRename(s.id, next);
        if (s.id === currentId) $('#convo-title').textContent = next;
      }
      renderHistory($('#h-search').value.trim());
    };

    // The row is a button. Without this every keystroke and click inside the
    // field would also count as a click on the row and open the conversation.
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    box.addEventListener('blur', () => finish(true));
  }

  /**
   * A stored message, read as one line of plain text.
   *
   * The preview is the raw message body, so a bolded answer arrived in the list
   * as `**Fix:**` and a fenced block arrived as a wall of backticks. This is not
   * a markdown parser and does not need to be -- it removes the marks that
   * survive into a one-line summary and leaves the words.
   */
  function unmark(s) {
    return String(s || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function renderHistory(query) {
    const items = query ? await app.historySearch(query) : await app.historyList();
    const list = $('#h-list');
    list.innerHTML = '';

    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'p-empty';
      e.textContent = query ? 'Nothing matches that.' : 'No conversations yet.';
      list.appendChild(e);
    }

    for (const s of items) {
      const b = document.createElement('button');
      b.className = 'h-item';
      const t = document.createElement('span'); t.className = 't'; t.textContent = s.title;
      const m = document.createElement('span'); m.className = 'm';
      // `snippet` exists only on search hits; the plain list carries `preview`.
      // Reading just the former left every unsearched row with no context.
      const gist = unmark(s.snippet || s.preview);
      m.textContent = fmtWhen(s.updatedAt) + '  ·  ' + s.count + (s.count === 1 ? ' message' : ' messages')
        + (gist ? '  ·  ' + gist : '');
      b.appendChild(t); b.appendChild(m);

      const tools = document.createElement('span');
      tools.className = 'h-tools';

      const pen = document.createElement('span');
      pen.className = 'icon-btn';
      pen.title = 'Rename';
      pen.innerHTML = icon('pencil', { size: 12 });
      pen.addEventListener('click', (ev) => { ev.stopPropagation(); beginRename(b, t, s); });
      tools.appendChild(pen);

      const kill = document.createElement('span');
      kill.className = 'kill icon-btn';
      kill.title = 'Delete';
      kill.innerHTML = icon('trash', { size: 12 });
      kill.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await app.historyDelete(s.id);
        renderHistory($('#h-search').value.trim());
      });
      tools.appendChild(kill);
      b.appendChild(tools);

      b.addEventListener('click', async () => {
        // The load broadcasts `history:opened`, which this window also receives
        // and renders from. Painting the session here as well would draw the
        // whole transcript twice for every open.
        await app.historyLoad(s.id);
        showView('chat');
      });
      list.appendChild(b);
    }
    // Searching reports what matched; the plain list reports the whole store,
    // which is not the same number once the list is paged.
    const total = query ? items.length : await app.historyCount();
    $('#h-count').textContent = query
      ? items.length + (items.length === 1 ? ' match' : ' matches')
      : total + (total === 1 ? ' conversation' : ' conversations');
    reportSize();
  }

  /** Replay a stored session into the chat view. */
  function renderSession(s) {
    clearMessages();
    // The advice is about the conversation that was on screen, not this one.
    hideAdvice();
    currentId = (s && s.id) || null;
    $('#convo-title').textContent = (s && s.title) || 'New conversation';
    for (const m of ((s && s.messages) || [])) {
      if (m.role === 'user') addUser(m.content);
      else if (m.role === 'heard') {
        addHeard({ text: m.content, from: m.from, to: m.to || m.ts, ts: m.ts });
      } else if (m.role === 'note') {
        addDigest({ text: m.content, gist: m.gist, kind: m.kind, from: m.from, to: m.to || m.ts });
      } else if (m.role === 'summary') {
        addFold(m);
      } else if (m.role === 'assistant') {
        const wrap = document.createElement('div');
        wrap.className = 'turn turn-ai';
        const el = document.createElement('div');
        el.className = 'ai';
        el.innerHTML = renderMarkdown(m.content || '');
        wrap.appendChild(el);
        attachCopy(wrap, () => m.content);
        messages.appendChild(wrap);
      }
    }
    messages.scrollTop = messages.scrollHeight;
    reportSize();
  }

  $('#history-btn').addEventListener('click', () => showView('history'));
  $('#convo-title').addEventListener('click', () => showView('history'));
  $('#h-close').addEventListener('click', () => showView('chat'));
  $('#new-btn').addEventListener('click', async () => {
    await app.historyNew();
    clearMessages();
    hideAdvice();
    currentId = null;
    $('#convo-title').textContent = 'New conversation';
    showView('chat');
    claimInput(input);
  });
  // Debounced: a query is an IPC round trip plus an index lookup, and typing
  // "screenshot" would otherwise fire ten of them and rebuild the list ten times.
  let searchTimer = 0;
  $('#h-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderHistory($('#h-search').value.trim()), 120);
  });
  $('#h-clear').addEventListener('click', async () => {
    await app.historyClear();
    clearMessages();
    currentId = null;
    $('#convo-title').textContent = 'New conversation';
    renderHistory();
  });
  $('#s-close').addEventListener('click', async () => { await persistProvider(); showSettings(false); });

  function renderProviders() {
    const grid = $('#provider-grid');
    const q = ($('#provider-search').value || '').trim().toLowerCase();
    grid.innerHTML = '';

    // A filtered list, not a fixed grid. A grid of buttons stops being usable
    // around a dozen entries and custom endpoints are unbounded by design.
    const shown = providerList.filter((p) => !q
      || p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    if (!shown.length) {
      const e = document.createElement('div');
      e.className = 'p-empty';
      e.textContent = 'No provider matches that.';
      grid.appendChild(e);
    }

    for (const p of shown) {
      const b = document.createElement('button');
      b.className = 'p-row' + (p.id === editingProvider ? ' on' : '');
      b.innerHTML = '<span class="nm">' + esc(p.label) + '</span>' +
        (p.local ? '<span class="tag">local</span>' : '');
      // Selecting a row opens it for editing. It deliberately does NOT change
      // which provider answers: that is what the routes above are for, and
      // silently re-pointing every tier because someone clicked a card to check
      // its API key was the single most confusing behaviour in this screen.
      b.addEventListener('click', async () => {
        await persistProvider();
        editingProvider = p.id;
        renderSettings();
      });
      if (p.custom) {
        const kill = document.createElement('span');
        kill.className = 'kill icon-btn';
        kill.innerHTML = icon('x', { size: 11 });
        kill.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          settings.customProviders = (settings.customProviders || []).filter((c) => c.id !== p.id);
          if (settings.provider === p.id) settings.provider = 'ollama';
          await app.settingsSet({ customProviders: settings.customProviders, provider: settings.provider });
          await reloadProviders();
          renderSettings();
        });
        b.appendChild(kill);
      }
      grid.appendChild(b);
    }
  }

  /**
   * Routing UI: one provider + model per tier.
   *
   * Deliberately separate from the "Provider connections" grid below it. That
   * grid is for CONFIGURING a provider (key, base URL); this is for CHOOSING
   * which provider answers at which reasoning level. Conflating the two is what
   * made the old design provider-bound.
   */
  function renderRoutes() {
    const routes = settings.routes || {};
    for (const tier of ['fast', 'smart', 'vision']) {
      const sel = $('#route-' + tier + '-provider');
      const inp = $('#route-' + tier + '-model');
      const r = routes[tier] || {};

      sel.innerHTML = '';
      if (tier === 'vision') {
        // Optional. Blank means "no hand-off, just skip the screenshot".
        const none = document.createElement('option');
        none.value = ''; none.textContent = 'not set';
        if (!r.provider) none.selected = true;
        sel.appendChild(none);
      }
      for (const p of providerList) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label + (p.local ? '  (local)' : '');
        if (p.id === (r.provider || settings.provider)) o.selected = true;
        sel.appendChild(o);
      }
      inp.value = r.model || '';
      syncVisionOverride(tier);
      syncWindowOverride(tier);
      updateRouteHint(tier);
      // Populate this route's suggestions from ITS provider. One shared datalist
      // offered Ollama's models while editing an OpenAI route.
      discoverForRoute(tier);
    }
    $('#route-warning').textContent = '';
    app.warmthStatus().then((w) => {
      if (w && w.switchWarning) {
        $('#route-warning').textContent = w.switchWarning;
        $('#route-warning').style.color = 'var(--warn)';
        reportSize();
      }
    }).catch(() => {});
  }

  /**
   * What is known about the model on a route, without re-implementing the
   * detection rules.
   *
   * Reads the same two sources the main process writes: the learned per-model
   * cache in settings, and whatever the provider last declared. Returns
   * true/false/null, where null means genuinely unknown -- and unknown is shown
   * as unknown, not as "no". Claiming a model is text-only when nobody has said
   * so is what sent screen questions out blind.
   */
  function knownModel(providerId, modelId) {
    const model = (modelId || '').trim();
    if (!providerId || !model) return null;
    const info = (settings.modelInfo || {})[providerId + '::' + model];
    const d = discoveryFor[providerId];
    const listed = d && d.ok ? (d.models || []).find((x) => x.id === model) : null;
    const vision = info && typeof info.vision === 'boolean' ? info.vision
      : (listed && listed.capabilitiesKnown ? !!listed.vision : null);
    return {
      vision,
      source: info && info.source ? info.source : (listed && listed.capabilitiesKnown ? 'server' : null),
      contextWindow: (info && info.contextWindow) || (listed && listed.contextWindow) || null,
      reasoning: !!(listed && listed.reasoning),
      listed: !!listed
    };
  }

  function describeVision(v) {
    if (v === true) return 'sees images';
    if (v === false) return 'text only';
    return 'image support detected on first use';
  }

  function updateRouteHint(tier) {
    const sel = $('#route-' + tier + '-provider');
    const inp = $('#route-' + tier + '-model');
    const hint = $('#route-' + tier + '-hint');
    const p = providerList.find((x) => x.id === sel.value);
    if (!p) {
      hint.textContent = tier === 'vision'
        ? 'Optional. Screen questions go here when the active model cannot see images.'
        : '';
      hint.classList.remove('bad');
      return;
    }

    const bad = [];
    if (!inp.value.trim()) bad.push('no model chosen');
    if (p.needsKey && !((settings.apiKeys || {})[p.id] || '').trim()) bad.push('needs an API key');
    if (bad.length) {
      hint.textContent = bad.join(' · ');
      hint.classList.add('bad');
      return;
    }

    // Capability belongs next to the model it describes. This is the line that
    // answers "why can it not see my screen?" without opening anything.
    const k = knownModel(p.id, inp.value);
    const bits = [p.local ? 'local, kept warm' : 'remote'];
    if (k.contextWindow) bits.push(fmtCtx(k.contextWindow));
    if (k.reasoning) bits.push('reasoning');
    if (tier !== 'vision') bits.push(describeVision(k.vision));
    hint.textContent = bits.join(' · ');
    hint.classList.remove('bad');
  }

  /** Reflect the stored override, if any, in the advanced tri-state select. */
  function syncVisionOverride(tier) {
    const sel = $('#f-' + tier + '-vision');
    if (!sel) return;
    const r = (settings.routes || {})[tier] || {};
    const info = (settings.modelInfo || {})[(r.provider || '') + '::' + (r.model || '').trim()];
    // Only a deliberate override selects yes/no. A value Nimbus worked out for
    // itself stays on "detect automatically", so re-detection is never blocked
    // by a setting the user did not make.
    sel.value = (info && info.source === 'user' && typeof info.vision === 'boolean')
      ? (info.vision ? 'yes' : 'no')
      : 'auto';
  }

  async function persistVisionOverride(tier) {
    const sel = $('#f-' + tier + '-vision');
    const r = (settings.routes || {})[tier] || {};
    const model = (r.model || '').trim();
    if (!sel || !r.provider || !model) return;
    const key = r.provider + '::' + model;
    const v = sel.value;
    const entry = Object.assign({}, (settings.modelInfo || {})[key], {
      vision: v === 'yes' ? true : v === 'no' ? false : null,
      // 'auto' is not a source: it clears the override and lets the server, or
      // the next request, answer again.
      source: v === 'auto' ? 'auto' : 'user'
    });
    settings.modelInfo = Object.assign({}, settings.modelInfo, { [key]: entry });
    await app.settingsSet({ modelInfo: { [key]: entry } });
    updateRouteHint(tier);
  }

  /** Short form of the same evidence the popover spells out. */
  const WINDOW_SOURCE_SHORT = {
    guess: 'assumed', name: 'from the name', observed: 'seen in use',
    server: 'declared', error: 'stated by the provider', user: 'set by you'
  };

  /**
   * Show what Nimbus worked out, and let it be corrected.
   *
   * The field is empty unless the user typed something: the placeholder carries
   * the learned figure and where it came from, so an override is always a
   * deliberate act and clearing the box restores automatic detection.
   */
  function syncWindowOverride(tier) {
    const inp = $('#f-' + tier + '-window');
    if (!inp) return;
    const r = (settings.routes || {})[tier] || {};
    const key = (r.provider || '') + '::' + (r.model || '').trim();
    const info = (settings.modelInfo || {})[key] || {};
    const mine = info.windowSource === 'user' && typeof info.contextWindow === 'number';

    inp.value = mine ? String(info.contextWindow) : '';
    if (typeof info.contextWindow === 'number' && !mine) {
      inp.placeholder = fmtCtx(info.contextWindow).replace(' ctx', '')
        + ' · ' + (WINDOW_SOURCE_SHORT[info.windowSource] || 'declared');
    } else if (!mine) {
      inp.placeholder = 'auto';
    }
  }

  async function persistWindowOverride(tier) {
    const inp = $('#f-' + tier + '-window');
    const r = (settings.routes || {})[tier] || {};
    const model = (r.model || '').trim();
    if (!inp || !r.provider || !model) return;
    const key = r.provider + '::' + model;

    // "32k", "32,768" and "32768" all mean the same thing to someone reading a
    // model card, so all three are accepted.
    const raw = inp.value.trim().toLowerCase().replace(/,/g, '');
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(raw);
    let n = null;
    if (m) {
      const mult = m[2] === 'm' ? 1000000 : m[2] === 'k' ? 1000 : 1;
      const v = Math.round(parseFloat(m[1]) * mult);
      if (v >= 512 && v <= 10000000) n = v;
    }
    // Anything unparseable clears the override rather than being stored as junk.
    if (raw && n == null) inp.value = '';

    const entry = Object.assign({}, (settings.modelInfo || {})[key], {
      contextWindow: n,
      // null, not 'auto': contextBudgetFor reads the number, and clearing the
      // source is what lets the server answer again.
      windowSource: n == null ? null : 'user'
    });
    settings.modelInfo = Object.assign({}, settings.modelInfo, { [key]: entry });
    await app.settingsSet({ modelInfo: { [key]: entry } });
    syncWindowOverride(tier);
    updateRouteHint(tier);
  }

  for (const tier of ['fast', 'smart']) {
    $('#f-' + tier + '-vision').addEventListener('change', () => persistVisionOverride(tier));
    $('#f-' + tier + '-window').addEventListener('change', () => persistWindowOverride(tier));
  }

  /**
   * Suggestions for one route, from that route's own provider.
   *
   * Unforced, so this rides the main process's discovery cache: opening the tab
   * or switching a provider costs at most one request per endpoint per minute,
   * and usually none.
   */
  async function discoverForRoute(tier, force = false) {
    const id = $('#route-' + tier + '-provider').value;
    const list = $('#model-list-' + tier);
    if (!id || !list) return;
    try {
      const res = await app.discoverModels(id, { force });
      discoveryFor[id] = res;
      if (!res.ok) return;
      // A vision route may only sensibly hold a model that can see; the other
      // tiers take any chat model.
      const chat = res.models.filter((m) => m.chat);
      fillDatalist(list, tier === 'vision' ? chat.filter((m) => m.vision) : chat);
      updateRouteHint(tier);
      reportSize();
    } catch { /* an unreachable server just means no suggestions */ }
  }

  async function persistRoute(tier) {
    const provider = $('#route-' + tier + '-provider').value;
    const model = $('#route-' + tier + '-model').value.trim();
    settings.routes = Object.assign({}, settings.routes, { [tier]: { provider, model } });
    await app.settingsSet({ routes: settings.routes });
    updateRouteHint(tier);
    refreshModelChip();
    renderRoutes();
    reportSize();
  }

  for (const tier of ['fast', 'smart', 'vision']) {
    $('#route-' + tier + '-provider').addEventListener('change', () => persistRoute(tier));
    // 'change' already fires on blur when the value actually changed, so a
    // second blur listener only bought a duplicate write plus a re-render that
    // fought whatever the user clicked next.
    $('#route-' + tier + '-model').addEventListener('change', () => persistRoute(tier));
  }

  function renderSettings() {
    /**
     * Resolve the edit target BEFORE painting the list, and re-resolve it every
     * render. Deleting a custom provider (or removing one from the registry)
     * left `editingProvider` pointing at nothing, and the detail pane below then
     * kept showing the dead entry's key and models -- edits to it went nowhere.
     */
    if (!providerList.some((x) => x.id === editingProvider)) {
      editingProvider = providerList.some((x) => x.id === settings.provider)
        ? settings.provider
        : (providerList[0] && providerList[0].id) || null;
    }
    renderProviders();
    renderRoutes();

    const p = providerList.find((x) => x.id === editingProvider);
    if (p) {
      const m = (settings.models && settings.models[p.id]) || {};
      $('#row-baseurl').classList.toggle('hidden', p.kind !== 'openai');
      $('#f-baseurl').value = m.baseURL || p.baseURL || '';
      $('#f-baseurl').placeholder = p.baseURL || 'https://api.openai.com/v1';
      /**
       * The key row is always shown.
       *
       * It used to be hidden whenever `local && !needsKey`, and custom
       * endpoints are created with exactly those defaults -- so a self-hosted
       * server sitting behind auth had no way to be given its key. Plenty of
       * local-ish endpoints need one (vLLM started with --api-key, a remote
       * Lemonade, OpenRouter, Groq), and the transport already sends whatever
       * is entered regardless of the needsKey flag. Only the field was missing.
       */
      $('#row-key').classList.remove('hidden');
      $('#f-key').value = (settings.apiKeys && settings.apiKeys[p.id]) || '';
      $('#f-key').placeholder = p.needsKey ? (p.keyPlaceholder || 'required') : 'optional, leave blank if the server ignores auth';

      // needsKey/local are properties of a custom entry, not of a built-in.
      $('#custom-opts').classList.toggle('hidden', !p.custom);
      const cust = (settings.customProviders || []).find((c) => c.id === p.id);
      $('#f-needskey').checked = cust ? cust.needsKey !== false : !!p.needsKey;
      $('#f-local').checked = cust ? cust.local !== false : !!p.local;
      $('#f-label').value = m.label || '';
      $('#f-label').placeholder = p.label;
      // Names the thing being edited. With the model fields gone this pane is
      // purely "how to reach X", and it has to say which X.
      $('#provider-detail-label').textContent = 'Connection — ' + p.label;
      $('#discover-status').textContent = '';
      $('#test-status').textContent = '';
    }

    const stt = settings.stt || {};
    $('#f-stt').value = stt.provider || 'local';
    $('#f-stt-url').value = stt.localBaseURL || '';
    $('#f-stt-model').value = stt.provider === 'local' ? (stt.localModel || '') : (stt.remoteModel || '');
    $('#f-target-lang').value = stt.targetLang || 'English';
    $('#f-stt-tochat').checked = stt.toChat !== false;
    syncSttRows();
    // Asks the main process what the engine is doing right now, so the pane
    // never shows a build that failed to install as though it were running.
    refreshEngine().catch(() => {});

    const a = settings.audio || {};
    $('#f-system-audio').checked = a.captureSystem !== false;
    $('#f-mic-mode').value = a.micMode || 'ptt';
    $('#f-ptt-key').value = ((settings.shortcuts || {}).talk) || 'Control+Alt+Space';
    syncSourceRows();
    $('#f-vad').value = Math.round((a.vadThreshold || 0.010) * 1000);
    $('#vad-val').textContent = describeSensitivity(a.vadThreshold || 0.010);
    $('#f-hangover').value = a.silenceHangoverMs || 550;
    $('#hangover-val').textContent = (a.silenceHangoverMs || 550) + 'ms';
    $('#f-digest').value = a.digest || 'summarize';
    $('#f-digest-ceiling').value = Math.round((a.digestCeilingMs || 180000) / 1000);
    syncDigestRows();
    $('#f-listen-launch').checked = !!a.listenOnLaunch;
    $('#f-wake').checked = !!a.wakeWordEnabled;
    $('#f-wake-word').value = a.wakeWord || 'hey nimbus';
    $('#row-wake').classList.toggle('hidden', !a.wakeWordEnabled);

    const ui = settings.ui || {};
    applyAdvanced(!!ui.advanced);
    $('#f-glass').value = ui.glass || 'shaped';
    syncGlassNote();
    $('#f-zoom').value = Math.round((ui.textZoom || 1) * 100);
    $('#zoom-val').textContent = Math.round((ui.textZoom || 1) * 100) + '%';
    $('#f-stealth').checked = !!ui.privacy;

    const hcfg = settings.history || {};
    const ctx = typeof hcfg.contextTurns === 'number' ? hcfg.contextTurns : 12;
    $('#f-ctx').value = ctx;
    $('#ctx-val').textContent = ctx === 0 ? 'off' : ctx + ' turns';

    syncCompactSettings();

    const reply = settings.reply || {};
    const mt = typeof reply.maxTokens === 'number' ? reply.maxTokens : 4096;
    $('#f-maxtok').value = mt;
    $('#maxtok-val').textContent = fmtTokens(mt);

    // Was called twice, once under a name that does not exist. The undefined
    // call threw before the two rows above ever ran, so the context slider sat
    // at its markup default no matter what was saved.
    refreshStealthStatus();
  }

  function fmtTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k tokens' : n + ' tokens';
  }

  function describeSensitivity(v) {
    if (v <= 0.006) return 'very sensitive';
    if (v <= 0.012) return 'balanced';
    if (v <= 0.022) return 'less sensitive';
    return 'loud speech only';
  }

  /**
   * Which transcription controls apply right now.
   *
   * The managed engine overrides the stored Server and Model on every start, so
   * leaving those two rows on screen while it runs shows a pair of editable
   * fields that describe nothing: they still read :8000 and faster-whisper
   * while :8081 was serving CrisperWhisper. The engine's own status line below
   * reports what is actually running, so the rows come back only when the user
   * is the one pointing Nimbus at a server.
   */
  function syncSttRows() {
    const mode = $('#f-stt').value;
    const managed = mode === 'local' && (((settings.stt || {}).engine || {}).manage !== false);
    $('#row-stt-url').classList.toggle('hidden', mode !== 'local' || managed);
    $('#row-stt-model').classList.toggle('hidden', mode === 'off' || mode === 'gemini' || managed);
    $('#row-stt-refresh').classList.toggle('hidden', managed);
    $('#row-target-lang').classList.toggle('hidden', mode === 'off');
    // Nimbus only manages a server for the local engine; with OpenAI or Gemini
    // selected there is nothing on this machine to install.
    $('#group-engine').classList.toggle('hidden', mode !== 'local');
    reportSize();
  }

  /**
   * Say what the current combination of sources actually means.
   *
   * The interesting states are the ones the user did not intend: both sources
   * off (Nimbus can hear nothing at all and listening will refuse to start), and
   * a chord bound where the native layer cannot give a key-up, which silently
   * turns hold-to-talk into press-to-toggle.
   */
  /**
   * Says, in words, what turning this on will actually do -- including that it
   * costs a model call every few minutes. A setting that quietly starts
   * spending money on a timer should say so where it is switched on, not in a
   * changelog.
   */
  function syncDigestRows() {
    const mode = $('#f-digest').value;
    const secs = Number($('#f-digest-ceiling').value) || 180;
    const mins = secs % 60 === 0 ? (secs / 60) + ' min' : secs + 's';
    $('#digest-ceiling-val').textContent = mins;
    $('#f-digest-ceiling').closest('.s-row').classList.toggle('hidden', mode === 'off');

    const lang = ($('#f-target-lang').value || 'English').trim();
    const what = {
      off: 'System audio is transcribed and shown, and nothing else happens to it.',
      summarize: 'Nimbus writes a short running account of what it hears, using the Fast model.',
      translate: 'Nimbus renders what it hears into ' + lang + ', using the Fast model.',
      both: 'Nimbus renders what it hears into ' + lang + ' and adds a short summary, using the Fast model.'
    }[mode] || '';
    $('#digest-hint').textContent = mode === 'off'
      ? what
      : what + ' Expect one call per pause in the audio, and at most one every ' + mins + ' during unbroken audio.';
  }

  function syncSourceRows() {
    const mode = $('#f-mic-mode').value;
    const sys = $('#f-system-audio').checked;
    $('#row-ptt').classList.toggle('hidden', mode !== 'ptt');

    let hint;
    if (!sys && mode === 'off') {
      hint = 'Nothing is being captured. Listening will not start until one source is on.';
    } else if (mode === 'ptt') {
      hint = sys
        ? 'Nimbus transcribes what is playing on this PC. Your microphone is silent until you hold the key.'
        : 'Only your microphone, and only while the key is held.';
      if (pttMode === 'latch') {
        hint += ' Key-up is unavailable on this build, so the key toggles the mic instead of holding it.';
      } else if (pttMode === 'unbound') {
        hint += ' This combination could not be bound -- pick another, or use the pill button.';
      }
    } else if (mode === 'always') {
      hint = sys
        ? 'Both the microphone and system audio are transcribed for as long as Nimbus is listening.'
        : 'The microphone is transcribed for as long as Nimbus is listening.';
    } else {
      hint = 'The microphone device is never opened. System audio only.';
    }
    $('#mic-hint').textContent = hint;
    reportSize();
  }

  async function persistProvider() {
    const p = providerList.find((x) => x.id === editingProvider);
    if (!p || !settings) return;
    settings.apiKeys = settings.apiKeys || {};
    settings.models = settings.models || {};
    settings.apiKeys[p.id] = $('#f-key').value.trim();
    const renamed = $('#f-label').value.trim();
    /**
     * Connection settings only.
     *
     * `fast`/`smart` and `vision` used to be written here too. The models were
     * a duplicate of the routing rows above, and the vision flag was per
     * PROVIDER -- so choosing a text-only model in a field nothing called
     * stamped "cannot see images" onto every model the endpoint serves,
     * including the one that could. Capability now lives per model in
     * settings.modelInfo, written by whoever actually knows.
     */
    settings.models[p.id] = Object.assign({}, settings.models[p.id], {
      baseURL: $('#f-baseurl').value.trim() || undefined,
      label: renamed || undefined
    });
    /**
     * Custom entries keep needsKey/local/baseURL/label in `customProviders`,
     * because that array is what providers.list() builds them from. Writing
     * only to `models` would leave list() showing stale values.
     */
    if (p.custom) {
      const url = $('#f-baseurl').value.trim();
      settings.customProviders = (settings.customProviders || []).map((c) => (
        c.id === p.id
          ? { ...c,
              label: renamed || c.label,
              baseURL: url || c.baseURL,
              needsKey: $('#f-needskey').checked,
              local: $('#f-local').checked }
          : c
      ));
      await app.settingsSet({ customProviders: settings.customProviders });
      await reloadProviders();
    }

    await app.settingsSet({ apiKeys: settings.apiKeys, models: settings.models });
    refreshModelChip();
  }

  // Persist on blur rather than per keystroke; the store debounces anyway but
  // this keeps the settings file from churning while an API key is typed.
  ['#f-key', '#f-baseurl', '#f-label'].forEach((sel) => {
    $(sel).addEventListener('blur', persistProvider);
  });

  /**
   * One advanced gate for the entire settings screen.
   *
   * This replaced a per-section disclosure. Four independent chevrons meant the
   * same question -- "show me the expert controls" -- had to be answered four
   * times, and a knob a user knew existed could be behind any of them.
   */
  function applyAdvanced(on) {
    $('.s-scroll').classList.toggle('adv', !!on);
    $('#f-advanced').checked = !!on;
    reportSize();
  }

  $('#f-advanced').addEventListener('change', async () => {
    const on = $('#f-advanced').checked;
    applyAdvanced(on);
    settings.ui = Object.assign({}, settings.ui, { advanced: on });
    await app.settingsSet({ ui: { advanced: on } });
  });

  $('#f-needskey').addEventListener('change', async () => {
    await persistProvider();
    renderSettings(); // placeholder text and readiness both depend on it
  });
  $('#f-local').addEventListener('change', persistProvider);

  function fmtCtx(n) {
    if (!n) return '';
    if (n >= 1000) return Math.round(n / 1024) + 'k ctx';
    return n + ' ctx';
  }

  function fillDatalist(el, models) {
    el.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      const bits = [];
      if (m.vision) bits.push('vision');
      if (m.contextWindow) bits.push(fmtCtx(m.contextWindow));
      if (bits.length) o.label = bits.join(' · ');
      el.appendChild(o);
    }
  }

  $('#refresh-models').addEventListener('click', async () => {
    await persistProvider();
    const status = $('#discover-status');
    status.textContent = 'Checking…';
    // Explicit user action, so bypass the discovery cache unconditionally.
    const res = await app.discoverModels(editingProvider, { force: true });
    if (!res.ok) { status.textContent = res.error; reportSize(); return; }

    discoveryFor[editingProvider] = res;
    // Only chat models belong in the chat pickers; a transcription or TTS
    // checkpoint selected as the chat model fails in a confusing way.
    const chat = res.models.filter((m) => m.chat);
    fillDatalist($('#stt-model-list'), res.models.filter((m) => m.stt));

    /**
     * Refresh is the one action that must reach the routing rows.
     *
     * The main process has just folded every declared capability into the
     * per-model cache, so re-reading the local copy and repainting the routes
     * on this provider is what turns "why can it not see my screen" into a
     * visible answer, without the user hunting for a checkbox.
     */
    settings = await app.settingsGet();
    for (const tier of ['fast', 'smart', 'vision']) {
      if ($('#route-' + tier + '-provider').value !== editingProvider) continue;
      const list = $('#model-list-' + tier);
      fillDatalist(list, tier === 'vision' ? chat.filter((m) => m.vision) : chat);
      syncVisionOverride(tier);
      syncWindowOverride(tier);
      updateRouteHint(tier);
    }

    status.textContent = chat.length
      ? chat.length + ' chat model' + (chat.length === 1 ? '' : 's')
        + (res.classified ? ' · capabilities read from server' : ' · capabilities guessed from names')
      : 'Server reachable but no chat models are loaded.';
    reportSize();
  });

  /**
   * One button that answers "will this provider actually work?".
   *
   * The old settings screen could only list models, which passes against a
   * server that then rejects every completion -- wrong key, model not loaded,
   * a reasoning model with no room to answer. This runs a real one-line
   * generation and reports latency, so a failure names itself here instead of
   * appearing later as a blank bubble.
   */
  $('#test-provider').addEventListener('click', async () => {
    const btn = $('#test-provider');
    const status = $('#test-status');
    if (btn.disabled) return;
    await persistProvider();
    btn.disabled = true;
    status.className = 's-hint';
    status.textContent = 'Testing…';
    reportSize();
    try {
      const r = await app.testProvider(editingProvider);
      // The message already carries latency and time-to-first-token. Appending
      // them again printed the same number twice in one line.
      status.textContent = r.message;
      status.className = 's-hint ' + (r.level === 'ok' ? 'good' : r.level === 'warn' ? 'warn' : 'bad');
    } catch (e) {
      status.textContent = (e && e.message) || String(e);
      status.className = 's-hint bad';
    } finally {
      btn.disabled = false;
      reportSize();
    }
  });

  $('#refresh-stt').addEventListener('click', async () => {
    const status = $('#stt-status');
    status.textContent = 'Checking…';
    const res = await app.discoverSttModels();
    if (!res.ok) { status.textContent = res.error; reportSize(); return; }
    const stt = res.models.filter((m) => m.stt);
    fillDatalist($('#stt-model-list'), stt.length ? stt : res.models);
    status.textContent = stt.length
      ? stt.length + ' speech model' + (stt.length === 1 ? '' : 's') + ' found'
      : 'No model is tagged for transcription on that server.';
    if (stt.length === 1 && !$('#f-stt-model').value.trim()) {
      $('#f-stt-model').value = stt[0].id;
      settings.stt = Object.assign({}, settings.stt, { localModel: stt[0].id });
      await app.settingsSet({ stt: settings.stt });
    }
    reportSize();
  });

  $('#add-provider').addEventListener('click', async () => {
    const n = (settings.customProviders || []).length + 1;
    const entry = {
      id: 'custom' + Date.now().toString(36),
      label: 'Custom ' + n,
      baseURL: 'http://127.0.0.1:8080/v1',
      // Optional rather than required: an unset key must not block readiness,
      // but the field is always visible so a key can be supplied when the
      // endpoint wants one.
      needsKey: false,
      local: true,
      vision: false
    };
    settings.customProviders = (settings.customProviders || []).concat([entry]);
    await app.settingsSet({ customProviders: settings.customProviders });
    await reloadProviders();
    editingProvider = entry.id;
    renderSettings();
  });

  $('#f-stt').addEventListener('change', async () => {
    syncSttRows();
    settings.stt = Object.assign({}, settings.stt, { provider: $('#f-stt').value });
    await app.settingsSet({ stt: settings.stt });
  });
  ['#f-stt-url', '#f-stt-model'].forEach((sel) => $(sel).addEventListener('blur', async () => {
    const mode = $('#f-stt').value;
    const patch = { localBaseURL: $('#f-stt-url').value.trim() };
    if (mode === 'local') patch.localModel = $('#f-stt-model').value.trim();
    else patch.remoteModel = $('#f-stt-model').value.trim();
    settings.stt = Object.assign({}, settings.stt, patch);
    await app.settingsSet({ stt: settings.stt });
  }));
  // ---- the managed local engine --------------------------------------------
  /**
   * Three facts, kept apart on screen.
   *
   * What the hardware probe found, what was asked for, and what the server is
   * actually running are not the same thing: an asset can be missing upstream,
   * or an accelerated build can start and quietly fall back to CPU when its
   * backend fails to bind a device. Collapsing them into one "GPU: yes" line
   * is how a user ends up believing in an acceleration they never got.
   */
  let engineOptions = null;

  function fillSelect(sel, items, extra) {
    sel.innerHTML = '';
    for (const o of [extra].concat(items).filter(Boolean)) {
      const el = document.createElement('option');
      el.value = o.id;
      el.textContent = o.label + (o.approxMB ? ' — ' + (o.approxMB >= 1024
        ? (o.approxMB / 1024).toFixed(1) + ' GB' : o.approxMB + ' MB') : '');
      if (o.note) el.title = o.note;
      sel.appendChild(el);
    }
  }

  function engineLine(s) {
    if (!s) return '';
    if (s.phase === 'ready') {
      const how = s.accel ? ('GPU · ' + (s.device || s.build)) : 'CPU';
      const weights = s.family === 'crisper' ? 'CrisperWhisper' : 'Whisper';
      return 'Running ' + weights + ' on the ' + s.build + ' build, ' + how + ', at ' + s.endpoint + '.';
    }
    if (s.phase === 'error') return s.message || 'The engine failed.';
    if (s.message) return s.message;
    return s.phase === 'idle' ? 'Not running.' : s.phase + '…';
  }

  function paintEngine(s) {
    $('#engine-status').textContent = engineLine(s);
    const bar = $('#engine-bar');
    const p = s && s.progress;
    bar.classList.toggle('hidden', !p);
    if (p) bar.querySelector('i').style.width = Math.round(100 * p.done / (p.total || p.done || 1)) + '%';
    reportSize();
  }

  async function refreshEngine() {
    const info = await app.engineStatus();
    engineOptions = info.options;
    const cfg = (settings.stt || {}).engine || {};
    fillSelect($('#f-engine-build'), info.options.builds,
      { id: 'auto', label: 'Automatic' + (info.decision ? ' (' + info.decision.build + ')' : '') });
    fillSelect($('#f-engine-model'), info.options.models,
      { id: 'auto', label: 'Automatic' + (info.decision ? ' (' + info.decision.modelTier + ')' : '') });
    fillSelect($('#f-engine-family'), info.options.families || [],
      { id: 'auto', label: 'Automatic (CrisperWhisper)' });
    $('#f-engine-build').value = cfg.build || 'auto';
    $('#f-engine-model').value = cfg.model || 'auto';
    $('#f-engine-family').value = cfg.family || 'auto';
    $('#f-engine-manage').checked = cfg.manage !== false;
    $('#engine-hw').textContent = info.hardware || 'not probed yet';
    paintFamilyNote(info);
    const on = cfg.manage !== false;
    ['#row-engine-hw', '#row-engine-build', '#row-engine-family', '#row-engine-model', '#row-engine-actions']
      .forEach((sel) => $(sel).classList.toggle('hidden', !on));
    $('#engine-family-note').classList.toggle('hidden', !on);
    // Turning the managed engine on or off changes which Transcription rows
    // mean anything, and that group is painted by the other function.
    syncSttRows();
    paintEngine(info.status);
  }

  /**
   * What the chosen weights cost the user.
   *
   * CrisperWhisper is the better transcriber for this app's purpose but it is
   * English and German only and its licence is non-commercial research, and both
   * of those are the user's decision to make, not ours to bury.
   */
  function paintFamilyNote(info) {
    const chosen = (info.choice && info.choice.family) || 'crisper';
    const fam = ((info.options && info.options.families) || []).find((f) => f.id === chosen);
    const el = $('#engine-family-note');
    if (!fam) { el.textContent = ''; return; }
    const langs = fam.languages ? fam.languages.join(', ') : 'all languages';
    el.textContent = fam.label + ' — ' + langs + ' · ' + fam.license
      + (fam.id === 'crisper' ? ' · other languages fall back to Whisper automatically' : '');
  }

  app.on('stt:engine', (s) => paintEngine(s));

  $('#f-engine-manage').addEventListener('change', async () => {
    const engine = Object.assign({}, (settings.stt || {}).engine, { manage: $('#f-engine-manage').checked });
    settings.stt = Object.assign({}, settings.stt, { engine });
    await app.settingsSet({ stt: { engine } });
    await refreshEngine();
  });

  ['#f-engine-build', '#f-engine-model', '#f-engine-family'].forEach((sel) => $(sel).addEventListener('change', async () => {
    const engine = Object.assign({}, (settings.stt || {}).engine, {
      build: $('#f-engine-build').value,
      model: $('#f-engine-model').value,
      family: $('#f-engine-family').value
    });
    settings.stt = Object.assign({}, settings.stt, { engine });
    // Saved, not installed: switching build is a download, so it waits for the button.
    await app.settingsSet({ stt: { engine } });
    await refreshEngine();
  }));

  $('#engine-install').addEventListener('click', async () => {
    $('#engine-status').textContent = 'Working…';
    try {
      const s = await app.engineInstall({
        build: $('#f-engine-build').value,
        model: $('#f-engine-model').value,
        family: $('#f-engine-family').value
      });
      paintEngine(s);
    } catch (e) {
      $('#engine-status').textContent = (e && e.message) || String(e);
    }
    reportSize();
  });

  $('#engine-reprobe').addEventListener('click', async () => {
    $('#engine-hw').textContent = 'Scanning…';
    await app.engineProbe();
    await refreshEngine();
  });

  $('#f-target-lang').addEventListener('blur', async () => {
    const v = $('#f-target-lang').value.trim() || 'English';
    $('#f-target-lang').value = v;
    settings.stt = Object.assign({}, settings.stt, { targetLang: v });
    // The digest hint names the language it will translate into.
    syncDigestRows();
    await app.settingsSet({ stt: settings.stt });
  });

  // ---- audio sources -------------------------------------------------------
  $('#f-system-audio').addEventListener('change', async () => {
    settings.audio = Object.assign({}, settings.audio, { captureSystem: $('#f-system-audio').checked });
    syncSourceRows();
    await app.settingsSet({ audio: settings.audio });
  });

  $('#f-mic-mode').addEventListener('change', async () => {
    settings.audio = Object.assign({}, settings.audio, { micMode: $('#f-mic-mode').value });
    syncSourceRows();
    await app.settingsSet({ audio: settings.audio });
  });

  /**
   * Chord capture.
   *
   * The field is readonly and records the next key combination pressed rather
   * than accepting typed text, because an accelerator the user typed by hand is
   * a string that has to be validated, and one they pressed is by construction a
   * chord they can press again.
   */
  let capturingChord = false;
  function stopCapturingChord() {
    capturingChord = false;
    $('#f-ptt-key').classList.remove('capturing');
    $('#f-ptt-key').value = ((settings.shortcuts || {}).talk) || 'Control+Alt+Space';
  }

  $('#f-ptt-key').addEventListener('focus', () => {
    capturingChord = true;
    $('#f-ptt-key').classList.add('capturing');
    $('#f-ptt-key').value = 'Press the keys to hold…';
  });
  $('#f-ptt-key').addEventListener('blur', stopCapturingChord);

  const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta'];

  /**
   * DOM KeyboardEvent.key -> Electron accelerator name.
   *
   * Not cosmetic: src/pushtotalk.js parses the saved string back into virtual
   * key codes, and an unparseable chord leaves push-to-talk silently bound to
   * nothing. 'ArrowUp' and ' ' are the two the browser spells differently from
   * every accelerator convention.
   */
  const KEY_ALIAS = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Enter: 'Return', Esc: 'Escape', Del: 'Delete', Spacebar: 'Space'
  };

  function accelKeyName(key) {
    if (KEY_ALIAS[key]) return KEY_ALIAS[key];
    return key.length === 1 ? key.toUpperCase() : key;
  }

  async function saveTalkChord(accel) {
    settings.shortcuts = Object.assign({}, settings.shortcuts, { talk: accel });
    await app.settingsSet({ shortcuts: settings.shortcuts });
    capturingChord = false;
    $('#f-ptt-key').classList.remove('capturing');
    $('#f-ptt-key').value = accel;
    $('#f-ptt-key').blur();
    // Main re-parses the chord on save, so ask it what the binding actually
    // became rather than assuming it took. An unparseable chord comes back
    // 'unbound' and the hint says so.
    try {
      const nat = await app.nativeStatus();
      pttMode = (nat && nat.pushToTalk) || pttMode;
    } catch { /* keep the previous answer */ }
    syncSourceRows();
  }

  $('#f-ptt-key').addEventListener('keydown', async (e) => {
    if (!capturingChord) return;
    e.preventDefault();
    if (e.key === 'Escape') { $('#f-ptt-key').blur(); return; }

    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');

    // A bare modifier is a legitimate hold-to-talk binding -- "hold right Alt"
    // is a good one -- so it is accepted on RELEASE rather than waiting for a
    // non-modifier key that may never come.
    const bare = MODIFIER_KEYS.includes(e.key);
    const accel = (bare ? mods : mods.concat([accelKeyName(e.key)])).join('+');
    if (!accel) return;

    $('#f-ptt-key').value = accel;
    if (bare) return;             // keep capturing until a real key lands
    await saveTalkChord(accel);
  });

  $('#f-ptt-key').addEventListener('keyup', async (e) => {
    if (!capturingChord || !MODIFIER_KEYS.includes(e.key)) return;
    const accel = $('#f-ptt-key').value;
    if (!accel || accel.indexOf('…') >= 0) return;
    await saveTalkChord(accel);
  });

  $('#ptt-reset').addEventListener('click', () => saveTalkChord('Control+Alt+Space'));

  $('#f-vad').addEventListener('input', async () => {
    const v = Number($('#f-vad').value) / 1000;
    $('#vad-val').textContent = describeSensitivity(v);
    settings.audio = Object.assign({}, settings.audio, { vadThreshold: v });
    await app.settingsSet({ audio: settings.audio });
  });
  $('#f-hangover').addEventListener('input', async () => {
    const v = Number($('#f-hangover').value);
    $('#hangover-val').textContent = v + 'ms';
    settings.audio = Object.assign({}, settings.audio, { silenceHangoverMs: v });
    await app.settingsSet({ audio: settings.audio });
  });
  $('#f-digest').addEventListener('change', async () => {
    syncDigestRows();
    settings.audio = Object.assign({}, settings.audio, { digest: $('#f-digest').value });
    await app.settingsSet({ audio: settings.audio });
  });
  $('#f-digest-ceiling').addEventListener('input', async () => {
    const v = Number($('#f-digest-ceiling').value) * 1000;
    syncDigestRows();
    settings.audio = Object.assign({}, settings.audio, { digestCeilingMs: v });
    await app.settingsSet({ audio: settings.audio });
  });
  $('#f-stt-tochat').addEventListener('change', async () => {
    settings.stt = Object.assign({}, settings.stt, { toChat: $('#f-stt-tochat').checked });
    await app.settingsSet({ stt: settings.stt });
  });
  $('#f-listen-launch').addEventListener('change', async () => {
    settings.audio = Object.assign({}, settings.audio, { listenOnLaunch: $('#f-listen-launch').checked });
    await app.settingsSet({ audio: settings.audio });
  });
  $('#f-wake').addEventListener('change', async () => {
    settings.audio = Object.assign({}, settings.audio, { wakeWordEnabled: $('#f-wake').checked });
    $('#row-wake').classList.toggle('hidden', !$('#f-wake').checked);
    await app.settingsSet({ audio: settings.audio });
    reportSize();
  });
  $('#f-wake-word').addEventListener('blur', async () => {
    settings.audio = Object.assign({}, settings.audio, { wakeWord: $('#f-wake-word').value.trim().toLowerCase() });
    await app.settingsSet({ audio: settings.audio });
  });
  /**
   * The context slider had no listener at all: it rendered, it moved, and
   * nothing was ever saved. Same class of bug as the reply-length control it
   * now sits next to.
   */
  $('#f-ctx').addEventListener('input', async () => {
    const v = Number($('#f-ctx').value);
    $('#ctx-val').textContent = v === 0 ? 'off' : v + ' turns';
    settings.history = Object.assign({}, settings.history, { contextTurns: v });
    await app.settingsSet({ history: settings.history });
  });

  $('#f-maxtok').addEventListener('input', async () => {
    const v = Number($('#f-maxtok').value);
    $('#maxtok-val').textContent = fmtTokens(v);
    settings.reply = Object.assign({}, settings.reply, { maxTokens: v });
    await app.settingsSet({ reply: settings.reply });
  });

  // ---- context compression -------------------------------------------------
  /**
   * The two sliders only mean anything while compression is on, so they collapse
   * with the toggle rather than sitting there greyed out and inviting a click.
   */
  function syncCompactSettings() {
    const c = settings.context || {};
    const on = c.autoCompact !== false;
    const trigger = Math.round((typeof c.triggerPct === 'number' ? c.triggerPct : 0.55) * 100);
    const hot = typeof c.keepHot === 'number' ? c.keepHot : 6;

    $('#f-autocompact').checked = on;
    $('#f-trigger').value = trigger;
    $('#trigger-val').textContent = trigger + '% full';
    $('#f-keephot').value = hot;
    $('#keephot-val').textContent = hot + ' messages';
    $('#row-trigger').classList.toggle('hidden', !on);
    $('#row-keephot').classList.toggle('hidden', !on);
    $('#compact-hint').textContent = on
      ? 'Compression starts once the context is ' + trigger + '% full, and the last '
        + hot + ' messages are always sent word for word so follow-ups still resolve.'
      : 'Long conversations will be truncated instead: the oldest turns stop being sent, '
        + 'and the assistant forgets them without saying so. Compress by hand from the model chip.';

    // The turn limit above only bites when compression is off, so the hint that
    // describes it has to say which of the two is in force. A slider that reads
    // "12 turns" while the whole conversation is being sent is a lie the user
    // would only catch by counting tokens.
    $('#ctx-turns-hint').textContent = on
      ? 'Not applied while compression is on — the summary bounds the context instead, '
        + 'so nothing is dropped without being folded in first. Turn compression off to '
        + 'cap the conversation at this many turns.'
      : 'Prior turns sent with each message. More context means better follow-ups and a '
        + 'slower first token.';
  }

  async function saveContext(patch) {
    settings.context = Object.assign({}, settings.context, patch);
    await app.settingsSet({ context: settings.context });
    syncCompactSettings();
  }

  $('#f-autocompact').addEventListener('change', () => saveContext({ autoCompact: $('#f-autocompact').checked }));
  $('#f-trigger').addEventListener('input', () => saveContext({ triggerPct: Number($('#f-trigger').value) / 100 }));
  $('#f-keephot').addEventListener('input', () => saveContext({ keepHot: Number($('#f-keephot').value) }));

  async function refreshStealthStatus() {
    try {
      const st = await app.stealthStatus();
      const el = $('#stealth-status');
      if (!st || !st.enabled) { el.textContent = ''; return; }
      const per = Object.entries(st.windows || {})
        .map(([k, v]) => k + ': ' + v.mode).join('  ·  ');
      // Reports what the OS confirms, not what was requested.
      el.textContent = (st.verified ? 'Verified: excluded from all capture. ' : 'NOT fully protected. ') + per;
      el.style.color = st.verified ? 'var(--live)' : 'var(--danger)';
    } catch { /* non-fatal */ }
  }

  $('#f-stealth').addEventListener('change', async () => {
    const on = $('#f-stealth').checked;
    settings.ui = Object.assign({}, settings.ui, { privacy: on });
    // Applied live: affinity is a syscall on a live HWND, no restart needed.
    const res = await app.setStealth(on);
    await refreshStealthStatus();
    const verified = res && res.status && res.status.verified;
    showNotice(on
      ? (verified
          ? 'Nimbus is now excluded from recordings, shares and screenshots. Confirmed on every window.'
          : 'Requested, but the OS did not confirm it on every window, see the status line.')
      : 'Nimbus will now appear in recordings and shares.', on && !verified ? 'error' : 'info');
    reportSize();
  });

  const GLASS_NOTE = {
    shaped: 'Exact pill and rounded panel. No desktop blur: Windows paints its blur across the whole window rectangle and ignores the shape we clip to, so real blur and a true pill cannot both be had.',
    acrylic: 'Real desktop blur, but Windows rounds the frame itself at about 8px, so the pill becomes a rounded rectangle.',
    blur: 'Cheaper gaussian blur. Same ~8px corner limitation as acrylic.',
    off: 'No blur and no tint from the compositor; the shape is exact.'
  };
  // The explanation lives on the control as a tooltip, not as a paragraph
  // under it. A settings screen is a list of choices, not documentation.
  function syncGlassNote() {
    $('#f-glass').title = GLASS_NOTE[$('#f-glass').value] || '';
  }

  $('#provider-search').addEventListener('input', renderProviders);

  $('#f-glass').addEventListener('change', async () => {
    settings.ui = Object.assign({}, settings.ui, { glass: $('#f-glass').value });
    await app.settingsSet({ ui: settings.ui });
    syncGlassNote();
    // Applied immediately; the accent is a syscall on a live window.
    await app.applySettings({ glass: settings.ui.glass });
  });

  $('#apply-btn').addEventListener('click', async () => {
    await persistProvider();
    const res = await app.applySettings({
      glass: (settings.ui || {}).glass,
      stealth: !!(settings.ui || {}).privacy
    });
    const st = $('#apply-status');
    if (res && res.needsRestart && res.needsRestart.length) {
      st.textContent = 'Saved. ' + res.needsRestart.join(', ') + ' needs a relaunch.';
    } else {
      st.textContent = 'Saved and applied.';
    }
    setTimeout(() => { st.textContent = ''; reportSize(); }, 4000);
    reportSize();
  });

  $('#relaunch-btn').addEventListener('click', async () => {
    await persistProvider();
    $('#apply-status').textContent = 'Relaunching…';
    await app.relaunch();
  });
  $('#f-zoom').addEventListener('input', async () => {
    const pct = Number($('#f-zoom').value);
    $('#zoom-val').textContent = pct + '%';
    document.documentElement.style.setProperty('--text-zoom', pct / 100);
    settings.ui = Object.assign({}, settings.ui, { textZoom: pct / 100 });
    await app.settingsSet({ ui: settings.ui });
    reportSize();
  });

  // ---- context fill --------------------------------------------------------
  /** Last snapshot from main, so the popover can be opened without a round trip. */
  let ctx = null;

  function fmtTokens(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1000) return String(Math.round(n));
    const k = n / 1000;
    return (k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)) + 'k';
  }

  /** How the window was arrived at, in words the user can act on. */
  const WINDOW_SOURCE = {
    guess: 'assumed — this server declares no window',
    name: 'read from the model name',
    observed: 'at least this big, seen in use',
    server: 'declared by the server',
    error: 'stated by the provider',
    user: 'set by you'
  };

  function paintContext(c) {
    ctx = c || null;
    const rail = $('#ctx-rail');
    if (!ctx) { rail.classList.add('hidden'); $('#ctx-pop').classList.add('hidden'); return; }

    const pct = Math.max(0, Math.min(1, ctx.pct || 0));
    rail.classList.remove('hidden');
    rail.classList.toggle('guessed', !!ctx.guessed);
    rail.dataset.level = pct >= 0.9 ? 'hot' : pct >= 0.75 ? 'high' : pct >= 0.6 ? 'warm' : 'ok';
    rail.firstElementChild.style.width = (pct * 100).toFixed(1) + '%';

    $('#ctx-pct').textContent = Math.round(pct * 100) + '% of context used';
    $('#ctx-model').textContent = ctx.model || '';
    $('#ctx-bar-fill').style.width = (pct * 100).toFixed(1) + '%';

    const lines = [
      fmtTokens(ctx.used) + ' of ' + fmtTokens(ctx.usable) + ' usable · '
        + fmtTokens(ctx.reply) + ' held back for the reply',
      'Window ' + (ctx.guessed ? '~' : '') + fmtTokens(ctx.window)
        + ' — ' + (WINDOW_SOURCE[ctx.source] || ctx.source),
      ctx.calibrated
        ? 'Counted with this model’s own token figures'
        : 'Estimated from characters until the model reports usage'
    ];
    if (ctx.compacted) lines.push('Earlier turns are already folded into a summary');
    $('#ctx-lines').innerHTML = '';
    for (const l of lines) {
      const d = document.createElement('div');
      d.textContent = l;
      $('#ctx-lines').appendChild(d);
    }
    paintCompactBtn();
  }

  /** True while main is compressing, so the button cannot be pressed twice. */
  let compacting = false;

  function paintCompactBtn() {
    const btn = $('#ctx-compact');
    if (!btn) return;
    // While it runs the button becomes its own cancel. A disabled "Compressing…"
    // would leave a long call with no way out except the timeout.
    btn.disabled = !ctx;
    btn.textContent = compacting ? 'Stop compressing' : 'Compress now';
    btn.title = compacting
      ? 'Stop. The conversation is left exactly as it is.'
      : 'Fold the earlier turns into a summary, on the smart model. Nothing is deleted.';
    // The card carries its own copy of the same button and has to agree with it.
    const card = $('#advice-compact');
    if (card) card.textContent = compacting ? 'Stop compressing' : 'Compress now';
  }

  function toggleContextPop(force) {
    const pop = $('#ctx-pop');
    const open = force != null ? force : pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !open || !ctx);
    $('#model-chip').setAttribute('aria-expanded', String(open && !!ctx));
  }

  function refreshModelChip() {
    // Reads the ACTIVE TIER'S route, so the chip shows what will actually answer.
    const tier = settings.smart ? 'smart' : 'fast';
    const r = ((settings.routes || {})[tier]) || {};
    const pid = r.provider || settings.provider;
    const p = providerList.find((x) => x.id === pid);
    const legacy = (settings.models && settings.models[pid]) || {};
    const name = (r.model || legacy[tier] || '').trim() || '-';
    $('#model-name').textContent = (p ? p.label + ' · ' : '') + name;
    $('#model-chip').title = tier.toUpperCase() + ' tier → ' + (p ? p.label : pid) + ' / ' + name;
  }

  async function reloadProviders() {
    providerList = await app.providers();
  }

  // ---- events from main ----------------------------------------------------
  app.on('llm:start', ({ userBubble, small }) => {
    // Append, do not clear. Wiping on every turn is what made this a one-shot
    // query box rather than a conversation.
    showView('chat');
    if (userBubble) addUser(userBubble);
    startAi(!!small);
    setBusy(true);
    reportSize();
  });
  app.on('llm:token', ({ text }) => appendToken(text));
  app.on('llm:reasoning', ({ text }) => appendReasoning(text));
  app.on('llm:done', () => { finalizeAi(); setBusy(false); });
  app.on('llm:error', ({ message }) => {
    // An empty answer with reasoning behind it is not an empty turn: dropping
    // the bubble would also drop the only evidence of what the model did.
    if (aiEl && !aiEl.dataset.raw && !thinkEl) {
      const w = aiEl.parentElement;
      if (w && w.classList.contains('turn')) w.remove(); else aiEl.remove();
      aiEl = null; caretEl = null;
    }
    else {
      const stalled = !!(aiEl && !aiEl.dataset.raw && thinkEl);
      const think = thinkEl;
      finalizeAi();
      if (stalled) {
        think.querySelector('summary').textContent = 'Thought, but never answered';
        think.open = true;
      }
    }
    setBusy(false);
    showNotice(message, 'error');
  });
  app.on('status', ({ message, level }) => showNotice(message, level || 'info'));
  app.on('audio:digest', (d) => addDigest(d));
  app.on('transcript:heard', (h) => addHeard(h));
  app.on('transcript:stage', ({ text }) => stageTranscript(text));
  app.on('settings:changed', (s) => { settings = s; refreshModelChip(); });
  app.on('context:usage', (c) => paintContext(c));
  app.on('compact:state', (s) => { compacting = !!(s && s.active); paintCompactBtn(); });
  app.on('compact:advice', (a) => showAdvice(a));
  app.on('compact:done', (r) => {
    // The marker goes in from the broadcast rather than from a reload: the
    // session on screen is the live one, and re-rendering it would scroll the
    // user away from whatever they were reading.
    addFold({ content: (r && r.text) || '', folded: r && r.turns, ts: r && r.ts });
    if (r && r.before && r.after) {
      // A summary can come out no smaller than the handful of short turns it
      // replaced. Reporting that as "back to 126%" reads like a win and is not
      // one, so the two outcomes get different sentences.
      const saved = Math.round((1 - r.after / r.before) * 100);
      showNotice(saved > 0
        ? 'Compressed ' + r.turns + ' earlier messages. Context is ' + saved + '% smaller.'
        : 'Compressed ' + r.turns + ' earlier messages, but the summary is no shorter than '
          + 'the turns it replaced. Nothing was lost — later exchanges will fold better.',
      'info');
    }
  });
  app.on('panel:focus-input', () => claimInput(input));
  app.on('open-settings', () => showSettings(true));
  app.on('history:changed', ({ title }) => { if (title) $('#convo-title').textContent = title; });
  app.on('history:opened', (s) => renderSession(s || { messages: [] }));
  app.on('display:changed', ({ availableHeight }) => { applyAvailableHeight(availableHeight); reportSize(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Cancelling the answer outranks closing the panel. Hiding the window
      // while a stream is live left it running, billing and unreadable.
      if (busy) { e.preventDefault(); stop(); return; }
      /**
       * The first Escape out of a text field is "give me my caret back".
       *
       * It ends input mode and main hands the foreground to the window it was
       * borrowed from, with the panel left open and untouched -- the whole
       * point being to get back to what you were typing in without losing the
       * conversation. A second Escape then closes the panel as it always did.
       */
      const el = document.activeElement;
      if (el && el.matches && el.matches(EDITABLE)) {
        e.preventDefault();
        el.blur();
        app.releaseFocus();
        return;
      }
      if (!$('#ctx-pop').classList.contains('hidden')) { e.preventDefault(); toggleContextPop(false); return; }
      if (!$('#view-settings').classList.contains('hidden')) persistProvider().then(() => showView('chat'));
      else if (!$('#view-history').classList.contains('hidden')) showView('chat');
      else app.togglePanel({});
    }
    if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); $('#new-btn').click(); }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); showView('history'); }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); showSettings(true); }
  });

  /** Keep CSS geometry in agreement with whoever is drawing the frame. */
  function applyGlassMode(mode, systemCorners) {
    const r = document.documentElement;
    r.classList.toggle('system-corners', !!systemCorners);
    r.classList.toggle('shaped', mode === 'shaped' || mode === 'off');
  }

  // ---- boot ----------------------------------------------------------------
  (async function boot() {
    settings = await app.settingsGet();

    // Must happen before the first reportSize(): the caps decide the height we
    // are about to tell main to size the window to.
    try {
      const info = await app.displayInfo();
      applyAvailableHeight(info && info.availableHeight);
    } catch { /* fall back to the 800px default in panel.css */ }

    await reloadProviders();
    editingProvider = settings.provider;

    app.on('glass:changed', ({ mode, systemCorners }) => applyGlassMode(mode, systemCorners));

    const nat = await app.nativeStatus();
    applyGlassMode(nat && nat.glass, nat && nat.systemCorners);
    // Decides whether the push-to-talk row is allowed to call itself "hold".
    pttMode = (nat && nat.pushToTalk) || 'hold';
    if (settings) syncSourceRows();
    if (!nat || !nat.available) {
      document.documentElement.classList.add('no-native');
      $('#native-status').textContent = 'Native glass unavailable: ' + ((nat && nat.error) || 'unknown') + '. Using the CSS fallback.';
    } else {
      $('#native-status').textContent = 'Native acrylic active.';
    }

    // Build stamp. See the app:info handler in main.js for why this is here.
    try {
      const info = await app.appInfo();
      const when = info.builtAt ? new Date(info.builtAt) : null;
      const stamp = when
        ? when.toLocaleDateString() + ' ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'unknown';
      $('#build-status').textContent =
        'Nimbus ' + info.version + ' · Electron ' + info.electron + ' · '
        + (info.packaged ? 'packaged build from ' + stamp : 'running from source')
        + (info.packaged ? ' — rebuild after editing source' : '');
      $('#build-status').style.color = info.packaged ? 'var(--warn)' : '';
    } catch { /* non-fatal */ }

    document.documentElement.style.setProperty('--text-zoom', (settings.ui && settings.ui.textZoom) || 1);
    $('#smart').classList.toggle('on', !!settings.smart);
    refreshModelChip();
    // Must precede any settings render: the groups are hidden until a tab is
    // selected, so skipping this leaves an empty settings panel.
    showTab('models');

    try {
      const cur = await app.historyCurrent();
      if (cur && cur.messages && cur.messages.length) renderSession(cur);
    } catch { /* no session simply means an empty chat */ }

    // Pulled once: the panel is created after main has already broadcast
    // whatever it knew, so without this the rail stays blank until the first
    // question of the session.
    try { paintContext(await app.contextUsage()); } catch { /* no route configured yet */ }

    syncPlaceholder();
    reportSize();
  })();
})();
