/**
 * Voice-activity-detecting PCM processor.
 *
 * The old pipeline had no VAD at all. It pushed every 128-sample block to the
 * main process, then a setInterval fired every 3500ms, concatenated whatever
 * had accumulated, applied one RMS gate over the whole blob and shipped it to
 * Whisper. Consequences:
 *
 *   - Minimum latency before transcription even STARTED was up to 3.5s, on top
 *     of network + inference. "Answer immediately" is unreachable by design.
 *   - A single gate over a 3.5s window means one loud cough drags a window of
 *     silence through to the API, and one quiet sentence inside a loud window
 *     gets discarded wholesale.
 *   - Utterances were cut at arbitrary wall-clock boundaries, so words were
 *     routinely split across two requests and both halves transcribed wrong.
 *
 * This does frame-level detection with an adaptive noise floor, hysteresis and
 * a hangover, buffers a single utterance, and emits it the moment the speaker
 * actually stops. It also keeps a pre-roll so the first syllable (which is what
 * trips the detector) is not clipped off the front.
 *
 * This is an energy VAD, not a neural one. It is a large improvement over a
 * 3.5s interval but it will still trigger on non-speech transients. The frame
 * interface here is deliberately shaped so a Silero ONNX session can replace
 * _classify() without touching the buffering logic.
 */

const FRAME = 320;          // 20ms @ 16kHz
const LEVEL_EVERY = 3;      // post a UI level roughly every 60ms

class VadProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};

    this.threshold = o.vadThreshold || 0.010;
    this.hangoverFrames = Math.round((o.silenceHangoverMs || 550) / 20);
    this.minFrames = Math.round((o.minUtteranceMs || 320) / 20);
    this.maxFrames = Math.round((o.maxUtteranceMs || 15000) / 20);
    this.preRollFrames = Math.round((o.preRollMs || 300) / 20);
    this.channel = o.channel || 'you';

    /**
     * Gate. When closed, audio reaching this processor is discarded on the audio
     * thread and never becomes an utterance, a level or a pre-roll frame.
     *
     * This is what push-to-talk is enforced by. Gating here rather than in the
     * page means there is no window in which mic audio sits buffered somewhere
     * waiting to be dropped by a later check -- a closed gate is a frame that
     * was thrown away the moment it arrived.
     */
    this.open = o.open !== false;

    this.acc = new Float32Array(FRAME);
    this.accLen = 0;

    this.speaking = false;
    this.silenceRun = 0;
    this.voicedFrames = 0;
    this.totalFrames = 0;

    this.utterance = [];       // Int16Array frames for the current utterance
    this.preRoll = [];         // ring of recent frames while idle

    // Adaptive noise floor. Rises slowly (so speech does not raise it) and
    // falls fast (so it tracks a room going quiet). Without this a fixed
    // threshold either misses quiet speakers or triggers on fan noise.
    this.noiseFloor = 0.004;
    this.frameCount = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'config') {
        if (typeof d.vadThreshold === 'number') this.threshold = d.vadThreshold;
        if (typeof d.silenceHangoverMs === 'number') this.hangoverFrames = Math.round(d.silenceHangoverMs / 20);
      } else if (d.type === 'flush') {
        this._endUtterance(true);
      } else if (d.type === 'gate') {
        this._gate(d.open !== false, d.flush !== false);
      }
    };
  }

  /**
   * Open or close the gate.
   *
   * Closing FLUSHES by default, and that is not an optimisation. The user lets
   * go of the talk key when they have finished the sentence, so at the instant
   * the gate closes the buffer holds exactly the words they held the key to say.
   * Dropping it would lose the last utterance of every single turn.
   */
  _gate(open, flush) {
    if (open === this.open) return;
    this.open = open;
    if (!open) {
      if (flush) this._endUtterance(true);
      this._reset();
    }
    this._emit('gate', { open });
  }

  _reset() {
    this.utterance = [];
    this.preRoll = [];
    this.speaking = false;
    this.silenceRun = 0;
    this.voicedFrames = 0;
    this.totalFrames = 0;
  }

  _toInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  _rms(f32) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    return Math.sqrt(sum / f32.length);
  }

  /** Swap point for a neural VAD. Returns true if this frame contains speech. */
  _classify(rms) {
    const enterAt = Math.max(this.threshold, this.noiseFloor * 3.0);
    const exitAt = enterAt * 0.6; // hysteresis stops chattering on the boundary
    return this.speaking ? rms > exitAt : rms > enterAt;
  }

  _emit(type, extra) {
    const msg = { type, channel: this.channel };
    if (extra) for (const k of Object.keys(extra)) msg[k] = extra[k];
    this.port.postMessage(msg);
  }

  _endUtterance(forced) {
    if (!this.utterance.length) { this.speaking = false; return; }

    const enough = this.voicedFrames >= this.minFrames;
    if (!enough && !forced) {
      // Too short to be speech. Almost always a keyboard click or a door.
      this.utterance = [];
      this.speaking = false;
      this.voicedFrames = 0;
      this.totalFrames = 0;
      return;
    }

    let total = 0;
    for (const f of this.utterance) total += f.length;
    const merged = new Int16Array(total);
    let off = 0;
    for (const f of this.utterance) { merged.set(f, off); off += f.length; }

    // Transfer the backing store instead of structured-cloning it. A 15s
    // utterance is 480KB and cloning that on the audio thread causes a glitch.
    this.port.postMessage({
      type: 'utterance',
      channel: this.channel,
      durationMs: Math.round((total / 16000) * 1000),
      buffer: merged.buffer
    }, [merged.buffer]);

    this.utterance = [];
    this.speaking = false;
    this.voicedFrames = 0;
    this.totalFrames = 0;
    this.silenceRun = 0;
  }

  _handleFrame(f32) {
    const rms = this._rms(f32);
    this.frameCount++;

    // Track the noise floor only while not speaking, otherwise speech raises
    // the floor above itself and the detector latches off.
    if (!this.speaking) {
      if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.6 + rms * 0.4;   // fall fast
      else this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;                     // rise slow
    }

    const voiced = this._classify(rms);

    if (this.frameCount % LEVEL_EVERY === 0) {
      this._emit('level', { rms, speaking: this.speaking, floor: this.noiseFloor });
    }

    const pcm = this._toInt16(f32);

    if (!this.speaking) {
      // Keep recent frames so the onset is not clipped when we do trigger.
      this.preRoll.push(pcm);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();

      if (voiced) {
        this.speaking = true;
        this.silenceRun = 0;
        this.voicedFrames = 1;
        this.totalFrames = 0;
        this.utterance = this.preRoll.slice();
        this.preRoll = [];
        this._emit('speech-start');
      }
      return;
    }

    this.utterance.push(pcm);
    this.totalFrames++;
    if (voiced) { this.voicedFrames++; this.silenceRun = 0; }
    else this.silenceRun++;

    // Speaker stopped: ship it now rather than waiting for a clock tick.
    if (this.silenceRun >= this.hangoverFrames) {
      this._emit('speech-end', { reason: 'silence' });
      this._endUtterance(false);
      return;
    }

    // Someone is monologuing. Cut at a sensible bound so we still get partial
    // transcripts instead of nothing for a minute.
    if (this.totalFrames >= this.maxFrames) {
      this._emit('speech-end', { reason: 'maxlen' });
      this._endUtterance(true);
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    // Gate closed: the block is dropped before it is measured, converted or
    // buffered anywhere. accLen is cleared so a half-filled frame from before
    // the close cannot be completed by audio from after the reopen.
    if (!this.open) { this.accLen = 0; return true; }

    let i = 0;
    while (i < ch.length) {
      const need = FRAME - this.accLen;
      const take = Math.min(need, ch.length - i);
      this.acc.set(ch.subarray(i, i + take), this.accLen);
      this.accLen += take;
      i += take;
      if (this.accLen === FRAME) {
        this._handleFrame(this.acc);
        this.accLen = 0;
      }
    }
    return true;
  }
}

registerProcessor('vad-processor', VadProcessor);
