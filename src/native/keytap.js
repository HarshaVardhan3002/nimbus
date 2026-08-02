'use strict';
/**
 * A keyboard tap: how the panel is typed into without ever being activated.
 *
 * The problem this solves is not focus, it is the caret. Activating the overlay
 * sends WM_KILLFOCUS to whatever the user was working in, and that window then
 * hides its caret, closes its completion popup and stops drawing its selection.
 * Windows does not put any of it back. After a few round trips the user no
 * longer knows which line of a long file they were editing -- and the caret is
 * also the thing Nimbus itself wants to see, because "read from the top of this
 * document down to my cursor" only means something while the cursor is on
 * screen.
 *
 * So Nimbus never takes the foreground at all. Instead it reads keystrokes
 * before any window sees them, hands them to a policy function, and swallows
 * the ones the policy claims. Everything else continues to the app underneath
 * untouched. Measured: with the tap up and the panel being typed into,
 * GetGUIThreadInfo still reports a live caret owned by the editor's thread.
 *
 * Rules this file lives by:
 *
 *   - It is installed ONLY while the user is typing into the panel. A global
 *     hook that is up all the time puts a JS function in the path of every
 *     keystroke on the machine, and if it ever runs longer than
 *     LowLevelHooksTimeout Windows drops it with no error anywhere.
 *   - The callback does the least possible work and can never throw. Anything
 *     unexpected passes the key through: a key that reaches nothing is a key
 *     the user has lost, and losing keys is worse than not having the feature.
 *   - Nothing here decides what a key MEANS. That is policy, it depends on what
 *     the panel is doing, and it lives in the window manager.
 */

const IS_WIN = process.platform === 'win32';

const WH_KEYBOARD_LL = 13;
const WH_MOUSE_LL = 14;
const HC_ACTION = 0;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;

/**
 * Button presses, and nothing else.
 *
 * A low-level mouse hook also sees every WM_MOUSEMOVE, which on a gaming mouse
 * is a thousand a second. Those are compared against this set and passed on
 * without ever being decoded, so the cost of a mouse the user is only moving is
 * one integer lookup.
 */
const MOUSE_DOWN = new Set([0x0201, 0x0204, 0x0207, 0x020b]);

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_CAPITAL = 0x14;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

/**
 * Keys with no printable form, named the way webContents.sendInputEvent wants
 * them. Space is deliberately absent: it has a perfectly good printable form
 * and goes down the text path with everything else.
 */
const NAMED = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x1b: 'Escape',
  0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home',
  0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down',
  0x2d: 'Insert', 0x2e: 'Delete'
};
for (let i = 0; i < 12; i++) NAMED[0x70 + i] = 'F' + (i + 1);

/** Modifiers report themselves through ev.mods; they are never text. */
const MODIFIER = new Set([
  VK_SHIFT, VK_CONTROL, VK_MENU, VK_CAPITAL, VK_LWIN, VK_RWIN,
  0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5
]);

let koffi = null;
let user32 = null;
let kernel32 = null;
let available = false;
let loadError = null;

let SetWindowsHookEx = null;
let CallNextHookEx = null;
let UnhookWindowsHookEx = null;
let ToUnicodeEx = null;
let GetKeyboardLayout = null;
let GetKeyState = null;
let GetAsyncKeyState = null;
let GetForegroundWindow = null;
let GetWindowThreadProcessId = null;
let GetModuleHandle = null;
let KBDLLHOOKSTRUCT = null;
let MSLLHOOKSTRUCT = null;
let HookProto = null;
let MouseProto = null;
let SetMouseHook = null;
let CallNextMouseHook = null;

