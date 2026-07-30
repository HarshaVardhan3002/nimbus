'use strict';
/**
 * Win32 native layer.
 *
 * Everything here is best-effort. If koffi fails to load, or a syscall is
 * missing on this Windows build, every export degrades to a no-op and the app
 * still runs on the CSS-only glass fallback. Nothing in this file may throw.
 *
 * Why this exists at all:
 *   `backdrop-filter: blur()` inside a TRANSPARENT Electron window does not blur
 *   the desktop. It only blurs DOM content composited in the same layer tree,
 *   and behind an overlay panel there is none. So the old build's "liquid glass"
 *   was a flat rgba() rectangle. Real blur has to come from DWM.
 *
 *   Electron's own `backgroundMaterial: 'acrylic'` is the documented route, but
 *   it is mutually exclusive with `transparent: true` (Electron's guidance is to
 *   use an opaque window + #00000000 backgroundColor instead). Going opaque
 *   costs us per-pixel alpha, which costs antialiased rounded corners, which is
 *   the entire look. It also has open bugs around maximize and Win10.
 *
 *   So we keep `transparent: true` and call SetWindowCompositionAttribute
 *   directly. That gives real desktop blur on a per-pixel-alpha window, which is
 *   what every native Windows glass app does.
 */

const os = require('os');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------- constants
const WCA_ACCENT_POLICY = 19;

const ACCENT = {
  DISABLED: 0,
  GRADIENT: 1,
  TRANSPARENT_GRADIENT: 2,
  BLUR_BEHIND: 3,          // cheap gaussian. Used while dragging.
  ACRYLIC_BLUR_BEHIND: 4,  // real acrylic w/ noise + saturation. Expensive.
  HOST_BACKDROP: 5
};

// Draw the accent over all four borders, otherwise DWM leaves hairlines.
const ACCENT_FLAGS_ALL_BORDERS = 0x20 | 0x40 | 0x80 | 0x100;

const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_DONOTROUND = 1;  // we clip our own shape; stop DWM fighting us
const DWMWCP_ROUND = 2;       // DWM's own ~8px rounding, applied to the whole frame

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080; // keeps the overlay out of Alt-Tab

// SetWindowPos flags. SWP_FRAMECHANGED is the important one: MSDN requires it
// after any SetWindowLong that changes window data, or the cached frame metrics
// go stale and subsequent size calculations are inconsistent.
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;

// SetWindowDisplayAffinity modes.
const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;            // captures as a black rectangle
const WDA_EXCLUDEFROMCAPTURE = 0x00000011; // omitted entirely; needs Win10 2004+

// ---------------------------------------------------------------- ffi bootstrap
let koffi = null;
let user32 = null;
let gdi32 = null;
let dwmapi = null;

let SetWindowCompositionAttribute = null;
let ACCENT_POLICY_SIZE = 16; // 4 x DWORD, no padding
let CreateRoundRectRgn = null;
let SetWindowRgn = null;
let DwmSetWindowAttribute = null;
let GetWindowLongPtr = null;
let SetWindowLongPtr = null;
let SetWindowPos = null;
let CombineRgn = null;
let DeleteObject = null;
let CreateRectRgn = null;
let SetWindowDisplayAffinity = null;
let GetWindowDisplayAffinity = null;
let GetAsyncKeyState = null;

let available = false;
let loadError = null;

function isWin10OrLater() {
  // 10.0.x for both Win10 and Win11. Acrylic-behind landed in 1803 (10.0.17134).
  const parts = os.release().split('.').map((n) => parseInt(n, 10));
  if (parts[0] > 10) return true;
  if (parts[0] !== 10) return false;
  return (parts[2] || 0) >= 17134;
}

