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
  const talkBtn = $('#talk-btn');
  const toggleBtn = $('#toggle-btn');
  const menu = $('#menu');

  let settings = null;
  let listening = false;
  let capture = null;
  let speechTimer = null;
  let messageTimer = null;
  let micOpen = false;

  const micMode = () => ((settings && settings.audio && settings.audio.micMode) || 'ptt');
  const talkAccel = () => ((settings && settings.shortcuts && settings.shortcuts.talk) || 'Control+Alt+Space');

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
    /**
     * The button shows the SOURCE, not a generic mic.
     *
     * With the mic on push-to-talk the thing being listened to is the speakers,
     * and a mic glyph over that is a straightforward lie about what the app is
     * hearing -- the one claim on this pill that must not be wrong. Which is
     * also why system audio being off puts the mic glyph back: with nothing
     * coming from the speakers, the mic is the only source there is.
     */
    const systemOn = !settings || !settings.audio || settings.audio.captureSystem !== false;
    const ambientIsMic = micMode() === 'always' || !systemOn;
    listenBtn.innerHTML = icon(
      ambientIsMic ? (on ? 'mic' : 'mic-off') : (on ? 'volume-2' : 'volume-x'),
      { size: 15 }
    );
    const src = ambientIsMic ? 'microphone' : 'system audio';
    listenBtn.title = (on ? 'Stop listening to ' + src : 'Listen to ' + src) + '  (Ctrl+Shift+L)';
    $('#m-listen').querySelector('span:nth-child(2)').textContent = on ? 'Stop listening' : 'Start listening';
    if (!on) waveBars.forEach((b) => setBar(b, BAR_REST));
    syncTalkButton();
    reportSize();
  }

  /**
   * Push-to-talk affordance.
   *
   * Only exists while the mic is actually on push-to-talk AND Nimbus is
   * listening: outside that it can do nothing, and a dead control on a pill this
   * small costs more than it explains.
   */
  function syncTalkButton() {
    const show = listening && micMode() === 'ptt';
    talkBtn.classList.toggle('hidden', !show);
    talkBtn.innerHTML = icon('mic', { size: 15 });
    talkBtn.title = 'Hold to talk  (' + talkAccel().replace(/\+/g, ' + ') + ')';
  }

  function setMicOpen(on) {
    micOpen = !!on;
    document.body.classList.toggle('mic-open', micOpen);
    talkBtn.classList.toggle('on', micOpen);
    talkBtn.setAttribute('aria-pressed', String(micOpen));
    if (capture) capture.setMicOpen(micOpen);
  }

  function setThinking(on) {
    document.body.classList.toggle('thinking', on);
  }

  const BAR = [0.6, 1.0, 0.85, 0.5];
  const BAR_H = 16;        // must match `.wave i` height in pill.css
  const BAR_REST = 3;      // px

  /** Level as a transform, not a height. See the `.wave i` comment in pill.css. */
  function setBar(el, px) {
    el.style.transform = 'scaleY(' + Math.min(1, px / BAR_H).toFixed(3) + ')';
  }

  function renderLevel(rms) {
    const n = Math.min(1, Math.sqrt(rms / 0.11));
    for (let i = 0; i < waveBars.length; i++) {
      setBar(waveBars[i], BAR_REST + n * 12 * BAR[i] * (0.85 + Math.random() * 0.3));
    }
  }

  // ---- size reporting ------------------------------------------------------
  /**
   * The pill is measured, then pinned to whole pixels.
   *
   * `width: max-content` lands on fractions -- 100.6px at rest -- and an OS
   * window can only be an integer, so the window was a pixel and a half wider
   * than the shape drawn inside it. Clipped to the window rather than to the
   * pill, that leftover column showed as a dark rim down one side. Rounding up
   * and then setting the width back means the element fills the window exactly.
   *
   * The width is cleared before every measurement so this reads the content's
   * own size rather than the answer it gave last time, which would freeze the
   * pill at its first width and stop the stage from ever expanding.
   */
  let lastW = 0, lastH = 0;
  function reportSize() {
    pill.style.width = 'max-content';
    const r = pill.getBoundingClientRect();
    const w = Math.ceil(r.width), h = Math.ceil(r.height);
    pill.style.width = w + 'px';
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    app.pillSize(w, h);
  }
  new ResizeObserver(reportSize).observe(pill);

  // ---- menu ----------------------------------------------------------------
  /**
   * Where the menu actually is, in CSS pixels.
   *
   * Main clips the window to the pill's shape OR this rectangle, and it used to
   * carry its own copy of these numbers. The CSS moved and the constants did
   * not: the clip ended up 19px wider and 29px taller than the menu and two
   * pixels above it, so the menu's top row was shaved off and the surplus
   * around it showed as a grey shelf. Measuring beats mirroring.
   *
   * offset* rather than getBoundingClientRect(): the open transition animates a
   * translate, and a rect read mid-flight would clip the window to wherever the
   * menu happened to be at that instant.
   */
  function menuRect() {
    return {
      x: menu.offsetLeft,
      y: menu.offsetTop,
      w: Math.ceil(menu.offsetWidth),
      h: Math.ceil(menu.offsetHeight),
      radius: parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 12
    };
  }

  function openMenu(open) {
    menu.classList.toggle('open', open);
    $('#mark').setAttribute('aria-expanded', String(open));
    // The menu paints outside the pill, so the window has to grow to contain
    // it — the region clip would otherwise slice it off.
    app.menuOpen(open, open ? menuRect() : null);
  }
  $('#mark').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(!menu.classList.contains('open'));
  });
  document.addEventListener('click', () => openMenu(false));
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openMenu(false); });

  /**
   * There is no click-outside to hear any more.
   *
   * The pill never takes the foreground -- that is the point, it must not pull
   * the caret out of whatever the user is typing in -- so it gets no blur event
   * and no keystrokes when the attention moves elsewhere. A menu left open
   * would sit there until they came back and clicked the pill again. The
   * pointer leaving is the honest signal that they have moved on; the delay
   * covers the gap between the pill and the menu, which is not part of the
   * window and so reads as a leave on the way past.
   */
  let leaveTimer = 0;
  document.documentElement.addEventListener('mouseleave', () => {
    clearTimeout(leaveTimer);
    if (menu.classList.contains('open')) leaveTimer = setTimeout(() => openMenu(false), 900);
  });
  document.documentElement.addEventListener('mouseenter', () => clearTimeout(leaveTimer));

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
      onSpeech: (channel, active) => {
        clearTimeout(speechTimer);
        if (active) document.body.classList.add('speech');
        else speechTimer = setTimeout(() => document.body.classList.remove('speech'), 240);
        // The digest decides where a block ends from this, not from when the
        // last utterance happened to finish transcribing.
        app.speech(channel, active);
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
      app.status({
        level: 'error',
        message: (res.errors || []).join(' ')
          || 'Both audio sources are switched off. Turn on system audio or the microphone in Settings > Voice.'
      });
      return;
    }
    if (res.errors && res.errors.length) app.status({ level: 'warn', message: res.errors.join(' ') });
    app.listenState(true);
    say(res.system && micMode() !== 'always' ? 'Listening to system audio' : 'Listening', 2000);
  }

  function stopListening() {
    if (!listening) return;
    if (capture) capture.stop();
    setMicOpen(false);
    setListening(false);
    app.listenState(false);
  }

  listenBtn.addEventListener('click', () => (listening ? stopListening() : startListening()));
  /**
   * Opened without taking the keyboard.
   *
   * This used to ask for focus, which meant showing the conversation cost the
   * user the caret in whatever they were working in -- the panel is mostly read
   * from, and clicking the composer asks for focus by itself when they do want
   * to type. The summon shortcut still opens it focused, because pressing that
   * IS the request to type.
   */
  toggleBtn.addEventListener('click', () => app.togglePanel({}));

  /**
   * Hold the button to talk.
   *
   * Reported to main rather than applied locally: main merges this with the
   * global hold-to-talk key into one gate state and broadcasts the result, so
   * there is exactly one answer to "is the mic open" and it is the same one that
   * decides whether a 'you' utterance is accepted.
   *
   * pointer* events, not mouse*: pointerup fires even when the cursor has left
   * the button, and pointercancel covers the window losing the pointer entirely.
   * A mouseup missed on the way out would leave the mic open indefinitely.
   */
  talkBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();          // the pill drags on mousedown; talking is not dragging
    try { talkBtn.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    app.micHold(true);
  });
  const releaseTalk = () => app.micHold(false);
  talkBtn.addEventListener('pointerup', releaseTalk);
  talkBtn.addEventListener('pointercancel', releaseTalk);
  window.addEventListener('blur', releaseTalk);

  // ---- events from main ----------------------------------------------------
  app.on('panel:state', ({ open }) => {
    // Showing the conversation is a different intent from the menu that was
    // open over it, and the panel covers the menu anyway. Either way round --
    // the chevron, the shortcut, or main opening the panel by itself -- the
    // menu goes with it.
    if (open) openMenu(false);
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

  app.on('mic:gate', ({ open }) => setMicOpen(open));

  app.on('settings:changed', async (s) => {
    const prev = settings;
    settings = s;
    applyTheme(s);
    if (!capture) return;
    capture.configure(s.audio || {});

    // Source changes take effect on the running session instead of demanding a
    // stop/start: switching the mic mode mid-call is exactly when you need it.
    const a = (s.audio || {});
    const b = ((prev || {}).audio || {});
    if (a.micMode !== b.micMode || a.captureSystem !== b.captureSystem) {
      syncTalkButton();
      const res = await capture.applySources(a);
      if (res.errors.length) app.status({ level: 'warn', message: res.errors.join(' ') });
      if (res.needsGesture && listening) {
        // getDisplayMedia needs a user gesture and a settings save is not one.
        say('Restart listening for system audio', 4200);
        app.status({ level: 'info', message: 'System audio was switched on. Toggle listening off and on to grant it.' });
      }
      reportSize();
    }
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