function init() {
  if (!IS_WIN) { loadError = 'not win32'; return false; }
  try {
    koffi = require('koffi');
  } catch (e) {
    loadError = 'koffi unavailable: ' + (e && e.message);
    return false;
  }

  try {
    user32 = koffi.load('user32.dll');
    kernel32 = koffi.load('kernel32.dll');

    KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
      vkCode: 'uint32',
      scanCode: 'uint32',
      flags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t'
    });

    // POINT is two LONGs, so the struct is declared flat rather than nested.
    // Same layout, one less type to keep in step with Windows.
    MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
      x: 'long',
      y: 'long',
      mouseData: 'uint32',
      flags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t'
    });

    // LRESULT CALLBACK LowLevelKeyboardProc(int, WPARAM, LPARAM)
    HookProto = koffi.proto(
      'intptr_t __stdcall NimbusKeyProc(int nCode, uintptr_t wParam, KBDLLHOOKSTRUCT *info)'
    );
    MouseProto = koffi.proto(
      'intptr_t __stdcall NimbusMouseProc(int nCode, uintptr_t wParam, MSLLHOOKSTRUCT *info)'
    );

    SetWindowsHookEx = user32.func('__stdcall', 'SetWindowsHookExW', 'uintptr_t',
      ['int', koffi.pointer(HookProto), 'uintptr_t', 'uint32']);
    CallNextHookEx = user32.func('__stdcall', 'CallNextHookEx', 'intptr_t',
      ['uintptr_t', 'int', 'uintptr_t', koffi.pointer(KBDLLHOOKSTRUCT)]);
    // Same two entry points, declared again with the mouse payload. koffi types
    // the LPARAM, so one binding cannot carry both structs.
    SetMouseHook = user32.func('__stdcall', 'SetWindowsHookExW', 'uintptr_t',
      ['int', koffi.pointer(MouseProto), 'uintptr_t', 'uint32']);
    CallNextMouseHook = user32.func('__stdcall', 'CallNextHookEx', 'intptr_t',
      ['uintptr_t', 'int', 'uintptr_t', koffi.pointer(MSLLHOOKSTRUCT)]);
    UnhookWindowsHookEx = user32.func('__stdcall', 'UnhookWindowsHookEx', 'bool', ['uintptr_t']);

    ToUnicodeEx = user32.func('__stdcall', 'ToUnicodeEx', 'int',
      ['uint32', 'uint32', koffi.pointer('uint8'),
        koffi.out(koffi.pointer('uint16')), 'int', 'uint32', 'uintptr_t']);
    GetKeyboardLayout = user32.func('__stdcall', 'GetKeyboardLayout', 'uintptr_t', ['uint32']);
    GetKeyState = user32.func('__stdcall', 'GetKeyState', 'int16', ['int']);
    GetAsyncKeyState = user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int']);
    GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'uintptr_t', []);
    GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32',
      ['uintptr_t', koffi.out(koffi.pointer('uint32'))]);
    GetModuleHandle = kernel32.func('__stdcall', 'GetModuleHandleW', 'uintptr_t', ['const char16_t *']);

    available = true;
    return true;
  } catch (e) {
    loadError = 'ffi bind failed: ' + (e && e.message);
    available = false;
    return false;
  }
}

init();

let hook = 0;
let callback = null;
let sink = null;
let lastError = null;

/**
 * Caps Lock, tracked rather than asked for.
 *
 * GetKeyboardState reports the state of the CALLING thread's input queue, and
 * the thread that owns a low-level hook never processes key messages, so its
 * queue is empty and every toggle key reads as off. The seed below is a
 * best-effort read at install time; from then on this stays in step because
 * Caps Lock is one of the keys the policy always passes through, so the OS
 * toggles the real state on exactly the events that flip this one.
 */
let capsOn = false;

function isDown(vk) {
  try { return (GetAsyncKeyState(vk) & 0x8000) !== 0; } catch { return false; }
}

function modsNow() {
  return {
    ctrl: isDown(VK_CONTROL),
    shift: isDown(VK_SHIFT),
    alt: isDown(VK_MENU),
    meta: isDown(VK_LWIN) || isDown(VK_RWIN)
  };
}

