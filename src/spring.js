'use strict';
/**
 * Damped harmonic oscillator.
 *
 * CSS cubic-bezier cannot express a spring: it is a fixed-duration curve, so an
 * interruption mid-flight either snaps or restarts. A spring carries velocity
 * across retargets, which is why iOS motion feels continuous when you interrupt
 * it. Since the *window bounds* are what we are animating (not a DOM node), this
 * has to be integrated in the main process anyway.
 *
 * Integrated with semi-implicit Euler at a fixed 1/240s substep. Fixed substeps
 * matter: a variable dt makes stiff springs blow up when a frame is dropped, and
 * dropped frames are guaranteed the first time the LLM stream saturates the IPC
 * channel.
 */

const SUBSTEP = 1 / 240;
const MAX_CATCHUP = 0.25; // clamp: never simulate more than 250ms after a stall

/**
 * Tuning notes, since these numbers are not arbitrary.
 *
 * For stiffness k, damping c, mass m:
 *   undamped freq  w0 = sqrt(k/m)
 *   damping ratio  z  = c / (2*sqrt(k*m))
 *   decay rate        = z*w0   (the envelope falls as e^(-z*w0*t))
 *   overshoot         = exp(-pi*z / sqrt(1-z^2))   for z < 1
 *
 * emerge:   w0 28.3, z 0.955 -> settles ~325ms over a 516px open.
 * resize:   w0 24.5, z 0.94 -> ~308ms. Content resizing under the cursor should
 *           not bounce; that reads as instability, not polish.
 * collapse: w0 37.4, z 0.91, ~217ms. Nothing should linger.
 *
 * None of the three overshoots by as much as the 0.5px rest threshold below, so
 * none of them overshoots by anything the screen can show. That is deliberate
 * and it is the same rule the stylesheets follow: nothing in this app bounces.
 * `emerge` used to, at z 0.776 and 7.8px of overshoot on a full-height open —
 * that was its "pops out" character, and it announced itself. Raising both k and
 * z removed the bounce AND cut the settle from 383ms, because overshoot is time
 * spent travelling away from where you are going.
 *
 * Counter-intuitive result worth recording: critically damped (z = 1) is NOT
 * the fastest to settle. Its response carries a (1 + w0*t) polynomial term
 * alongside the exponential, so reaching a tight tolerance takes longer than a
 * slightly underdamped system with the same w0. An earlier z = 1.0 collapse
 * preset measured 325ms; dropping to z = 0.91 and raising w0 cut it to ~190ms
 * while keeping overshoot under 0.2%, which is invisible.
 */
const PRESETS = {
  emerge:   { stiffness: 800,  damping: 54, mass: 1 },
  resize:   { stiffness: 600,  damping: 46, mass: 1 },
  collapse: { stiffness: 1400, damping: 68, mass: 1 }
};

class Spring {
  constructor(value = 0, preset = 'emerge') {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.setPreset(preset);

    // Rest thresholds are in pixels and pixels/second, and they are the single
    // biggest lever on perceived speed. A tight velocity cutoff (0.4 px/s) makes
    // the spring chase an exponential tail for hundreds of milliseconds after
    // all visible motion has stopped, which measures as a 600ms animation that
    // looks like it finished at 300ms.
    //
    // 60 px/s is half a pixel per frame at 120Hz: below the point where another
    // frame could change what is on screen.
    this.restDisplacement = 0.5;
    this.restVelocity = 60;
  }

  setPreset(name) {
    const p = PRESETS[name] || PRESETS.emerge;
    this.stiffness = p.stiffness;
    this.damping = p.damping;
    this.mass = p.mass;
    return this;
  }

  /** Retarget without losing velocity. This is the whole point of a spring. */
  setTarget(v) {
    this.target = v;
    return this;
  }

  /** Teleport. Kills velocity. Use for initial placement, not for animation. */
  snapTo(v) {
    this.value = v;
    this.target = v;
    this.velocity = 0;
    return this;
  }

  get atRest() {
    return Math.abs(this.target - this.value) < this.restDisplacement
      && Math.abs(this.velocity) < this.restVelocity;
  }

  /** Advance by `dt` seconds. Returns the new value. */
  step(dt) {
    let remaining = Math.min(dt, MAX_CATCHUP);
    while (remaining > 0) {
      const h = Math.min(SUBSTEP, remaining);
      const displacement = this.value - this.target;
      const springForce = -this.stiffness * displacement;
      const dampingForce = -this.damping * this.velocity;
      const accel = (springForce + dampingForce) / this.mass;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    if (this.atRest) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }
}

/**
 * Drives a set of springs off a single timer and calls back each frame.
 * One timer for the whole app rather than one per animated property.
 */
class SpringLoop {
  constructor(onFrame, hz = 120) {
    this.springs = [];
    this.onFrame = onFrame;
    this.interval = 1000 / hz;
    this.timer = null;
    this.last = 0;
  }

  add(spring) { this.springs.push(spring); return spring; }

  /**
   * NOTE the `length` guard. Array.prototype.every() returns TRUE for an empty
   * array, so a loop with no registered springs reported itself as already
   * settled and stopped on its very first tick. That silently disabled the
   * panel's open animation: the window was set to its start height and never
   * advanced, so it sat at the OS minimum window height forever.
   *
   * Vacuous truth is a genuinely easy way to write a no-op animation loop.
   */
  get settled() { return this.springs.length > 0 && this.springs.every((s) => s.atRest); }

  kick() {
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - this.last) / 1000;
      this.last = now;
      for (const s of this.springs) s.step(dt);
      let keepGoing = true;
      try { keepGoing = this.onFrame(this.settled) !== false; } catch { /* never let a frame kill the loop */ }
      if (this.settled || !keepGoing) this.stop();
    }, this.interval);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = { Spring, SpringLoop, PRESETS };