function init() {
  if (!IS_WIN) { loadError = 'not win32'; return false; }
  if (!isWin10OrLater()) { loadError = 'windows build too old for acrylic (<10.0.17134)'; return false; }

  try {
    koffi = require('koffi');
  } catch (e) {
    loadError = 'koffi unavailable: ' + (e && e.message);
    return false;
  }

  try {
    user32 = koffi.load('user32.dll');
    gdi32 = koffi.load('gdi32.dll');
    dwmapi = koffi.load('dwmapi.dll');

    // struct ACCENT_POLICY { DWORD state, flags, gradientColor /*AABBGGRR*/, animId; }
    const ACCENT_POLICY = koffi.struct('ACCENT_POLICY', {
      AccentState: 'uint32',
      AccentFlags: 'uint32',
      GradientColor: 'uint32',
      AnimationId: 'uint32'
    });

    // struct WINDOWCOMPOSITIONATTRIBDATA { DWORD Attrib; PVOID pvData; SIZE_T cbData; }
    // pvData is typed as a real pointer so koffi marshals + aligns the payload
    // for us instead of us hand-rolling koffi.as() into a void*.
    const WCA_DATA = koffi.struct('WINDOWCOMPOSITIONATTRIBDATA', {
      Attrib: 'uint32',
      pvData: koffi.pointer(ACCENT_POLICY),
      cbData: 'size_t'
    });

    try { ACCENT_POLICY_SIZE = koffi.sizeof(ACCENT_POLICY) || 16; } catch { ACCENT_POLICY_SIZE = 16; }

    // HWND is passed as uintptr_t: getNativeWindowHandle() hands back a Buffer
    // holding the handle VALUE, and passing that Buffer to a void* param would
    // pass a pointer to the buffer, not the handle. So we read it out.
    SetWindowCompositionAttribute = user32.func(
      '__stdcall', 'SetWindowCompositionAttribute', 'bool',
      ['uintptr_t', koffi.pointer(WCA_DATA)]
    );

    CreateRoundRectRgn = gdi32.func(
      '__stdcall', 'CreateRoundRectRgn', 'uintptr_t',
      ['int', 'int', 'int', 'int', 'int', 'int']
    );

    SetWindowRgn = user32.func(
      '__stdcall', 'SetWindowRgn', 'int',
      ['uintptr_t', 'uintptr_t', 'bool']
    );

    // Needed to clip a window to the UNION of two shapes -- see setPillMenuRegion.
    CreateRectRgn = gdi32.func('__stdcall', 'CreateRectRgn', 'uintptr_t', ['int','int','int','int']);
    CombineRgn = gdi32.func('__stdcall', 'CombineRgn', 'int', ['uintptr_t','uintptr_t','uintptr_t','int']);
    DeleteObject = gdi32.func('__stdcall', 'DeleteObject', 'bool', ['uintptr_t']);

    DwmSetWindowAttribute = dwmapi.func(
      '__stdcall', 'DwmSetWindowAttribute', 'int',
      ['uintptr_t', 'uint32', koffi.pointer('uint32'), 'uint32']
    );

    GetWindowLongPtr = user32.func(
      '__stdcall', 'GetWindowLongPtrW', 'int64',
      ['uintptr_t', 'int']
    );

    SetWindowLongPtr = user32.func(
      '__stdcall', 'SetWindowLongPtrW', 'int64',
      ['uintptr_t', 'int', 'int64']
    );

    SetWindowPos = user32.func(
      '__stdcall', 'SetWindowPos', 'bool',
      ['uintptr_t', 'uintptr_t', 'int', 'int', 'int', 'int', 'uint32']
    );

    // Called directly rather than through Electron's setContentProtection so
    // the result can be READ BACK and verified. See setCaptureProtection().
    SetWindowDisplayAffinity = user32.func(
      '__stdcall', 'SetWindowDisplayAffinity', 'bool',
      ['uintptr_t', 'uint32']
    );
    GetWindowDisplayAffinity = user32.func(
      '__stdcall', 'GetWindowDisplayAffinity', 'bool',
      ['uintptr_t', koffi.out(koffi.pointer('uint32'))]
    );

    // Hold-to-talk polls the live state of the bound chord. See src/pushtotalk.js
    // for why this is a poll of specific virtual keys and not a WH_KEYBOARD_LL
    // hook.
    GetAsyncKeyState = user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int']);

    available = true;
    return true;
  } catch (e) {
    loadError = 'ffi bind failed: ' + (e && e.message);
    available = false;
    return false;
  }
}

init();

// ---------------------------------------------------------------- helpers
function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || !buf.length) return null;
    return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  } catch {
    return null;
  }
}

/**
 * Tint is AABBGGRR (note: NOT ARGB, the byte order is reversed).
 * alpha here is the strength of the tint DWM composites over the blur.
 * Too high and you lose the backdrop; too low and text contrast dies.
 */
function packTint({ r = 18, g = 20, b = 27, a = 0x8C } = {}) {
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}