/** The layout of whatever the user is actually typing in, not ours. */
function activeLayout() {
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return GetKeyboardLayout(0);
    const out = [0];
    const tid = GetWindowThreadProcessId(hwnd, out);
    // Asking about a thread in another process is allowed but can come back
    // zero, and zero is not a layout -- ToUnicodeEx would then translate
    // nothing at all. Our own layout is a far better answer than none.
    return GetKeyboardLayout(tid || 0) || GetKeyboardLayout(0);
  } catch {
    return 0;
  }
}

/**
 * What this key would have typed, on the user's own layout.
 *
 * Hard-coding VK -> ASCII would be wrong for every keyboard that is not US
 * QWERTY, so the OS is asked. Ctrl or Alt on their own mean a command rather
 * than text -- but Ctrl+Alt is how AltGr arrives, and on a great many layouts
 * that is the only way to type @, backslash or a whole accented alphabet, so
 * that combination goes through.
 */
function textFor(vk, scan, mods) {
  if (!ToUnicodeEx) return '';
  if ((mods.ctrl || mods.alt) && !(mods.ctrl && mods.alt)) return '';
  try {
    const state = new Uint8Array(256);
    if (mods.shift) state[VK_SHIFT] = 0x80;
    if (mods.ctrl) state[VK_CONTROL] = 0x80;
    if (mods.alt) state[VK_MENU] = 0x80;
    if (capsOn) state[VK_CAPITAL] = 0x01;

    const buf = [0, 0, 0, 0, 0, 0, 0, 0];
    /**
     * Flag bit 2 is "do not change the keyboard state". Without it, asking what
     * a key would produce actually CONSUMES a pending dead key, so an accent
     * typed while the panel has the keyboard would go missing from the next
     * character the user types anywhere on the machine.
     */
    const n = ToUnicodeEx(vk, scan, state, buf, buf.length, 0x4, activeLayout());
    if (n <= 0) return '';
    let out = '';
    for (let i = 0; i < n && i < buf.length; i++) {
      const c = buf[i];
      // Control codes have named forms already; only real text goes down here.
      if (c >= 0x20 && c !== 0x7f) out += String.fromCharCode(c);
    }
    return out;
  } catch {
    return '';
  }
}

function onKey(nCode, wParam, info) {
  try {
    if (nCode === HC_ACTION && sink) {
      const down = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN;
      /**
       * Decoded explicitly. koffi hands a callback a POINTER, not the struct it
       * points at, so reading info.vkCode straight off the argument yields
       * undefined -- and undefined has no name, no text and is not a modifier,
       * so every key looked like one to swallow and forward as nothing. The tap
       * ate the entire keyboard and delivered none of it.
       */
      const key = koffi.decode(info, KBDLLHOOKSTRUCT);
      const vk = key.vkCode;
      if (down && vk === VK_CAPITAL) capsOn = !capsOn;

      const mods = modsNow();
      const name = NAMED[vk] || null;
      const ev = {
        type: down ? 'down' : 'up',
        vk,
        mods,
        name,
        modifier: MODIFIER.has(vk),
        text: (down && !name && !MODIFIER.has(vk)) ? textFor(vk, key.scanCode, mods) : ''
      };
      const eaten = sink(ev) === true;
      if (process.env.CUE_KEYTAP) {
        console.log('[keytap]', JSON.stringify({ vk: ev.vk, t: ev.type, text: ev.text, name: ev.name, mods: ev.mods, eaten }));
      }
      if (eaten) return 1;
    }
  } catch (e) {
    // Never throw out of a hook procedure. Recorded so status() can say why the
    // panel stopped receiving keys instead of it looking like a dead composer.
    lastError = (e && e.message) || String(e);
  }
  return CallNextHookEx(0, nCode, wParam, info);
}

