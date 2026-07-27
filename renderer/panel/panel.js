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
  let lastDiscovery = { models: [], classified: false };
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
  $('#history-btn').innerHTML = icon('message-circle', { size: 15 });
  $('#new-btn').innerHTML = icon('plus', { size: 16 });
  $('#add-provider .ic').innerHTML = icon('plus', { size: 13 });
  $('#refresh-models .ic').innerHTML = icon('refresh-cw', { size: 12 });
  $('#test-provider .ic').innerHTML = icon('zap', { size: 12 });
  $('#refresh-stt .ic').innerHTML = icon('mic', { size: 12 });

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
  function renderMarkdown(text) {
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
    return html;
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

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = '';
    syncPlaceholder();
    runMode('ask', text);
  }
  function stop() { if (busy) app.abort(); }
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
      m.textContent = fmtWhen(s.updatedAt) + '  ·  ' + s.count + (s.count === 1 ? ' message' : ' messages')
        // `snippet` exists only on search hits; the plain list carries `preview`.
        // Reading just the former left every unsearched row with no context.
        + (s.snippet || s.preview ? '  ·  ' + (s.snippet || s.preview) : '');
      b.appendChild(t); b.appendChild(m);

      const kill = document.createElement('span');
      kill.className = 'kill icon-btn';
      kill.innerHTML = icon('trash', { size: 12 });
      kill.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await app.historyDelete(s.id);
        renderHistory($('#h-search').value.trim());
      });
      b.appendChild(kill);

      b.addEventListener('click', async () => {
        const full = await app.historyLoad(s.id);
        if (full) { renderSession(full); showView('chat'); }
      });
      list.appendChild(b);
    }
    $('#h-count').textContent = items.length + (items.length === 1 ? ' conversation' : ' conversations');
    reportSize();
  }

  /** Replay a stored session into the chat view. */
  function renderSession(s) {
    clearMessages();
    $('#convo-title').textContent = (s && s.title) || 'New conversation';
    for (const m of ((s && s.messages) || [])) {
      if (m.role === 'user') addUser(m.content);
      else if (m.role === 'assistant') {
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
  $('#h-close').addEventListener('click', () => showView('chat'));
  $('#new-btn').addEventListener('click', async () => {
    await app.historyNew();
    clearMessages();
    $('#convo-title').textContent = 'New conversation';
    showView('chat');
    input.focus();
  });
  $('#h-search').addEventListener('input', () => renderHistory($('#h-search').value.trim()));
  $('#h-clear').addEventListener('click', async () => {
    await app.historyClear();
    clearMessages();
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
      updateRouteHint(tier);
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

    const bits = [];
    if (!inp.value.trim()) bits.push('no model chosen');
    if (p.needsKey && !((settings.apiKeys || {})[p.id] || '').trim()) bits.push('needs an API key');
    hint.textContent = bits.length
      ? bits.join(' · ')
      : (p.local ? 'local, kept warm automatically' : 'remote endpoint');
    hint.classList.toggle('bad', bits.length > 0);
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
      $('#f-fast').value = m.fast || '';
      $('#f-smart').value = m.smart || '';
      $('#f-vision').checked = typeof m.vision === 'boolean' ? m.vision : !!p.vision;
      $('#f-label').value = m.label || '';
      $('#f-label').placeholder = p.label;
      $('#model-meta').textContent = m.contextWindow ? fmtCtx(m.contextWindow) : '';
      $('#discover-status').textContent = '';
      $('#model-list').innerHTML = '';
    }

    const stt = settings.stt || {};
    $('#f-stt').value = stt.provider || 'local';
    $('#f-stt-url').value = stt.localBaseURL || '';
    $('#f-stt-model').value = stt.provider === 'local' ? (stt.localModel || '') : (stt.remoteModel || '');
    syncSttRows();

    const a = settings.audio || {};
    $('#f-vad').value = Math.round((a.vadThreshold || 0.010) * 1000);
    $('#vad-val').textContent = describeSensitivity(a.vadThreshold || 0.010);
    $('#f-hangover').value = a.silenceHangoverMs || 550;
    $('#hangover-val').textContent = (a.silenceHangoverMs || 550) + 'ms';
    $('#f-listen-launch').checked = !!a.listenOnLaunch;
    $('#f-wake').checked = !!a.wakeWordEnabled;
    $('#f-wake-word').value = a.wakeWord || 'hey nimbus';
    $('#row-wake').classList.toggle('hidden', !a.wakeWordEnabled);

    const ui = settings.ui || {};
    $('#f-glass').value = ui.glass || 'shaped';
    syncGlassNote();
    $('#f-zoom').value = Math.round((ui.textZoom || 1) * 100);
    $('#zoom-val').textContent = Math.round((ui.textZoom || 1) * 100) + '%';
    $('#f-stealth').checked = !!ui.privacy;

    const hcfg = settings.history || {};
    const ctx = typeof hcfg.contextTurns === 'number' ? hcfg.contextTurns : 12;
    $('#f-ctx').value = ctx;
    $('#ctx-val').textContent = ctx === 0 ? 'off' : ctx + ' turns';

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

  function syncSttRows() {
    const mode = $('#f-stt').value;
    $('#row-stt-url').classList.toggle('hidden', mode !== 'local');
    $('#row-stt-model').classList.toggle('hidden', mode === 'off' || mode === 'gemini');
    reportSize();
  }

  async function persistProvider() {
    const p = providerList.find((x) => x.id === editingProvider);
    if (!p || !settings) return;
    settings.apiKeys = settings.apiKeys || {};
    settings.models = settings.models || {};
    settings.apiKeys[p.id] = $('#f-key').value.trim();
    const renamed = $('#f-label').value.trim();
    settings.models[p.id] = Object.assign({}, settings.models[p.id], {
      fast: $('#f-fast').value.trim(),
      smart: $('#f-smart').value.trim(),
      vision: $('#f-vision').checked,
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
              local: $('#f-local').checked,
              vision: $('#f-vision').checked }
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
  ['#f-key', '#f-fast', '#f-smart', '#f-baseurl', '#f-label'].forEach((sel) => {
    $(sel).addEventListener('blur', persistProvider);
  });
  $('#f-vision').addEventListener('change', persistProvider);
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
    const res = await app.discoverModels(editingProvider);
    if (!res.ok) { status.textContent = res.error; reportSize(); return; }

    lastDiscovery = res;
    // Only chat models belong in the chat pickers; a transcription or TTS
    // checkpoint selected as the chat model fails in a confusing way.
    const chat = res.models.filter((m) => m.chat);
    fillDatalist($('#model-list'), chat);
    fillDatalist($('#stt-model-list'), res.models.filter((m) => m.stt));

    status.textContent = chat.length
      ? chat.length + ' chat model' + (chat.length === 1 ? '' : 's')
        + (res.classified ? ' · capabilities read from server' : ' · capabilities guessed from names')
      : 'Server reachable but no chat models are loaded.';
    syncModelMeta();
    reportSize();
  });

  /**
   * Reflect the selected model's advertised capabilities.
   *
   * When the server states them (Lemonade's `labels`) the vision checkbox is set
   * from the label rather than left to the user to guess. Guessing wrong is not
   * a cosmetic error: a text-only model given an image fails the whole request,
   * and on some servers it fails inside a 200 response.
   */
  function syncModelMeta() {
    const tier = settings.smart ? 'smart' : 'fast';
    const chosen = (tier === 'smart' ? $('#f-smart').value : $('#f-fast').value).trim();
    const m = (lastDiscovery.models || []).find((x) => x.id === chosen);
    const meta = $('#model-meta');
    if (!m) { meta.textContent = ''; return; }

    const bits = [];
    if (m.contextWindow) bits.push(fmtCtx(m.contextWindow));
    else bits.push('context length not reported');
    bits.push(m.vision ? 'accepts images' : 'text only');
    if (m.reasoning) bits.push('reasoning');
    if (m.tools) bits.push('tool-calling');
    meta.textContent = bits.join(' · ') + (m.capabilitiesKnown ? '' : ' (guessed)');

    if (m.capabilitiesKnown) {
      $('#f-vision').checked = !!m.vision;
      settings.models[editingProvider] = Object.assign({}, settings.models[editingProvider], {
        vision: !!m.vision,
        contextWindow: m.contextWindow || null
      });
      app.settingsSet({ models: settings.models });
    }
  }

  ['#f-fast', '#f-smart'].forEach((sel) => $(sel).addEventListener('change', syncModelMeta));

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
  app.on('settings:changed', (s) => { settings = s; refreshModelChip(); });
  app.on('panel:focus-input', () => { input.focus(); });
  app.on('open-settings', () => showSettings(true));
  app.on('history:changed', ({ title }) => { if (title) $('#convo-title').textContent = title; });
  app.on('history:opened', (s) => renderSession(s || { messages: [] }));
  app.on('display:changed', ({ availableHeight }) => { applyAvailableHeight(availableHeight); reportSize(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Cancelling the answer outranks closing the panel. Hiding the window
      // while a stream is live left it running, billing and unreadable.
      if (busy) { e.preventDefault(); stop(); return; }
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

    syncPlaceholder();
    reportSize();
  })();
})();
