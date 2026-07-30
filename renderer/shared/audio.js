/**
 * Audio capture.
 *
 * Two independent channels:
 *   'you'  — the microphone, via getUserMedia.
 *   'them' — system/loopback audio, via getDisplayMedia. On Windows the main
 *            process answers the display-media request with audio:'loopback',
 *            which captures whatever is playing (a call, a video, a stream)
 *            without a virtual audio device. This is the one place Windows is
 *            genuinely easier than macOS, where loopback needs a kernel
 *            extension or a third-party driver.
 *
 * Each channel gets its own AudioContext and its own VAD worklet instance, so
 * you talking does not truncate their sentence and vice versa.
 *
 * ### The mic is not symmetric with system audio
 *
 * 'them' is the ambient channel: if the user turned listening on, they want what
 * is playing transcribed. 'you' is not. Under `micMode: 'ptt'` the mic device is
 * opened but its worklet gate stays CLOSED, and audio is discarded on the audio
 * thread until the user holds the talk key.
 *
 * The device is held open rather than opened per press on purpose: getUserMedia
 * takes 150-400ms to hand back a live track on a cold device, and a hold-to-talk
 * button that eats the first word of every sentence is not usable. The cost is
 * that Windows shows its microphone-in-use indicator for the whole session,
 * which is the honest signal -- the device really is open -- and `micMode:'off'`
 * is there for anyone who wants it dark.
 */