/**
 * Start tapping the keyboard. `fn` returns true to swallow a key.
 *
 * Returns false if the tap could not be installed, which is a real possibility
 * -- no koffi, a group policy that forbids hooks, or a more privileged process
 * owning the foreground. The caller has to have a fallback for that.
 */
function start(fn) {
  if (!available || typeof fn !== 'function') return false;
  if (hook) { sink = fn; return true; }
  try {
    callback = koffi.register(onKey, koffi.pointer(HookProto));
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, GetModuleHandle(null), 0);
    if (!hook) {
      koffi.unregister(callback);
      callback = null;
      lastError = 'SetWindowsHookEx refused';
      return false;
    }
    sink = fn;
    lastError = null;
    try { capsOn = (GetKeyState(VK_CAPITAL) & 1) !== 0; } catch { capsOn = false; }
    return true;
  } catch (e) {
    lastError = (e && e.message) || String(e);
    stop();
    return false;
  }
}

function stop() {
  sink = null;
  if (hook) {
    try { UnhookWindowsHookEx(hook); } catch { /* the hook dies with the process anyway */ }
    hook = 0;
  }
  if (callback) {
    try { koffi.unregister(callback); } catch { /* nothing left to try */ }
    callback = null;
  }
}

function running() { return !!hook; }

// ---------------------------------------------------------------- the pointer
/**
 * The other half of the tap: noticing that the user has clicked away.
 *
 * With nothing ever activated there is no blur to listen for, and polling
 * cannot stand in for one. GetAsyncKeyState's "pressed since you last asked"
 * bit is a latch that clears on read, and Chromium calls GetAsyncKeyState on
 * this very thread as part of its own input handling, so by the time a poll of
 * ours runs the bit is already gone. Measured, not assumed: every poll during a
 * click read 0,0,0 inside the app while the identical loop in a bare node
 * process saw the click every time.
 *
 * A hook does not have that problem, because it is told rather than asked.
 * Clicks are only ever reported, never swallowed -- the click belongs to
 * whatever is under it.
 */
let mouseHook = 0;
let mouseCallback = null;
let mouseSink = null;

function onMouse(nCode, wParam, info) {
  try {
    if (nCode === HC_ACTION && mouseSink && MOUSE_DOWN.has(wParam)) {
      const m = koffi.decode(info, MSLLHOOKSTRUCT);
      mouseSink({ x: m.x, y: m.y });
    }
  } catch (e) {
    lastError = (e && e.message) || String(e);
  }
  return CallNextMouseHook(0, nCode, wParam, info);
}

/** Start watching for button presses. `fn` gets the screen point, in pixels. */
function startMouse(fn) {
  if (!available || typeof fn !== 'function') return false;
  if (mouseHook) { mouseSink = fn; return true; }
  try {
    mouseCallback = koffi.register(onMouse, koffi.pointer(MouseProto));
    mouseHook = SetMouseHook(WH_MOUSE_LL, mouseCallback, GetModuleHandle(null), 0);
    if (!mouseHook) {
      koffi.unregister(mouseCallback);
      mouseCallback = null;
      lastError = 'SetWindowsHookEx refused (mouse)';
      return false;
    }
    mouseSink = fn;
    return true;
  } catch (e) {
    lastError = (e && e.message) || String(e);
    stopMouse();
    return false;
  }
}

function stopMouse() {
  mouseSink = null;
  if (mouseHook) {
    try { UnhookWindowsHookEx(mouseHook); } catch { /* the hook dies with the process anyway */ }
    mouseHook = 0;
  }
  if (mouseCallback) {
    try { koffi.unregister(mouseCallback); } catch { /* nothing left to try */ }
    mouseCallback = null;
  }
}

function status() {
  return { available, running: !!hook, mouse: !!mouseHook, error: loadError || lastError, capsOn };
}

module.exports = {
  start, stop, running, startMouse, stopMouse,
  status, available: () => available, NAMED
};
