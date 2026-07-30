'use strict';
/**
 * Hold-to-talk.
 *
 * The microphone is not an ambient input any more. Nimbus's normal listening
 * source is system audio -- the video, call or stream playing on this machine --
 * and the mic opens only while the user is deliberately holding a key. This file
 * is the "is the user holding it" half.
 *
 * ### Why a poll and not a shortcut
 *
 * Electron's `globalShortcut` is press-only: it fires on key-down and has no
 * key-up event at all, so "open the mic while this is held" cannot be expressed
 * with it. On Windows the two ways to get a real hold are:
 *
 *   1. A `WH_KEYBOARD_LL` hook. System-wide, sees every keystroke in every
 *      application, and is indistinguishable from a keylogger to both the user
 *      and their AV product. For a feature whose entire purpose is *reducing*
 *      what the app hears, that is the wrong trade.
 *   2. Polling `GetAsyncKeyState` for the specific virtual keys of one chord.
 *      Reads nothing but the two or three keys the user themselves bound,
 *      installs nothing, and observes no key content.
 *
 * We poll. The app already polls the cursor at 125Hz to drive window drag, so
 * the machinery is not new.
 *
 * ### Degradation
 *
 * With no native layer (koffi missing, non-Windows) there is no key-up to be
 * had, so the chord falls back to a `globalShortcut` LATCH: press to open the
 * mic, press again to close. It reports itself as `'latch'` rather than `'hold'`
 * so the settings screen can say which one the user actually has, instead of
 * showing "hold to talk" over something that does not hold.
 */

const { globalShortcut } = require('electron');
const win32 = require('./native/win32');

/**
 * 24ms is ~1.5 frames at 60Hz. Human key release is not resolvable below about
 * 50ms, so this is already finer than the thing it measures, and the cost is two
 * or three syscalls per tick.
 */
const POLL_MS = 24;

// Modifiers resolve to the "either side" virtual key: a chord bound with the
// left Ctrl should still fire on the right one.
const MOD_VK = {
  control: 0x11, ctrl: 0x11, commandorcontrol: 0x11, cmdorctrl: 0x11,
  alt: 0x12, option: 0x12,
  shift: 0x10,
  super: 0x5b, meta: 0x5b, cmd: 0x5b, command: 0x5b
};

const NAMED_VK = {
  space: 0x20, return: 0x0d, enter: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, pause: 0x13,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
  '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde
};

function vkOfKey(part) {
  const p = part.toLowerCase();
  if (NAMED_VK[p] !== undefined) return NAMED_VK[p];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) return 0x70 + (parseInt(p.slice(1), 10) - 1);
  if (/^[a-z]$/.test(p)) return p.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(p)) return p.charCodeAt(0);
  return null;
}

/**
 * Electron accelerator string -> { mods:[vk], key: vk }.
 *
 * A modifier-only binding is deliberately legal here. Hold-to-talk is one of the
 * few places where "hold right Alt" is a perfectly good binding, and rejecting
 * it would push users onto chords that are harder to hold while typing.
 */
function parseAccel(accel) {
  const parts = String(accel || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  const mods = [];
  let key = null;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (MOD_VK[low] !== undefined) { mods.push(MOD_VK[low]); continue; }
    const vk = vkOfKey(p);
    if (vk === null) return null;
    key = vk;
  }
  if (key === null) {
    if (!mods.length) return null;
    key = mods.pop();          // modifier-only chord: the last one is the trigger
  }
  return { mods: Array.from(new Set(mods)).filter((m) => m !== key), key };
}

class PushToTalk {
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.accel = null;
    this.chord = null;
    this.timer = null;
    this.registered = null;
    this.running = false;
    this.down = false;
    this.native = !!(win32.available() && typeof win32.keyDown === 'function');
  }

  /** 'hold' | 'latch' | 'unbound' — what the user has, not what was asked for. */
  get mode() {
    if (!this.chord) return 'unbound';
    return this.native ? 'hold' : 'latch';
  }

  get held() { return this.down; }

  /** Bind or rebind the chord. Safe to call with an unchanged value. */
  bind(accel) {
    if (accel === this.accel) return this.mode;
    const wasRunning = this.running;
    this.stop();
    this.accel = accel;
    this.chord = parseAccel(accel);
    if (wasRunning) this.start();
    return this.mode;
  }

  start() {
    if (this.running) return this.mode;
    if (!this.chord) return this.mode;
    this.running = true;

    if (this.native) {
      this.timer = setInterval(() => this._tick(), POLL_MS);
      // Never keep the process alive for a key poll.
      if (this.timer.unref) this.timer.unref();
    } else {
      try {
        if (globalShortcut.register(this.accel, () => this._set(!this.down))) {
          this.registered = this.accel;
        }
      } catch {
        this.registered = null;
      }
    }
    return this.mode;
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.registered) {
      try { globalShortcut.unregister(this.registered); } catch { /* best effort */ }
      this.registered = null;
    }
    // A stuck-open mic is the one failure this feature must never have, so the
    // gate is closed on the way out regardless of why we stopped.
    this._set(false);
  }

  _tick() {
    const c = this.chord;
    if (!c) return;
    let on = win32.keyDown(c.key);
    if (on) {
      for (const m of c.mods) {
        if (!win32.keyDown(m)) { on = false; break; }
      }
    }
    this._set(on);
  }

  _set(on) {
    const next = !!on;
    if (next === this.down) return;
    this.down = next;
    this.onChange(next);
  }
}

module.exports = { PushToTalk, parseAccel, POLL_MS };
