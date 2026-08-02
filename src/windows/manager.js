'use strict';
/**
 * Window topology.
 *
 * The old build put the pill, the panel, the settings sheet and the onboarding
 * modal inside ONE fixed 700x600 transparent window, then tried to fake
 * click-through by running document.elementFromPoint() on every mousemove and
 * toggling setIgnoreMouseEvents(). That approach has three unfixable problems:
 *
 *   1. The dead space between the pill and the panel is still window. Whether a
 *      click reaches the app underneath depends on a JS heuristic winning a race.
 *   2. Collapsing the panel with `display:none` hides pixels but the 700x600
 *      window still exists, so it keeps eating clicks in a region that looks
 *      empty. This is the "residue" the app had after hiding.
 *   3. While the window ignores the mouse it also stops getting reliable
 *      mousemove events, so the heuristic that is supposed to re-enable it can
 *      miss its own wake-up.
 *
 * Fix: make them separate real OS windows, each clipped to its exact visual
 * shape. The gap between them is not part of any window, so clicks pass through
 * because there is nothing there, not because we asked nicely. Hiding the panel
 * removes it from hit-testing at the OS level. Both are structural guarantees,
 * not best-effort.
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const win32 = require('../native/win32');
const { Spring, SpringLoop } = require('../spring');

const RENDERER = path.join(__dirname, '..', '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', '..', 'preload.js');

// Seed sizes. Both are corrected by the renderer's ResizeObserver on first paint.
const PILL = { w: 232, h: 40, radius: 20 };
// minH is 2, not 1: Windows refuses to size a top-level window below roughly
// 36px and silently clamps, so a "collapsed" height is cosmetic anyway. The
// window is hidden at rest, so the clamp is never visible.
const PANEL = { w: 640, h: 320, radius: 22, minH: 2 };
const GAP = 10;          // vertical space between pill and panel
/**
 * Flush with the top of the work area, not floating below it.
 *
 * The pill is meant to read as part of the bezel -- an extension of the
 * hardware rather than a window someone left open. A gap of any size breaks
 * that: it becomes an object with a shadow on all four sides, and the eye
 * places it in front of the desktop instead of on the edge of the screen.
 *
 * Measured from the WORK area, so a taskbar docked to the top pushes it down
 * rather than being covered by it.
 */
const TOP_MARGIN = 0;
// Kept clear of every work-area edge so the panel never sits flush against a
// taskbar or a display seam.
const EDGE_MARGIN = 8;
/**
 * Below this much room, "below the pill" is not a usable place to put the panel
 * and it flips above instead. Roughly a header plus two rows -- less than that
 * and the user is scrolling a letterbox.
 */
const MIN_PANEL_H = 180;
/** Below this the panel is unreadable, so it overhangs a tiny display instead. */
const MIN_PANEL_W = 320;
// Menu geometry, mirrored in pill.css. The window is clipped to pill OR menu,
// so these must match what the CSS actually paints.
const MENU_WIDTH = 208;
const MENU_HEIGHT = 136;   // 3 items + separator; mirrors pill.css
const MENU_GAP = 6;
const MENU_INSET = 2;

const TINT_PILL = { r: 16, g: 18, b: 24, a: 0x96 };
const TINT_PANEL = { r: 16, g: 18, b: 24, a: 0x8A };

class WindowManager {
  constructor({ onEvent, stealth = false } = {}) {
    this.pill = null;
    this.panel = null;
    this.onEvent = onEvent || (() => {});

    /**
     * Content protection (WDA_EXCLUDEFROMCAPTURE) is OFF by default.
     *
     * On Windows 11 it interacts badly with `transparent: true`: excluding the
     * window from capture also drops it out of the DWM composition path that
     * per-pixel-alpha windows depend on, and the window renders nowhere -- not
     * in screenshots and not on the physical display either. Verified on build
     * 26200: with protection on the HWND reports visible with correct bounds and
     * a correct region, and nothing is drawn.
     *
     * It is a stealth feature, not a requirement, so it is opt-in.
     */
    this.stealth = !!stealth;

    // 'acrylic' | 'blur' | 'off'. Live-swappable; see applyGlass().
    this.glassMode = 'acrylic';

    this.panelOpen = false;
    this.menuOpen = false;
    this.pillSize = { w: PILL.w, h: PILL.h };
    this.panelSize = { w: PANEL.w, h: PANEL.h };

    // Animated panel height. Width is not sprung: a width spring reads as
    // sloppy at this scale, and retargeting both at once causes visible shear.
    this.heightSpring = new Spring(0, 'emerge');
    this.loop = new SpringLoop(() => this._onSpringFrame());
    this.loop.add(this.heightSpring); // without this the loop has nothing to step

    this.dragging = false;
    this.dragTimer = null;
    this.dragOffset = { x: 0, y: 0 };

    // Last result of _panelLayout(). Cached so the spring frame and the drag
    // tick can place the panel without repeating the display lookup 125x/sec.
    this.panelLay = null;
  }