(function () {
  'use strict';

  const SAMPLE_RATE = 16000;

  const errText = (err) => (err && err.message) || String(err);

  function createChannel(name) {
    return { name, stream: null, ctx: null, src: null, node: null, sink: null };
  }

  async function attach(ch, stream, cfg, handlers, extraOptions) {
    ch.stream = stream;
    // Resampling to 16k here means the worklet, the WAV wrapper and every STT
    // backend all agree on rate without a resample step later.
    ch.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await ch.ctx.audioWorklet.addModule('../vad-processor.js');

    ch.src = ch.ctx.createMediaStreamSource(stream);
    ch.node = new AudioWorkletNode(ch.ctx, 'vad-processor', {
      processorOptions: Object.assign({
        channel: ch.name,
        vadThreshold: cfg.vadThreshold,
        silenceHangoverMs: cfg.silenceHangoverMs,
        minUtteranceMs: cfg.minUtteranceMs,
        maxUtteranceMs: cfg.maxUtteranceMs,
        preRollMs: cfg.preRollMs
      }, extraOptions || {})
    });

    ch.node.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'utterance') handlers.onUtterance(d.channel, d.buffer, d.durationMs);
      else if (d.type === 'level') handlers.onLevel(d.channel, d.rms, d.speaking, d.floor);
      else if (d.type === 'speech-start') handlers.onSpeech(d.channel, true);
      else if (d.type === 'speech-end') handlers.onSpeech(d.channel, false, d.reason);
      else if (d.type === 'gate' && handlers.onGate) handlers.onGate(d.channel, d.open);
    };

    // A worklet only runs while it is connected to a destination. Route it
    // through a muted gain so it processes without producing output.
    ch.sink = ch.ctx.createGain();
    ch.sink.gain.value = 0;
    ch.src.connect(ch.node);
    ch.node.connect(ch.sink);
    ch.sink.connect(ch.ctx.destination);
  }

  function detach(ch) {
    try {
      if (ch.node) { ch.node.port.onmessage = null; ch.node.disconnect(); }
      if (ch.src) ch.src.disconnect();
      if (ch.sink) ch.sink.disconnect();
      if (ch.ctx && ch.ctx.state !== 'closed') ch.ctx.close();
      if (ch.stream) ch.stream.getTracks().forEach((t) => t.stop());
    } catch { /* teardown is best-effort */ }
    ch.stream = ch.ctx = ch.src = ch.node = ch.sink = null;
  }

  const micModeOf = (cfg) => (cfg && cfg.micMode) || 'ptt';
  const micWanted = (cfg) => micModeOf(cfg) !== 'off';
  const micOpenAtRest = (cfg) => micModeOf(cfg) === 'always';
  const systemWanted = (cfg) => !cfg || cfg.captureSystem !== false;

  function createCapture(handlers) {
    const mic = createChannel('you');
    const sys = createChannel('them');
    let running = false;
    let micOpen = false;
    let cfg = {};

    async function openMic() {
      if (mic.stream) return;
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });
      await attach(mic, s, cfg, handlers, { open: micOpen });
    }

    async function openSystem() {
      if (sys.stream) return;
      // Must be called from a fresh user gesture. The pill's listen button
      // calls start() synchronously from its click handler.
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      s.getVideoTracks().forEach((t) => t.stop()); // audio only
      const tracks = s.getAudioTracks();
      if (!tracks.length) {
        s.getTracks().forEach((t) => t.stop());
        throw new Error('no loopback track was returned.');
      }
      await attach(sys, new MediaStream(tracks), cfg, handlers);
      sys.stream = s; // keep the original so stop() releases everything
    }

    function setMicOpen(open) {
      const want = !!open && !!mic.stream;
      if (want === micOpen) return micOpen;
      micOpen = want;
      if (mic.node) {
        try {
          // flush: the utterance in the buffer at the moment of release is the
          // one the user held the key to say.
          mic.node.port.postMessage({ type: 'gate', open: micOpen, flush: true });
        } catch { /* noop */ }
      }
      return micOpen;
    }

    return {
      get running() { return running; },
      get micActive() { return !!mic.stream; },
      get micOpen() { return micOpen; },
      get systemActive() { return !!sys.stream; },

      async start(nextCfg) {
        if (running) return { mic: !!mic.stream, system: !!sys.stream, errors: [] };
        running = true;
        cfg = nextCfg || {};
        micOpen = micOpenAtRest(cfg);

        const result = { mic: false, system: false, errors: [] };

        if (micWanted(cfg)) {
          try { await openMic(); result.mic = true; }
          catch (err) { result.errors.push('Microphone: ' + errText(err)); }
        }

        if (systemWanted(cfg)) {
          try { await openSystem(); result.system = true; }
          catch (err) { result.errors.push('System audio: ' + errText(err)); }
        }

        if (!result.mic && !result.system) { running = false; micOpen = false; }
        return result;
      },

      stop() {
        running = false;
        micOpen = false;
        detach(mic);
        detach(sys);
      },

      setMicOpen,

      /**
       * Reconcile live channels against changed settings, without making the
       * user stop and restart listening for every toggle.
       *
       * `needsGesture` is returned rather than acted on: getDisplayMedia must be
       * called from a user gesture, and a settings-changed event is not one. The
       * caller decides whether to prompt.
       */
      async applySources(nextCfg) {
        cfg = nextCfg || {};
        const out = { needsGesture: false, errors: [] };
        if (!running) return out;

        if (!micWanted(cfg)) {
          detach(mic);
          micOpen = false;
        } else {
          if (!mic.stream) {
            try { await openMic(); }
            catch (err) { out.errors.push('Microphone: ' + errText(err)); }
          }
          // Switching to push-to-talk closes the gate immediately; switching to
          // always-on opens it. Neither waits for the next key press.
          setMicOpen(micOpenAtRest(cfg));
        }

        if (!systemWanted(cfg)) detach(sys);
        else if (!sys.stream) out.needsGesture = true;

        return out;
      },

      /** Force any in-progress utterance out immediately. */
      flush() {
        for (const ch of [mic, sys]) {
          if (ch.node) { try { ch.node.port.postMessage({ type: 'flush' }); } catch { /* noop */ } }
        }
      },

      configure(patch) {
        cfg = Object.assign({}, cfg, patch || {});
        for (const ch of [mic, sys]) {
          if (ch.node) {
            try { ch.node.port.postMessage(Object.assign({ type: 'config' }, patch)); } catch { /* noop */ }
          }
        }
      }
    };
  }

  window.NimbusAudio = { createCapture, SAMPLE_RATE };
})();
