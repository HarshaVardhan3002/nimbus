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
 * Lives in the pill window, not the panel: the panel can be hidden or destroyed
 * and capture has to survive that.
 */
(function () {
  'use strict';

  const SAMPLE_RATE = 16000;

  function createChannel(name, opts) {
    return {
      name,
      stream: null,
      ctx: null,
      src: null,
      node: null,
      sink: null,
      opts
    };
  }

  async function attach(ch, stream, cfg, handlers) {
    ch.stream = stream;
    // Resampling to 16k here means the worklet, the WAV wrapper and every STT
    // backend all agree on rate without a resample step later.
    ch.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await ch.ctx.audioWorklet.addModule('../vad-processor.js');

    ch.src = ch.ctx.createMediaStreamSource(stream);
    ch.node = new AudioWorkletNode(ch.ctx, 'vad-processor', {
      processorOptions: {
        channel: ch.name,
        vadThreshold: cfg.vadThreshold,
        silenceHangoverMs: cfg.silenceHangoverMs,
        minUtteranceMs: cfg.minUtteranceMs,
        maxUtteranceMs: cfg.maxUtteranceMs,
        preRollMs: cfg.preRollMs
      }
    });

    ch.node.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'utterance') handlers.onUtterance(d.channel, d.buffer, d.durationMs);
      else if (d.type === 'level') handlers.onLevel(d.channel, d.rms, d.speaking, d.floor);
      else if (d.type === 'speech-start') handlers.onSpeech(d.channel, true);
      else if (d.type === 'speech-end') handlers.onSpeech(d.channel, false, d.reason);
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

  function createCapture(handlers) {
    const mic = createChannel('you');
    const sys = createChannel('them');
    let running = false;

    return {
      get running() { return running; },
      get micActive() { return !!mic.stream; },
      get systemActive() { return !!sys.stream; },

      async start(cfg) {
        if (running) return { mic: !!mic.stream, system: !!sys.stream };
        running = true;
        const result = { mic: false, system: false, errors: [] };

        if (cfg.captureMic !== false) {
          try {
            const s = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
              }
            });
            await attach(mic, s, cfg, handlers);
            result.mic = true;
          } catch (err) {
            result.errors.push('Microphone: ' + ((err && err.message) || err));
          }
        }

        if (cfg.captureSystem !== false) {
          try {
            // Must be called from a fresh user gesture. The pill's listen
            // button calls start() synchronously from its click handler.
            const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            s.getVideoTracks().forEach((t) => t.stop()); // audio only
            const tracks = s.getAudioTracks();
            if (!tracks.length) {
              s.getTracks().forEach((t) => t.stop());
              result.errors.push('System audio: no loopback track was returned.');
            } else {
              await attach(sys, new MediaStream(tracks), cfg, handlers);
              sys.stream = s; // keep the original so stop() releases everything
              result.system = true;
            }
          } catch (err) {
            result.errors.push('System audio: ' + ((err && err.message) || err));
          }
        }

        if (!result.mic && !result.system) running = false;
        return result;
      },

      stop() {
        running = false;
        detach(mic);
        detach(sys);
      },

      /** Force any in-progress utterance out immediately. */
      flush() {
        for (const ch of [mic, sys]) {
          if (ch.node) { try { ch.node.port.postMessage({ type: 'flush' }); } catch { /* noop */ } }
        }
      },

      configure(patch) {
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