  // ------------------------------------------------------------- lifecycle
  create() {
    const { workArea } = screen.getPrimaryDisplay();
    const originX = Math.round(workArea.x + (workArea.width - this.pillSize.w) / 2);
    const originY = workArea.y + TOP_MARGIN;

    this.pill = this._makeWindow({
      width: this.pillSize.w,
      height: this.pillSize.h,
      x: originX,
      y: originY,
      file: 'pill/index.html',
      focusable: true
    });

    // Created at its natural height, NOT at minH. A hidden window still runs
    // layout, and the renderer measures itself through a ResizeObserver -- so a
    // 1px-tall window makes every viewport-relative length in the panel collapse
    // and the measurement comes back as a sliver. See --avail-h in panel.css.
    this.panel = this._makeWindow({
      width: this.panelSize.w,
      height: this.panelSize.h,
      x: Math.round(originX + this.pillSize.w / 2 - this.panelSize.w / 2),
      y: originY + this.pillSize.h + GAP,
      file: 'panel/index.html',
      focusable: true,
      show: false
    });

    // applyGlass() treats BOTH windows in one pass, so it runs once -- after both
    // are showable -- rather than once per ready-to-show.
    let showable = 0;
    const glassWhenBothReady = () => { if (++showable === 2) this.applyGlass(this.glassMode); };

    this.pill.once('ready-to-show', () => {
      this.pill.showInactive();
      this._dressWindow(this.pill);
      if (this.stealth) this.applyStealth(true);
      glassWhenBothReady();
    });
    this.panel.once('ready-to-show', () => {
      this._dressWindow(this.panel);
      glassWhenBothReady();
    });

    // Keep the panel glued under the pill whenever the pill moves for any
    // reason (drag, snap, display change).
    this.pill.on('move', () => { if (!this.dragging) this._repositionPanel(); });

    return this;
  }

  _makeWindow({ width, height, x, y, file, focusable, show = true }) {
    const win = new BrowserWindow({
      width, height, x, y,
      show: false,
      frame: false,
      // Kept true on purpose. Electron's backgroundMaterial:'acrylic' is the
      // documented Win11 route but is mutually exclusive with transparency, and
      // losing per-pixel alpha means losing antialiased rounded corners. We get
      // real blur from DWM directly instead (see native/win32.js).
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      roundedCorners: false, // we clip our own region; let DWM stay out of it
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false // an overlay that stalls when unfocused is useless
      }
    });

    // 'screen-saver' level floats above fullscreen apps and above other
    // topmost windows. The old build only did this on darwin and left Windows
    // on a plain setAlwaysOnTop(true), which loses to any fullscreen game or
    // presentation. Windows supports the level fine.
    win.setAlwaysOnTop(true, 'screen-saver', 1);

    // Capture protection is applied in applyStealth(), not here.
    //
    // It used to be a one-shot setContentProtection() at construction, which
    // measurably did NOT stick on the panel: with stealth on, a readback of
    // GetWindowDisplayAffinity showed the pill EXCLUDEFROMCAPTURE and the panel
    // NONE -- so the one window carrying the whole conversation was fully
    // capturable while the app reported itself protected. Applying it on every
    // show, and verifying the result, is the fix.

    win.loadFile(path.join(RENDERER, file));