function applyAccent(win, state, tint) {
  if (!available) return false;
  const hwnd = hwndOf(win);
  if (hwnd === null) return false;
  try {
    const policy = {
      AccentState: state,
      AccentFlags: ACCENT_FLAGS_ALL_BORDERS,
      GradientColor: packTint(tint),
      AnimationId: 0
    };
    return !!SetWindowCompositionAttribute(hwnd, {
      Attrib: WCA_ACCENT_POLICY,
      pvData: policy,
      cbData: ACCENT_POLICY_SIZE
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- exports

/**
 * Real desktop blur behind a transparent, per-pixel-alpha window.
 */
function enableAcrylic(win, tint) {
  return applyAccent(win, ACCENT.ACRYLIC_BLUR_BEHIND, tint);
}

/**
 * Acrylic has a well-known drag-latency problem on Windows 10: DWM re-samples
 * the backdrop every frame the window moves, and dragging goes rubber-bandy.
 * Real Windows glass apps swap down to plain BLUR_BEHIND for the duration of
 * the drag and swap back on release. That is what these two are for.
 */
function enterDragMode(win, tint) {
  return applyAccent(win, ACCENT.BLUR_BEHIND, tint);
}
function exitDragMode(win, tint) {
  return applyAccent(win, ACCENT.ACRYLIC_BLUR_BEHIND, tint);
}

function disableBlur(win) {
  return applyAccent(win, ACCENT.DISABLED);
}

/**
 * Clip the window (and therefore its hit-test area) to a rounded rect.
 *
 * This is the thing that makes "the bounding box must not expand a pixel"
 * literally true: a click outside this region is not delivered to us at all,
 * it goes to whatever is underneath. No JS hit-testing, no setIgnoreMouseEvents.
 *
 * Coordinates are PHYSICAL pixels, so callers must pre-multiply by scaleFactor.
 * CreateRoundRectRgn's right/bottom are exclusive, hence the +1.
 *
 * Ownership note: after a successful SetWindowRgn the OS owns the HRGN. We must
 * NOT DeleteObject it, or we free a region the window is still using.
 */
function setRoundedRegion(win, widthPx, heightPx, radiusPx) {
  if (!available) return false;
  const hwnd = hwndOf(win);
  if (hwnd === null) return false;
  const w = Math.max(1, Math.round(widthPx));
  const h = Math.max(1, Math.round(heightPx));
  const d = Math.max(0, Math.round(radiusPx)) * 2;
  try {
    const rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, d, d);
    if (!rgn) return false;
    return SetWindowRgn(hwnd, rgn, true) !== 0;
  } catch {
    return false;
  }
}

/**
 * Clip a window to the union of two rounded rects.
 *
 * The pill's menu paints below the pill, outside its bounds. Growing the window
 * to fit and dropping the region entirely made the whole rectangle visible as a
 * shaded box -- the exact artefact the region exists to prevent. Clipping to
 * pill OR menu keeps both shapes exact and the space between them genuinely
 * outside the window.
 *
 * All coordinates are PHYSICAL pixels.
 */
function setUnionRegion(win, a, b) {
  if (!available) return false;
  const hwnd = hwndOf(win);
  if (hwnd === null) return false;
  const RGN_OR = 2;
  let r1 = 0n, r2 = 0n, dest = 0n;
  try {
    const mk = (r) => CreateRoundRectRgn(
      Math.round(r.x), Math.round(r.y),
      Math.round(r.x + r.w) + 1, Math.round(r.y + r.h) + 1,
      Math.round(r.radius) * 2, Math.round(r.radius) * 2
    );
    r1 = mk(a);
    r2 = mk(b);
    dest = CreateRectRgn(0, 0, 1, 1);
    if (!r1 || !r2 || !dest) throw new Error('region alloc failed');
    CombineRgn(dest, r1, r2, RGN_OR);
    const ok = SetWindowRgn(hwnd, dest, true) !== 0;
    // The window owns `dest` now. The two sources were only inputs to the
    // combine and must be freed or they leak GDI handles on every menu open.
    DeleteObject(r1); DeleteObject(r2);
    return ok;
  } catch {
    try { if (r1) DeleteObject(r1); if (r2) DeleteObject(r2); if (dest) DeleteObject(dest); } catch { /* noop */ }
    return false;
  }
}

function clearRegion(win) {
  if (!available) return false;
  const hwnd = hwndOf(win);
  if (hwnd === null) return false;
  try { return SetWindowRgn(hwnd, 0n, true) !== 0; } catch { return false; }
}

/**
 * Stop DWM applying its own Win11 corner rounding on top of our region.
 */
function setCornerPreference(win, rounded) {
  if (!available) return false;
  const hwnd = hwndOf(win);
  if (hwnd === null) return false;
  try {
    return DwmSetWindowAttribute(
      hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
      [rounded ? DWMWCP_ROUND : DWMWCP_DONOTROUND], 4
    ) === 0;
  } catch {
    return false;
  }
}

function disableSystemCorners(win) { return setCornerPreference(win, false); }

/**
 * Tool windows are excluded from Alt-Tab. An overlay showing up in the task
 * switcher is a tell, and it is also just annoying.
 */
function excludeFromAltTab(win) {
  if (!available) return false;
  const hwnd = hwndOf(win);
  if (hwnd === null) return false;
  try {
    const cur = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, cur | BigInt(WS_EX_TOOLWINDOW));

    // Required. Without SWP_FRAMECHANGED the window keeps its previously cached
    // frame metrics, and Electron's setBounds/getBounds round-trip stops being
    // an identity -- observed as the panel width creeping 640 -> 641 -> 658
    // across successive open/resize cycles.
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0,
      SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture protection, applied AND verified.
 *
 * SetWindowDisplayAffinity is the deepest mechanism a user-mode process has for
 * hiding from screen capture. It is enforced by DWM at composition time, so it
 * covers Windows.Graphics.Capture, DXGI Desktop Duplication, and plain GDI
 * BitBlt alike -- verified here by capturing the desktop with
 * Graphics.CopyFromScreen and finding nothing where a protected window was.
 *
 * Going deeper than this means a display filter driver: EV-signed, WHQL
 * attested, kernel mode, and indistinguishable from anti-cheat or malware. It
 * is not a reasonable dependency for a personal assistant, and it would still
 * not stop a phone pointed at the screen or a capture card.
 *
 * What DOES go wrong in practice is much more boring: the flag not being on the
 * window you thought it was on. Electron's setContentProtection gives no way to
 * confirm, so this returns the verified state instead of assuming success.
 */
function setCaptureProtection(win, on) {
  if (!available) return { ok: false, verified: false, reason: 'native layer unavailable' };
  const hwnd = hwndOf(win);
  if (hwnd === null) return { ok: false, verified: false, reason: 'no window handle' };
  try {
    const want = on ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE;
    const ok = !!SetWindowDisplayAffinity(hwnd, want);
    const got = getCaptureProtection(win);
    return {
      ok,
      // The only claim worth making: the OS says so, not that we asked.
      verified: got.affinity === want,
      affinity: got.affinity,
      mode: got.mode
    };
  } catch (e) {
    return { ok: false, verified: false, reason: (e && e.message) || String(e) };
  }
}

function getCaptureProtection(win) {
  if (!available) return { affinity: null, mode: 'unknown' };
  const hwnd = hwndOf(win);
  if (hwnd === null) return { affinity: null, mode: 'unknown' };
  try {
    const out = [0];
    const ok = !!GetWindowDisplayAffinity(hwnd, out);
    const a = ok ? out[0] : null;
    const mode = a === WDA_EXCLUDEFROMCAPTURE ? 'excluded'
      : a === WDA_MONITOR ? 'black-box'
      : a === WDA_NONE ? 'capturable' : 'unknown';
    return { affinity: a, mode };
  } catch {
    return { affinity: null, mode: 'unknown' };
  }
}

/**
 * Is this virtual key physically down right now?
 *
 * The whole of hold-to-talk rests on this one call. Electron's globalShortcut is
 * press-only -- it has no key-up event -- so "the mic is open while the key is
 * held" cannot be expressed with it at all.
 */
function keyDown(vk) {
  if (!available || !GetAsyncKeyState) return false;
  try {
    /**
     * Bit 15 is "currently down". Bit 0 is "pressed since the last call to this
     * function", which is a ONE-SHOT that clears on read -- polling on bit 0
     * makes a held key read as released on the very next tick, which is the
     * exact failure this feature cannot have.
     */
    return (GetAsyncKeyState(vk) & 0x8000) !== 0;
  } catch {
    return false;
  }
}

function status() {
  return { available, error: loadError, platform: process.platform, release: os.release() };
}

module.exports = {
  ACCENT,
  WDA_NONE, WDA_MONITOR, WDA_EXCLUDEFROMCAPTURE,
  setCaptureProtection, getCaptureProtection,
  setCornerPreference,
  keyDown,
  available: () => available,
  status,
  enableAcrylic,
  enterDragMode,
  exitDragMode,
  disableBlur,
  setRoundedRegion,
  setUnionRegion,
  clearRegion,
  disableSystemCorners,
  excludeFromAltTab
};
