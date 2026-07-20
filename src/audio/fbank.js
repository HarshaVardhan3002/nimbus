'use strict';
/**
 * Kaldi-compatible 80-dimensional log-Mel filterbank.
 *
 * WHY THIS EXISTS
 * The CAM++ speaker-embedding ONNX graph takes `feats` of shape
 * [batch, frames, 80] -- precomputed features, not audio. Probed on the real
 * model: inputs ['feats'], outputs ['embs'], output dims [1, 512].
 *
 * The model was trained on features produced by
 * torchaudio.compliance.kaldi.fbank via wespeaker's pipeline. A frontend that
 * disagrees with that does not throw; it silently produces embeddings from a
 * slightly different feature space, and speaker similarity quietly degrades
 * toward noise. So the conventions below are copied deliberately, not chosen.
 *
 * wespeaker (wespeaker/dataset/processor.py):
 *     waveform = waveform * (1 << 15)          # int16 magnitude, NOT [-1,1]
 *     kaldi.fbank(num_mel_bins=80, frame_length=25, frame_shift=10,
 *                 dither=0, sample_frequency=16000,
 *                 window_type='hamming', use_energy=False)
 *     feat = feat - feat.mean(dim=0)           # CMN over time
 *
 * Kaldi defaults that come along with that: preemphasis 0.97, DC offset
 * removal per frame, FFT size rounded up to a power of two (512 for a 400
 * sample window), mel range 20Hz..Nyquist, natural log with a floor.
 */

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400;   // 25ms
const FRAME_SHIFT = 160;    // 10ms
const N_FFT = 512;          // next power of two >= 400
const NUM_BINS = 80;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2;
const PREEMPH = 0.97;
const EPS = 1.1920928955078125e-07; // float32 epsilon, Kaldi's log floor

// ---------------------------------------------------------------- FFT
/**
 * Iterative radix-2 Cooley-Tukey, in-place, on split real/imag arrays.
 * N_FFT is 512 so the power-of-two constraint always holds.
 */
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  if (1 << levels !== n) throw new Error('FFT size must be a power of two');

  const cosT = new Float64Array(n / 2);
  const sinT = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = Math.sin((2 * Math.PI * i) / n);
  }

  // Bit-reversal permutation table, precomputed once.
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }

  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cosT[k] + im[l] * sinT[k];
          const tim = -re[l] * sinT[k] + im[l] * cosT[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre;        im[j] += tim;
        }
      }
    }
  };
}

const fft = makeFFT(N_FFT);

// ---------------------------------------------------------------- mel bank
const melScale = (f) => 1127.0 * Math.log(1.0 + f / 700.0);

/**
 * Triangular mel filters in the FFT-bin domain, built the way Kaldi does:
 * centres are equally spaced on the mel scale and each filter spans from the
 * previous centre to the next.
 */
function buildMelBanks() {
  const numFftBins = N_FFT / 2;                 // Kaldi drops the Nyquist bin
  const fftBinWidth = SAMPLE_RATE / N_FFT;
  const melLow = melScale(LOW_FREQ);
  const melHigh = melScale(HIGH_FREQ);
  const melDelta = (melHigh - melLow) / (NUM_BINS + 1);

  const banks = [];
  for (let b = 0; b < NUM_BINS; b++) {
    const leftMel = melLow + b * melDelta;
    const centerMel = melLow + (b + 1) * melDelta;
    const rightMel = melLow + (b + 2) * melDelta;

    let first = -1;
    const weights = [];
    for (let i = 0; i < numFftBins; i++) {
      const mel = melScale(fftBinWidth * i);
      if (mel <= leftMel || mel >= rightMel) continue;
      const w = mel <= centerMel
        ? (mel - leftMel) / (centerMel - leftMel)
        : (rightMel - mel) / (rightMel - centerMel);
      if (first < 0) first = i;
      weights.push(w);
    }
    banks.push({ offset: first < 0 ? 0 : first, weights: Float64Array.from(weights) });
  }
  return banks;
}

const MEL_BANKS = buildMelBanks();

// Kaldi's hamming: 0.54 - 0.46*cos(2*pi*n/(N-1)).
const WINDOW = (() => {
  const w = new Float64Array(FRAME_LENGTH);
  for (let i = 0; i < FRAME_LENGTH; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1));
  }
  return w;
})();

// ---------------------------------------------------------------- public
function numFrames(numSamples) {
  if (numSamples < FRAME_LENGTH) return 0;
  return 1 + Math.floor((numSamples - FRAME_LENGTH) / FRAME_SHIFT);
}

/**
 * Int16 mono PCM -> Float32Array of [frames * 80] log-Mel features, CMN applied.
 * Returns { data, frames, dims } or null when the audio is shorter than one frame.
 */
function compute(pcmInt16) {
  const n = pcmInt16.length;
  const frames = numFrames(n);
  if (frames <= 0) return null;

  const out = new Float32Array(frames * NUM_BINS);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const buf = new Float64Array(FRAME_LENGTH);

  for (let f = 0; f < frames; f++) {
    const start = f * FRAME_SHIFT;

    // Samples are used at int16 magnitude, matching wespeaker's *(1<<15).
    // Feeding [-1,1] here shifts every log-energy by a constant ~90dB and
    // moves the features off the manifold the model was trained on.
    for (let i = 0; i < FRAME_LENGTH; i++) buf[i] = pcmInt16[start + i];

    // Remove DC offset (Kaldi: remove_dc_offset=true).
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) mean += buf[i];
    mean /= FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) buf[i] -= mean;

    // Pre-emphasis, applied in reverse so each sample sees the original
    // previous value. Kaldi treats x[-1] as x[0].
    for (let i = FRAME_LENGTH - 1; i > 0; i--) buf[i] -= PREEMPH * buf[i - 1];
    buf[0] -= PREEMPH * buf[0];

    for (let i = 0; i < FRAME_LENGTH; i++) { re[i] = buf[i] * WINDOW[i]; im[i] = 0; }
    for (let i = FRAME_LENGTH; i < N_FFT; i++) { re[i] = 0; im[i] = 0; }

    fft(re, im);

    // Power spectrum over the first N/2 bins.
    const base = f * NUM_BINS;
    for (let b = 0; b < NUM_BINS; b++) {
      const bank = MEL_BANKS[b];
      let energy = 0;
      for (let k = 0; k < bank.weights.length; k++) {
        const idx = bank.offset + k;
        energy += bank.weights[k] * (re[idx] * re[idx] + im[idx] * im[idx]);
      }
      out[base + b] = Math.log(energy > EPS ? energy : EPS);
    }
  }

  // Cepstral mean normalisation over time, per dimension. This is what makes
  // the embedding robust to channel/gain differences between enrolment and
  // live audio -- without it, a different mic reads as a different speaker.
  for (let b = 0; b < NUM_BINS; b++) {
    let m = 0;
    for (let f = 0; f < frames; f++) m += out[f * NUM_BINS + b];
    m /= frames;
    for (let f = 0; f < frames; f++) out[f * NUM_BINS + b] -= m;
  }

  return { data: out, frames, dims: [1, frames, NUM_BINS] };
}

module.exports = {
  compute, numFrames,
  SAMPLE_RATE, FRAME_LENGTH, FRAME_SHIFT, N_FFT, NUM_BINS,
  _internals: { makeFFT, melScale, buildMelBanks, MEL_BANKS, WINDOW }
};