    /**
     * A dead renderer used to stay dead.
     *
     * Both windows are frameless and never open devtools, so a crashed one is
     * an empty transparent rectangle with no reload button and no tab to close
     * -- the overlay is simply gone until the user kills the process. Seen for
     * real: the GPU/network service died and took pill/index.html with it,
     * leaving the log line and nothing else. Reload instead, and cap the
     * attempts so a renderer that crashes on load does not spin.
     */
    let crashes = 0;
    win.webContents.on('render-process-gone', (_e, d) => {
      console.error('[nimbus] renderer gone:', file, JSON.stringify(d));
      if (d && d.reason === 'clean-exit') return;
      if (win.isDestroyed() || ++crashes > 3) return;
      win.webContents.reload();
    });

    /**
     * Renderer errors are otherwise invisible.
     *
     * Both windows are frameless, always-on-top and never opened with devtools,
     * so a ReferenceError in panel.js kills the rest of a function and leaves no
     * trace anywhere the developer will look -- which is exactly how an
     * undefined call sat in the settings render path unnoticed. Warnings and
     * errors are mirrored to the main process log always; the full firehose only
     * under CUE_DEV.
     */
    win.webContents.on('console-message', (...args) => {
      // Electron changed this signature: it used to be
      // (event, level:number, message, line, sourceId) and is now a single
      // details object. Read whichever shape arrived.
      const d = (args[0] && typeof args[0].message === 'string')
        ? args[0]
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      const level = String(d.level === 2 ? 'warning' : d.level === 3 ? 'error' : (d.level || 'info'));
      if (!process.env.CUE_DEV && level !== 'error' && level !== 'warning') return;
      const where = d.sourceId ? ' ' + path.basename(String(d.sourceId)) + ':' + d.lineNumber : '';
      console.log('[' + file + ' ' + level + where + ']', d.message);
    });
    if (show) win.once('ready-to-show', () => win.showInactive());
    return win;
  }

  /**
   * Apply the native treatment to a window that has just become showable.
   * Every call is individually best-effort.
   *
   * Only the per-window part is done here. Glass is NOT applied per window:
   * applyGlass() owns corner preference, region and backdrop together for both
   * windows at once, so calling it from here ran the whole pass twice -- once
   * per ready-to-show -- and treated each window twice over. create() applies it
   * once, after both windows exist.
   */
  _dressWindow(win) {
    win32.excludeFromAltTab(win);
  }

  // ------------------------------------------------------------- geometry
  /**
   * The ONLY way this class is allowed to move or size a window.
   *
   * Every parameter is stated explicitly from our own state. Nothing is ever
   * spread from getBounds().
   *
   * Why that rule exists: setBounds -> getBounds is not guaranteed to be an
   * identity on Windows. DIP/physical conversion rounds, and a window whose
   * ex-style was changed without SWP_FRAMECHANGED carries stale frame metrics.
   * Either way the readback can come back a pixel off. On its own that is
   * invisible -- but any code doing `setBounds({ ...getBounds(), x, y })` in a
   * loop feeds that error back in as input and it compounds once per iteration.
   *
   * _dragTick runs at 125Hz, so a single drag across the screen applies it
   * several hundred times: the window visibly inflates toward the bottom-right
   * (top-left is pinned by x/y) and the glass grows a little more with every
   * drag. Restating the size each call makes the drift mathematically impossible
   * rather than merely small.
   */
  _place(win, x, y, w, h) {
    if (!win || win.isDestroyed()) return;
    const nx = Math.round(x), ny = Math.round(y);
    const nw = Math.max(1, Math.round(w)), nh = Math.max(1, Math.round(h));

    /**
     * Compared against what we last REQUESTED, not against getBounds().
     *
     * The DIP<->physical round-trip is lossy at non-integer effective scales.
     * Measured on a 250% display: we request 167 DIP, Windows stores
     * 167 * 2.5 = 417.5 -> 418 physical, and getBounds() reports it back as 168.
     * So `getBounds().width === requestedWidth` is permanently false, and a
     * readback-based early-out would never fire -- or worse, readback-based
     * arithmetic would drift a pixel per call.
     *
     * Tracking our own last request makes the comparison exact and makes the
     * window's size a pure function of our state.
     */
    const last = win.__cueBounds;
    if (last && last.x === nx && last.y === ny && last.w === nw && last.h === nh) return;
    win.__cueBounds = { x: nx, y: ny, w: nw, h: nh };
    win.setBounds({ x: nx, y: ny, width: nw, height: nh });
  }

  /**
   * Clip the window to its rounded shape in PHYSICAL pixels.
   *
   * Electron bounds are DIPs; GDI regions are device pixels. On a 150% display
   * a 640 DIP window is 960 px, and clipping to 640 would slice a third of the
   * panel off. This conversion is the single most common way this technique is
   * gotten wrong.
   */
  _applyRegion(win, radius) {
    if (!win || win.isDestroyed()) return;
    // Prefer our own last-requested size over getBounds() for the same
    // lossy-round-trip reason described in _place().
    const last = win.__cueBounds;
    const rb = win.getBounds();
    const b = last ? { x: last.x, y: last.y, width: last.w, height: last.h } : rb;
    // CUE_NO_REGION=1 disables clipping entirely; useful when isolating whether
    // a rendering problem is the region or the content.
    if (process.env.CUE_NO_REGION) return;
    const sf = screen.getDisplayMatching(b).scaleFactor || 1;
    const wPx = Math.round(b.width * sf);
    const hPx = Math.round(b.height * sf);
    const rPx = Math.round(radius * sf);
    win32.setRoundedRegion(win, wPx, hPx, Math.min(rPx, Math.floor(hPx / 2)));
  }

  /**
   * Where the panel may go on the pill's current display, and how tall it may be.
   *
   * Computed in one place and cached, because three callers used to answer this
   * question independently -- _repositionPanel, _onSpringFrame and
   * availableHeight -- and could disagree about width and about which display
   * they were on.
   *
   * Handles the two cases a fixed 640x(below the pill) layout got wrong:
   *
   *   - Narrow displays. 640 DIP does not fit on a 1366x768 laptop at 150%
   *     scaling, which is 910 DIP wide, once edge margins are taken. Width is
   *     clamped to the display instead of assumed.
   *   - A pill dragged low. Below the pill there may be no usable room at all,
   *     and the old code still placed the panel there with no Y clamp, so it
   *     opened off the bottom of the screen. It now flips above the pill.
   *
   * Y is not returned: it depends on the animating height. See _panelY().
   */
  _panelLayout() {
    const p = this.pill.getBounds();
    const wa = screen.getDisplayMatching(p).workArea;

    const w = Math.max(MIN_PANEL_W, Math.min(PANEL.w, wa.width - EDGE_MARGIN * 2));

    const below = (wa.y + wa.height) - (p.y + p.height + GAP) - EDGE_MARGIN;
    const above = (p.y - GAP - EDGE_MARGIN) - wa.y;
    // Flip only when below is genuinely unusable AND above is better, so the
    // panel keeps its habitual position everywhere except the bottom strip.
    const flip = below < MIN_PANEL_H && above > below;

    let x = Math.round(p.x + p.width / 2 - w / 2);
    x = Math.max(wa.x + EDGE_MARGIN, Math.min(x, wa.x + wa.width - w - EDGE_MARGIN));

    this.panelLay = {
      x, w, flip,
      avail: Math.max(PANEL.minH, flip ? above : below),
      pillY: p.y,
      pillH: p.height
    };
    return this.panelLay;
  }

  /** Top edge for a given height. Flipped panels grow upward from the pill. */
  _panelY(lay, h) {
    return lay.flip ? lay.pillY - GAP - h : lay.pillY + lay.pillH + GAP;
  }

  _repositionPanel() {
    if (!this.pill || !this.panel || this.panel.isDestroyed()) return;
    const lay = this._panelLayout();
    // Height is the animated axis, so it is the one value read back -- only to
    // preserve it, never to re-derive width from it. Capped so a panel sized for
    // a tall display cannot hang off a short one.
    const h = Math.min(this.panel.getBounds().height, lay.avail);
    this._place(this.panel, lay.x, this._panelY(lay, h), lay.w, h);
  }

  /**
   * The pill's menu renders below the pill, outside its bounds. The window is
   * clipped to the pill's exact shape, so it has to grow to contain the menu
   * or the menu is simply cut off.
   */
  setMenuOpen(open, rect) {
    this.menuOpen = !!open;
    if (!this.pill || this.pill.isDestroyed()) return;
    const b = this.pill.getBounds();

    if (!open) {
      this._place(this.pill, b.x, b.y, this.pillSize.w, this.pillSize.h);
      if (this._regionMode()) this._applyRegion(this.pill, PILL.radius);
      return;
    }

    const m = this._menuRect(rect);
    const w = Math.max(this.pillSize.w, Math.ceil(m.x + m.w));
    const h = Math.max(this.pillSize.h, Math.ceil(m.y + m.h));
    this._place(this.pill, b.x, b.y, w, h);

    // Clip to pill OR menu, not to the bounding rectangle. Dropping the region
    // here is what produced the shaded box around the menu: the whole enlarged
    // window became visible surface.
    if (!this._regionMode()) return;
    const sf = screen.getDisplayMatching(this.pill.getBounds()).scaleFactor || 1;
    win32.setUnionRegion(this.pill,
      { x: 0, y: 0, w: this.pillSize.w * sf, h: this.pillSize.h * sf, radius: PILL.radius * sf },
      { x: m.x * sf, y: m.y * sf, w: m.w * sf, h: m.h * sf, radius: m.radius * sf }
    );
  }

  /**
   * The menu's rectangle in the pill window's own coordinates.
   *
   * The renderer measures it and sends it along, because it is the only side
   * that knows where its CSS put it. The constants are a fallback for a report
   * that never arrived -- they were the primary source until the stylesheet
   * drifted away from them, at which point the window was clipped to a box
   * wider and taller than the menu and the difference showed as a grey shelf.
   */
  _menuRect(rect) {
    const num = (v) => typeof v === 'number' && isFinite(v);
    if (rect && num(rect.x) && num(rect.y) && num(rect.w) && num(rect.h)
      && rect.w > 0 && rect.h > 0 && rect.w < 2000 && rect.h < 2000) {
      return { x: rect.x, y: rect.y, w: rect.w, h: rect.h, radius: num(rect.radius) ? rect.radius : 12 };
    }
    return {
      x: MENU_INSET, y: this.pillSize.h + MENU_GAP,
      w: MENU_WIDTH, h: MENU_HEIGHT, radius: 12
    };
  }

  setPillSize(w, h) {
    const nw = Math.max(1, Math.round(w));
    const nh = Math.max(1, Math.round(h));
    if (nw === this.pillSize.w && nh === this.pillSize.h) return;
    this.pillSize = { w: nw, h: nh };
    if (!this.pill || this.pill.isDestroyed()) return;
    const b = this.pill.getBounds();
    // Grow from the centre so the pill does not appear to slide sideways.
    const cx = b.x + b.width / 2;
    this._place(this.pill, cx - nw / 2, b.y, nw, nh);
    if (this._regionMode()) this._applyRegion(this.pill, PILL.radius);
    this._repositionPanel();
  }

  /**
   * Exact content height from the panel's ResizeObserver. This is what makes the
   * window never exceed the visible pixels by even one row.
   *
   * The reported WIDTH is deliberately discarded. `#panel` is `width: 100%`, so
   * the width it reports is just the window width echoed back; feeding that into
   * setBounds closes a loop where each frame's rounding error accumulates. It
   * did exactly that in practice, drifting 640 -> 641 -> 658 over a few seconds.
   *
   * Exactly one axis per window may be content-driven. For the panel that is
   * height; width is fixed. (The pill is the mirror image: its width is
   * `max-content`, which does not depend on the viewport, and its height is
   * fixed in CSS -- so neither axis can feed back.)
   */
  setPanelSize(_reportedWidth, h) {
    const nh = Math.max(1, Math.round(h));
    if (nh === this.panelSize.h) return;
    this.panelSize = { w: PANEL.w, h: nh };

    if (!this.panelOpen) return;
    // Retarget mid-flight; the spring keeps its velocity so a resize that
    // lands during the open animation blends instead of restarting. Capped to
    // the display so tall content cannot push the window off-screen.
    const lay = this.panelLay || this._panelLayout();
    this.heightSpring.setPreset('resize').setTarget(Math.min(nh, lay.avail));
    this.loop.kick();
  }

  // ------------------------------------------------------------- panel open/close
  openPanel({ focus = false } = {}) {
    if (!this.panel || this.panel.isDestroyed()) return;
    if (this.panelOpen) { if (focus) this.panel.focus(); return; }
    this.panelOpen = true;

    // Open collapsed at the layout's position, then spring to the content height
    // the renderer asked for -- capped to what the display actually offers.
    const lay = this._panelLayout();
    this._place(this.panel, lay.x, this._panelY(lay, PANEL.minH), lay.w, PANEL.minH);
    this.heightSpring.snapTo(PANEL.minH);
    this.heightSpring.setPreset('emerge').setTarget(Math.min(this.panelSize.h, lay.avail));

    // Region is cleared for the duration of the animation and reinstated on
    // settle. Reapplying a GDI region every frame is ~120 syscalls/sec and any
    // SetWindowRgn that fails mid-flight leaks the HRGN. The window is only
    // un-clipped for ~300ms while it is visibly animating.
    win32.clearRegion(this.panel);

    if (focus) this.panel.show(); else this.panel.showInactive();
    // Re-assert protection on every show. Affinity set before a window has ever
    // been shown does not reliably persist, which is exactly how the panel
    // ended up capturable while the pill was not.
    if (this.stealth) win32.setCaptureProtection(this.panel, true);
    this.loop.kick();
    this.onEvent('panel:state', { open: true });
  }

  /**
   * Immediate. No exit animation by design.
   *
   * An animated collapse means the window keeps eating clicks in a region that
   * already looks empty for the duration of the tween. That is exactly the
   * complaint this rewrite exists to fix, so hide() fires first and the OS drops
   * the window out of hit-testing on the same tick.
   */
  closePanel() {
    if (!this.panel || this.panel.isDestroyed()) return;
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.loop.stop();
    this.panel.hide();
    this.heightSpring.snapTo(PANEL.minH);
    this.onEvent('panel:state', { open: false });
  }

  togglePanel(opts) {
    if (this.panelOpen) this.closePanel(); else this.openPanel(opts);
    return this.panelOpen;
  }

  _onSpringFrame() {
    if (!this.panel || this.panel.isDestroyed() || !this.panelOpen) return false;
    // Cached layout, not a fresh one: this runs every frame, and the pill cannot
    // move mid-animation without _repositionPanel refreshing the cache anyway.
    const lay = this.panelLay || this._panelLayout();
    const h = Math.max(PANEL.minH, Math.round(this.heightSpring.value));
    this._place(this.panel, lay.x, this._panelY(lay, h), lay.w, h);
    if (this.heightSpring.atRest && this._regionMode()) this._applyRegion(this.panel, PANEL.radius);
    return true;
  }

  /** True when we, not DWM, own the window shape. */
  _regionMode() { return this.glassMode === 'shaped' || this.glassMode === 'off'; }

  // ------------------------------------------------------------- drag
  /**
   * Drag is polled from the main process rather than driven by renderer
   * mousemove IPC. Two reasons:
   *
   *   - One IPC message per mouse move at 1000Hz on a gaming mouse will saturate
   *     the channel and the window visibly lags the cursor.
   *   - Both windows have to move on the SAME frame or they visibly separate.
   *     Polling the cursor here lets us set both in one tick.
   *
   * We also drop acrylic to plain blur for the duration: DWM re-samples the
   * acrylic backdrop every frame a window moves, and the well-known result is
   * rubber-banding. Real Windows glass apps do this same swap.
   */
  startDrag() {
    if (this.dragging || !this.pill || this.pill.isDestroyed()) return;
    this.dragging = true;

    const cursor = screen.getCursorScreenPoint();
    const b = this.pill.getBounds();
    this.dragOffset = { x: cursor.x - b.x, y: cursor.y - b.y };

    win32.enterDragMode(this.pill, TINT_PILL);
    if (this.panelOpen) win32.enterDragMode(this.panel, TINT_PANEL);

    this.dragTimer = setInterval(() => this._dragTick(), 8);
  }

  _dragTick() {
    if (!this.dragging || !this.pill || this.pill.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();

    // Size comes from our own state, never from getBounds(). This runs 125x a
    // second; reading the size back and re-applying it is what made the window
    // creep outward on every drag.
    const w = this.pillSize.w;
    const h = this.pillSize.h;

    let x = c.x - this.dragOffset.x;
    let y = c.y - this.dragOffset.y;

    // Clamp to the work area of whichever display the cursor is over, so the
    // pill cannot be dragged behind the taskbar or off-screen entirely.
    const wa = screen.getDisplayNearestPoint(c).workArea;
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));

    // No getBounds() here. _place() already early-outs against its own last
    // request, and that comparison is the exact one -- getBounds() round-trips
    // through physical pixels and disagrees at fractional scale factors. This
    // runs 125x/sec, so the saved syscall is worth more than the duplicate test.
    const moved = this.pill.__cueBounds;
    if (moved && moved.x === Math.round(x) && moved.y === Math.round(y)) return;
    this._place(this.pill, x, y, w, h);
    // Only when the panel is actually on screen. Repositioning a hidden window
    // every 8ms costs two getBounds and a display lookup for nothing, and the
    // panel is re-laid-out on open regardless.
    if (this.panelOpen) this._repositionPanel();
  }

  endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragTimer) { clearInterval(this.dragTimer); this.dragTimer = null; }

    // Restore whichever mode the user actually chose, not unconditionally acrylic.
    this.applyGlass(this.glassMode);

    if (this._regionMode()) {
      this._applyRegion(this.pill, PILL.radius);
      if (this.panelOpen) this._applyRegion(this.panel, PANEL.radius);
    }
    this._repositionPanel();

    const b = this.pill.getBounds();
    this.onEvent('pill:moved', { x: b.x, y: b.y });
  }

  // ------------------------------------------------------------- misc
  /**
   * Apply a glass mode to both windows immediately.
   *
   * Live-swappable because the accent policy is just a syscall against a live
   * HWND -- nothing has to be rebuilt.
   *
   * ---------------------------------------------------------------------------
   * THE CONSTRAINT, measured on Win11 26200:
   *
   * SetWindowCompositionAttribute paints its backdrop across the ENTIRE window
   * rectangle, and SetWindowRgn does NOT clip it. The region clips the window's
   * own content (verified: with the accent disabled the pill and panel render as
   * exact rounded shapes), but DWM's backdrop layer ignores it completely. The
   * visible result was a square glass slab sitting behind a rounded pill.
   *
   * There is no API that gives an arbitrary rounded backdrop on a layered
   * window: DWMWA_SYSTEMBACKDROP_TYPE needs a non-layered window (the same
   * conflict that rules out Electron's backgroundMaterial), and
   * DwmEnableBlurBehindWindow's hRgnBlur stopped blurring after Win7.
   *
   * So the shape and a real desktop blur cannot both be had, and the modes are
   * an honest either/or:
   *
   *   'shaped'  -> exact pill / rounded panel via region, CSS glass only.
   *                No desktop blur. No square. This is the default because the
   *                silhouette is the whole look.
   *   'acrylic' -> real DWM acrylic, corners handed to DWM (~8px, not a pill).
   *   'blur'    -> as acrylic but the cheaper gaussian.
   *   'off'     -> shaped, backdrop fully disabled.
   * ---------------------------------------------------------------------------
   */
  applyGlass(mode) {
    this.glassMode = mode;
    const pairs = [[this.pill, TINT_PILL, PILL.radius], [this.panel, TINT_PANEL, PANEL.radius]];
    for (const [win, tint, radius] of pairs) {
      if (!win || win.isDestroyed()) continue;

      if (mode === 'shaped') {
        // Exact shape, no DWM backdrop. See the note above applyGlass().
        win32.disableBlur(win);
        win32.setCornerPreference(win, false);
        this._applyRegion(win, radius);
      } else if (mode === 'off') {
        win32.disableBlur(win);
        win32.setCornerPreference(win, false);
        this._applyRegion(win, radius);
      } else {
        // Real DWM blur. The accent covers the whole window rect regardless of
        // our region, so hand the corners to DWM instead and drop our clip --
        // keeping a rounded region here would clip the CONTENT round while the
        // backdrop stayed square, which is the worst of both.
        win32.clearRegion(win);
        win32.setCornerPreference(win, true);
        if (mode === 'blur') win32.enterDragMode(win, tint);
        else win32.enableAcrylic(win, tint);
      }
    }
    this.broadcastGlass();
    return true;
  }

  /** Tell both renderers which mode is active so CSS can match the geometry. */
  broadcastGlass() {
    this.broadcast('glass:changed', {
      mode: this.glassMode,
      // In a DWM-backdrop mode the frame is rounded by DWM at a fixed ~8px, so
      // the CSS radius must match or the two shapes visibly disagree.
      systemCorners: this.glassMode === 'acrylic' || this.glassMode === 'blur'
    });
  }

  /**
   * Apply capture protection to every window and report the VERIFIED state.
   *
   * Two things this does that a single setContentProtection() call did not:
   *   - covers both windows, every time, including after the panel is re-shown
   *   - reads the affinity back, so "hidden from capture" is something the OS
   *     confirmed rather than something we requested and hoped for
   */
  applyStealth(on) {
    this.stealth = !!on;
    const results = {};
    for (const [name, win] of [['pill', this.pill], ['panel', this.panel]]) {
      if (!win || win.isDestroyed()) continue;
      results[name] = win32.setCaptureProtection(win, this.stealth);
    }
    this.onEvent('stealth:state', { enabled: this.stealth, windows: results });
    return results;
  }

  /** Verified current state, straight from the OS. */
  stealthStatus() {
    const out = { enabled: this.stealth, windows: {} };
    for (const [name, win] of [['pill', this.pill], ['panel', this.panel]]) {
      if (!win || win.isDestroyed()) continue;
      out.windows[name] = win32.getCaptureProtection(win);
    }
    // Only true when EVERY window is confirmed excluded. Any window that is not
    // is a hole, and a partial result must not read as success.
    out.verified = Object.values(out.windows).length > 0
      && Object.values(out.windows).every((w) => w.mode === 'excluded');
    return out;
  }

  /** Re-clip both windows. Call after any DPI or resolution change. */
  refreshRegions() {
    if (!this._regionMode()) return;
    if (this.pill && !this.pill.isDestroyed()) this._applyRegion(this.pill, PILL.radius);
    if (this.panelOpen && this.panel && !this.panel.isDestroyed()) this._applyRegion(this.panel, PANEL.radius);
  }

  /**
   * Height in DIPs the panel may actually occupy, on whichever display the pill
   * is on and in whichever direction it will open.
   *
   * The panel needs this because it cannot use `vh`: its own window height is
   * what the panel is trying to compute, so a vh-based cap is circular and
   * collapses to near-zero while the window is small.
   *
   * This is the space available at the panel's position, not the whole work
   * area. The two differ by the pill and the gap in the normal case, and by a
   * lot once the pill sits low -- which is exactly when a whole-work-area answer
   * told the renderer to lay out content that could not be shown.
   */
  availableHeight() {
    if (!this.pill || this.pill.isDestroyed()) return screen.getPrimaryDisplay().workArea.height;
    return this._panelLayout().avail;
  }

  broadcast(channel, data) {
    for (const w of [this.pill, this.panel]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, data);
    }
  }

  sendToPanel(channel, data) {
    if (this.panel && !this.panel.isDestroyed()) this.panel.webContents.send(channel, data);
  }

  /**
   * Put the pill back on the top edge, horizontally centred.
   *
   * Centred from the CURRENT measured width, which is the part the old launch
   * path got wrong: create() has to place the window before the renderer
   * exists, so it centres the 232 DIP seed. Once the real width is known the
   * midpoint has moved, and while setPillSize() preserves the centre it cannot
   * recover a centre that was never right -- a restored drag position, or a
   * display that changed size underneath it.
   *
   * Uses the primary display's work area. "Top centre" means the screen the
   * user thinks of as theirs, not whichever one the pill happened to end up on.
   */
  centerPill() {
    if (!this.pill || this.pill.isDestroyed()) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const w = this.pillSize.w;
    const h = this.pillSize.h;
    const x = Math.round(wa.x + (wa.width - w) / 2);
    this._place(this.pill, x, wa.y + TOP_MARGIN, w, h);
    this._repositionPanel();
  }

  destroy() {
    this.loop.stop();
    if (this.dragTimer) clearInterval(this.dragTimer);
    for (const w of [this.pill, this.panel]) {
      if (w && !w.isDestroyed()) w.destroy();
    }
  }
}

module.exports = { WindowManager, PILL, PANEL, GAP };
