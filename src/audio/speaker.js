'use strict';
/**
 * Speaker verification: "is this the owner speaking?"
 *
 * Pipeline per utterance:
 *   Int16 PCM (16kHz mono, from the VAD)
 *     -> log-Mel filterbank -> CAM++ ONNX -> 512-d embedding
 *     -> L2 normalise -> cosine similarity vs enrolled centroid
 *     -> owner / other / uncertain
 *
 * This is VERIFICATION (one enrolled identity, binary decision), not
 * diarization. It answers "is this the enrolled owner" and does not try to
 * answer "how many people are in the room", because clustering unknown speakers
 * online drifts badly over a long session.
 *
 * ---------------------------------------------------------------------------
 * TWO FRONTENDS, AND WHY
 *
 * CAM++ consumes precomputed 80-dim Kaldi fbank features, not audio. Getting
 * those features subtly wrong does not throw -- it silently moves the input off
 * the manifold the model was trained on and speaker similarity decays toward
 * noise.
 *
 * A hand-written Kaldi-compatible frontend (audio/fbank.js) was measured against
 * sherpa-onnx's kaldi-native-fbank on identical audio and the same model:
 *
 *              same speaker (unseen)   different speaker   margin
 *   own fbank         0.298                  0.270          0.028
 *   sherpa-onnx       0.483                  0.180          0.303
 *
 * A margin of 0.028 is unusable; 0.303 is comfortable. The reimplementation was
 * close enough to run and far too imprecise to trust, which is the worst
 * failure mode available. So sherpa-onnx-node is the primary path and the local
 * frontend survives only as an explicitly-degraded fallback for machines where
 * the native module will not load.
 * ---------------------------------------------------------------------------
 *
 * HONEST LIMITS, so thresholds are not mistaken for guarantees:
 *   - CAM++ reaches roughly 1% EER on clean close-mic VoxCeleb audio. A laptop
 *     mic across a room is a much harder condition.
 *   - Overlapping speech defeats this outright: an embedding computed over two
 *     simultaneous voices belongs to neither of them.
 *   - Short utterances are unreliable. Below MIN_RELIABLE_MS the result is
 *     reported 'uncertain' rather than guessed.
 */

const path = require('path');
const fs = require('fs');
const fbank = require('./fbank');

const EMBED_DIM = 512;

// Utterances shorter than this do not carry enough phonetic variety for a
// stable embedding. Measured convention in the speaker-ID literature is that
// accuracy falls off sharply below ~1.5s.
const MIN_RELIABLE_MS = 1500;
const MIN_FRAMES = 25; // ~250ms; below this the model input is meaningless

/**
 * Default decision threshold on cosine similarity against the enrolled
 * centroid. Conservative on purpose: a false "that was the owner" causes Nimbus to
 * act on a stranger's sentence, which is worse than missing one of yours.
 * Calibrated per-user by enrolment (see calibrate()).
 */
// Set from the measured separation (genuine ~0.48, impostor ~0.18 on 4s
// utterances). Sits nearer the impostor side because a false "that was the
// owner" makes Nimbus act on a stranger's sentence, which is worse than missing
// one of yours.
const DEFAULT_THRESHOLD = 0.35;
const UNCERTAIN_MARGIN = 0.05; // band either side of the threshold

let ort = null;
let session = null;            // fallback: raw onnxruntime + local fbank
let sherpaExtractor = null;    // primary: sherpa-onnx-node
let backend = 'none';          // 'sherpa' | 'onnx-fallback' | 'none'
let loadError = null;
let inputName = 'feats';
let outputName = 'embs';

