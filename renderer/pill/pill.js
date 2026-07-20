/* Nimbus — pill window.
 *
 * Owns: window drag, audio capture, listening state, panel toggle, the app
 * menu, and reporting its own measured size so the OS window tracks content.
 *
 * The pill says nothing at rest. Text appears only when there is something
 * worth reading, and disappears again. See pill.css for why.
 */
(function () {
  'use strict';

  const { icon } = window.ICONS;
  const app = window.nimbus;
  const $ = (s) => document.querySelector(s);

  const pill = $('#pill');
  const message = $('#message');
  const waveBars = Array.from(document.querySelectorAll('.wave i'));
  const listenBtn = $('#listen-btn');
  const toggleBtn = $('#toggle-btn');
  const menu = $('#menu');

  let settings = null;
  let listening = false;
  let capture = null;
  let speechTimer = null;
  let messageTimer = null;

  // ---- icons ---------------------------------------------------------------
  $('.mark-glyph').innerHTML = icon('logo', { size: 16 });
  toggleBtn.innerHTML = '<span class="chev">' + icon('chevron-down', { size: 15 }) + '</span>';
  $('#m-listen .ic').innerHTML = icon('mic', { size: 14 });
  $('#m-settings .ic').innerHTML = icon('settings', { size: 14 });
  $('#m-quit .ic').innerHTML = icon('x', { size: 14 });

  // ---- transient message ---------------------------------------------------
  /**
   * Show something briefly, then get out of the way.
   *
   * Nothing is displayed permanently. A label that is always present is not
   * information, it is furniture.
   */
  function say(text, holdMs) {
    clearTimeout(messageTimer);
    if (!text) {
      message.textContent = '';
      document.body.classList.remove('has-message');
      reportSize();
      return;
    }
    message.textContent = text;
    document.body.classList.add('has-message');
    reportSize();
    if (holdMs !== 0) {
      messageTimer = setTimeout(() => say(null), holdMs || 2600);
    }
  }

  function setListening(on) {
    listening = on;
    document.body.classList.toggle('listening', on);
    listenBtn.classList.toggle('on', on);
    listenBtn.setAttribute('aria-pressed', String(on));
    listenBtn.innerHTML = icon(on ? 'mic' : 'mic-off', { size: 15 });
    listenBtn.title = on ? 'Stop listening  (Ctrl+Shift+L)' : 'Start listening  (Ctrl+Shift+L)';
    $('#m-listen').querySelector('span:nth-child(2)').textContent = on ? 'Stop listening' : 'Start listening';
    if (!on) waveBars.forEach((b) => { b.style.height = '3px'; });
    reportSize();
  }

  function setThinking(on) {
    document.body.classList.toggle('thinking', on);
  }

  const BAR = [0.6, 1.0, 0.85, 0.5];
  function renderLevel(rms) {
    const n = Math.min(1, Math.sqrt(rms / 0.11));
    for (let i = 0; i < waveBars.length; i++) {
      waveBars[i].style.height = (3 + n * 12 * BAR[i] * (0.85 + Math.random() * 0.3)).toFixed(1) + 'px';
    }
  }

  // ---- size reporting ------------------------------------------------------
  let lastW = 0, lastH = 0;
  function reportSize() {
    const r = pill.getBoundingClientRect();
    const w = Math.ceil(r.width), h = Math.ceil(r.height);
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    app.pillSize(w, h);
  }
  new ResizeObserver(reportSize).observe(pill);

  // ---- menu ----------------------------------------------------------------
  function openMenu(open) {
    menu.classList.toggle('open', open);
    $('#mark').setAttribute('aria-expanded', String(open));
    // The menu paints outside the pill, so the window has to grow to contain
    // it — the region clip would otherwise slice it off.
    app.menuOpen(open);
  }
  $('#mark').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(!menu.classList.contains('open'));
  });
  document.addEventListener('click', () => openMenu(false));
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openMenu(false); });

  $('#m-listen').addEventListener('click', () => { openMenu(false); listening ? stopListening() : startListening(); });
  $('#m-settings').addEventListener('click', () => { openMenu(false); app.openSettings(); });
  $('#m-quit').addEventListener('click', () => app.quit());

  // ---- drag ----------------------------------------------------------------
  pill.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    pill.classList.add('dragging');
    app.dragStart();
    const up = () => { pill.classList.remove('dragging'); app.dragEnd(); window.removeEventListener('mouseup', up); };
    window.addEventListener('mouseup', up);
  });

  // ---- capture -------------------------------------------------------------
  function handlers() {
    return {
      onUtterance: (channel, buffer, durationMs) => app.utterance({ channel, durationMs }, buffer),
      onLevel: (_c, rms) => { if (listening) renderLevel(rms); },
      onSpeech: (_c, active) => {
        clearTimeout(speechTimer);
        if (active) document.body.classList.add('speech');
        else speechTimer = setTimeout(() => document.body.classList.remove('speech'), 240);
      }
    };
  }

  async function startListening() {
    if (listening) return;
    if (!capture) capture = window.NimbusAudio.createCapture(handlers());
    setListening(true);
    const res = await capture.start(settings.audio || {});
    if (!res.mic && !res.system) {
      setListening(false);
      say('No audio input', 4000);
      app.status({ level: 'error', message: (res.errors || []).join(' ') || 'Could not open any audio input.' });
      return;
    }
    if (res.errors && res.errors.length) app.status({ level: 'warn', message: res.errors.join(' ') });
    app.listenState(true);
  }

  function stopListening() {
    if (!listening) return;
    if (capture) capture.stop();
    setListening(false);
    app.listenState(false);
  }

  listenBtn.addEventListener('click', () => (listening ? stopListening() : startListening()));
  toggleBtn.addEventListener('click', () => app.togglePanel({ focus: true }));

  // ---- events from main ----------------------------------------------------
  app.on('panel:state', ({ open }) => {
    toggleBtn.classList.toggle('open', open);
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.title = open ? 'Hide chat  (Ctrl+Shift+Space)' : 'Show chat  (Ctrl+Shift+Space)';
  });

  app.on('llm:start', () => setThinking(true));
  app.on('llm:done', () => setThinking(false));
  app.on('llm:error', () => { setThinking(false); say('Error', 3200); });

  app.on('listen:request', ({ active }) => {
    if (active === undefined) listening ? stopListening() : startListening();
    else if (active) startListening(); else stopListening();
  });

  app.on('settings:changed', (s) => {
    settings = s;
    applyTheme(s);
    if (capture) capture.configure(s.audio || {});
  });

  // Show what was heard, briefly. This is the one case where text earns its
  // place: it confirms the thing was understood.
  app.on('transcript', ({ text }) => {
    if (!listening || !text) return;
    say(text.length > 40 ? text.slice(0, 39) + '…' : text, 2400);
  });

  function applyGlassMode(mode, systemCorners) {
    const r = document.documentElement;
    r.classList.toggle('system-corners', !!systemCorners);
    r.classList.toggle('shaped', mode === 'shaped' || mode === 'off');
  }
  function applyTheme(s) {
    const t = (s && s.ui && s.ui.theme) || 'obsidian';
    document.documentElement.setAttribute('data-theme', t);
  }

  // ---- boot ----------------------------------------------------------------
  (async function boot() {
    settings = await app.settingsGet();
    applyTheme(settings);
    app.on('glass:changed', ({ mode, systemCorners }) => applyGlassMode(mode, systemCorners));
    const nat = await app.nativeStatus();
    applyGlassMode(nat && nat.glass, nat && nat.systemCorners);
    if (!nat || !nat.available) document.documentElement.classList.add('no-native');

    document.documentElement.style.setProperty('--text-zoom', (settings.ui && settings.ui.textZoom) || 1);
    setListening(false);
    reportSize();
    if (settings.audio && settings.audio.listenOnLaunch) startListening();
  })();
})();