function modelPath(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  // Unpacked from asar in the packaged build (see package.json asarUnpack).
  const candidates = [
    path.join(__dirname, '..', '..', 'models', 'speaker-campplus.onnx'),
    path.join(process.resourcesPath || '', 'models', 'speaker-campplus.onnx'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'models', 'speaker-campplus.onnx')
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** Load the ONNX session. Idempotent; never throws. */
async function init(customPath) {
  if (backend !== 'none') return { ok: true, backend };

  const p = modelPath(customPath);
  if (!p) {
    loadError = 'speaker model not found (models/speaker-campplus.onnx)';
    return { ok: false, error: loadError };
  }

  // Primary: the reference frontend. Measured 10x better class separation than
  // the local reimplementation -- see the note at the top of this file.
  try {
    const sherpa = require('sherpa-onnx-node');
    sherpaExtractor = new sherpa.SpeakerEmbeddingExtractor({ model: p, numThreads: 2, debug: false });
    backend = 'sherpa';
    return { ok: true, backend, path: p, dim: sherpaExtractor.dim };
  } catch (e) {
    loadError = 'sherpa-onnx-node unavailable: ' + ((e && e.message) || e);
  }

  // Fallback: same model, our own fbank. Runs, but with materially worse
  // separation -- callers should surface `degraded` in the UI.
  try {
    ort = require('onnxruntime-node');
    session = await ort.InferenceSession.create(p, { intraOpNumThreads: 2, graphOptimizationLevel: 'all' });
    inputName = session.inputNames[0] || 'feats';
    outputName = session.outputNames[0] || 'embs';
    backend = 'onnx-fallback';
    return { ok: true, backend, path: p, degraded: true, error: loadError };
  } catch (e) {
    loadError = (e && e.message) || String(e);
    backend = 'none';
    return { ok: false, error: loadError };
  }
}

function available() { return backend !== 'none'; }
function status() {
  return {
    available: backend !== 'none',
    backend,
    // True when running the local frontend, whose measured margin is ~0.03
    // versus ~0.30 for the reference. Worth telling the user about.
    degraded: backend === 'onnx-fallback',
    error: loadError,
    dim: EMBED_DIM,
    minReliableMs: MIN_RELIABLE_MS,
    defaultThreshold: DEFAULT_THRESHOLD
  };
}

function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Both vectors must already be L2-normalised, so this is a plain dot product. */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Int16 PCM -> L2-normalised 512-d embedding, or null if unusable.
 */
async function embed(pcmInt16) {
  if (backend === 'sherpa') {
    try {
      // sherpa wants float samples in [-1, 1].
      const f32 = new Float32Array(pcmInt16.length);
      for (let i = 0; i < pcmInt16.length; i++) f32[i] = pcmInt16[i] / 32768;
      const stream = sherpaExtractor.createStream();
      stream.acceptWaveform({ sampleRate: fbank.SAMPLE_RATE, samples: f32 });
      const v = sherpaExtractor.compute(stream);
      return v ? l2normalize(Float32Array.from(v)) : null;
    } catch (e) {
      loadError = (e && e.message) || String(e);
      return null;
    }
  }

  if (!session) return null;
  const feats = fbank.compute(pcmInt16);
  if (!feats || feats.frames < MIN_FRAMES) return null;
  try {
    const tensor = new ort.Tensor('float32', feats.data, feats.dims);
    const out = await session.run({ [inputName]: tensor });
    const raw = out[outputName];
    if (!raw || !raw.data) return null;
    return l2normalize(raw.data);
  } catch (e) {
    loadError = (e && e.message) || String(e);
    return null;
  }
}

/**
 * Build an enrolment centroid from several samples.
 *
 * Averaging normalised embeddings then renormalising is the standard
 * construction. Several short varied samples beat one long one: a centroid
 * built from a single utterance encodes that sentence's phonetics as much as
 * the speaker's voice.
 */
function centroidOf(embeddings) {
  const usable = (embeddings || []).filter((e) => e && e.length === EMBED_DIM);
  if (!usable.length) return null;
  const acc = new Float32Array(EMBED_DIM);
  for (const e of usable) for (let i = 0; i < EMBED_DIM; i++) acc[i] += e[i];
  for (let i = 0; i < EMBED_DIM; i++) acc[i] /= usable.length;
  return l2normalize(acc);
}

/**
 * Suggest a threshold from the enrolment samples themselves.
 *
 * Each sample is scored against the centroid built from the others
 * (leave-one-out), giving a distribution of genuine same-speaker scores. The
 * threshold sits a couple of standard deviations below that mean, floored so a
 * suspiciously tight enrolment cannot produce an absurdly permissive value.
 */
function calibrate(embeddings) {
  const list = (embeddings || []).filter((e) => e && e.length === EMBED_DIM);
  if (list.length < 2) return { threshold: DEFAULT_THRESHOLD, samples: list.length, mean: null, std: null };

  const scores = [];
  for (let i = 0; i < list.length; i++) {
    const rest = list.filter((_, j) => j !== i);
    const c = centroidOf(rest);
    if (c) scores.push(cosine(list[i], c));
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const varr = scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length;
  const std = Math.sqrt(varr);

  const suggested = Math.max(0.30, Math.min(0.70, mean - 2 * std));
  return { threshold: suggested, samples: list.length, mean, std, scores };
}

/**
 * Score one utterance against the enrolled profile.
 * -> { speaker: 'owner'|'other'|'uncertain', score, reason }
 */
async function identify(pcmInt16, profile, opts = {}) {
  const durationMs = (pcmInt16.length / fbank.SAMPLE_RATE) * 1000;
  if (backend === 'none') return { speaker: 'unknown', score: null, reason: 'model not loaded' };
  if (!profile || !profile.centroid) return { speaker: 'unknown', score: null, reason: 'not enrolled' };

  const emb = await embed(pcmInt16);
  if (!emb) return { speaker: 'uncertain', score: null, reason: 'utterance too short to embed' };

  const centroid = profile.centroid instanceof Float32Array
    ? profile.centroid
    : Float32Array.from(profile.centroid);
  const score = cosine(emb, centroid);
  const threshold = typeof opts.threshold === 'number' ? opts.threshold
    : (typeof profile.threshold === 'number' ? profile.threshold : DEFAULT_THRESHOLD);

  // Too short to trust, even though it embedded. Report the score but refuse
  // to commit to an identity.
  if (durationMs < MIN_RELIABLE_MS) {
    return { speaker: 'uncertain', score, threshold, reason: 'shorter than ' + MIN_RELIABLE_MS + 'ms', durationMs };
  }
  if (Math.abs(score - threshold) < UNCERTAIN_MARGIN) {
    return { speaker: 'uncertain', score, threshold, reason: 'within the uncertain band', durationMs };
  }
  return {
    speaker: score >= threshold ? 'owner' : 'other',
    score, threshold, durationMs,
    reason: null
  };
}

module.exports = {
  init, available, status, embed, identify, backendName: () => backend,
  centroidOf, calibrate, cosine, l2normalize,
  EMBED_DIM, MIN_RELIABLE_MS, DEFAULT_THRESHOLD, UNCERTAIN_MARGIN
};
