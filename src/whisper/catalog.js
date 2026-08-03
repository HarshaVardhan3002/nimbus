'use strict';
/**
 * What can be downloaded: whisper.cpp server builds, and ggml models.
 *
 * Nothing here ships inside Nimbus. The installer probes the machine, the app
 * downloads the matching build on first run, and the whole catalog is plain
 * data so a renamed release asset is a one-line fix.
 *
 * The shape of this file is dictated by what upstream actually publishes,
 * which was checked rather than assumed:
 *
 *   whisper.cpp v1.9.1 Windows assets are CPU, BLAS and CUDA only. There has
 *   never been a Vulkan or ROCm build in a whisper.cpp release -- the last
 *   accelerated non-CUDA asset was CLBlast, dropped after v1.6.0.
 *
 * So Vulkan and ROCm are assembled instead of downloaded whole. Since ggml
 * gained a dynamic backend registry, whisper-server.exe loads any ggml-*.dll
 * sitting beside it and uses the best device it finds; llama.cpp publishes
 * exactly those backend DLLs for Windows. A build is therefore a base archive
 * plus an optional overlay, and "install Vulkan" means: unpack the whisper CPU
 * build, drop llama.cpp's ggml-vulkan.dll next to the server, done.
 *
 * Verified on an AMD Radeon 8060S with whisper v1.9.1 + llama.cpp b10223:
 *   ggml_vulkan: Found 1 Vulkan devices: 0 = AMD Radeon(TM) 8060S Graphics
 *   load_backend: loaded Vulkan backend ... ggml-vulkan.dll
 * and 11 s of speech transcribed in 0.28 s against 0.57 s on CPU alone.
 *
 * Both halves are pinned to the releases that pair was verified against, with
 * the floating /latest/ URL kept as a fallback: an ABI mismatch between a new
 * whisper and an old backend DLL would show up as a backend that silently
 * refuses to load, so a known-good pair is worth more than being current.
 *
 * Checksums are honoured when present but upstream publishes none, so
 * integrity rests on HTTPS to a host in HOSTS, an archive that must extract,
 * a server binary that must be found, and a server that must answer a health
 * check. Point stt.engine.manifestURL at your own JSON to pin sha256.
 */

// The host allowlist lives in src/artifacts.js, because the chat model in
// src/local is fetched from the same set and a security-relevant list that
// exists twice is a list that will disagree with itself.
const { HOSTS, isAllowedURL } = require('../artifacts');

const WHISPER_TAG = 'v1.9.1';
const LLAMA_TAG = 'b10223';

const W_PIN = 'https://github.com/ggml-org/whisper.cpp/releases/download/' + WHISPER_TAG + '/';
const W_LATEST = 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/';
const L_PIN = 'https://github.com/ggml-org/llama.cpp/releases/download/' + LLAMA_TAG + '/';

/**
 * Two base archives, and the difference matters.
 *
 * BLAS is the better pure-CPU build -- the same binaries plus OpenBLAS, which
 * carries the encoder, for 12 MB more download.
 *
 * It is the wrong base for a GPU overlay, though: ggml registers the BLAS
 * backend as a compute device, whisper then reports
 *   whisper_backend_init_gpu: device 0: BLAS
 * and the Vulkan device it also found is left sitting behind it. The plain
 * build has no such competitor, so accelerated builds start from that.
 */
const CPU_ASSETS = [
  W_PIN + 'whisper-blas-bin-x64.zip',
  W_PIN + 'whisper-bin-x64.zip',
  W_LATEST + 'whisper-blas-bin-x64.zip',
  W_LATEST + 'whisper-bin-x64.zip'
];

const PLAIN_ASSETS = [
  W_PIN + 'whisper-bin-x64.zip',
  W_LATEST + 'whisper-bin-x64.zip'
];

/**
 * Build definitions.
 *
 * `assets` is tried in order, first hit wins. `overlay` files are copied next
 * to the server binary after the base archive is unpacked; if none of its
 * `pick` patterns match anything in the overlay archive the build is treated
 * as unavailable and the fallback chain is walked, because a Vulkan build with
 * no Vulkan DLL is just the CPU build wearing a label.
 */
const BUILDS = {
  cuda: {
    id: 'cuda',
    label: 'NVIDIA (CUDA)',
    note: 'GPU inference on NVIDIA cards. Large download, includes the CUDA runtime.',
    approxMB: 680,
    assets: [
      W_PIN + 'whisper-cublas-12.4.0-bin-x64.zip',
      W_PIN + 'whisper-cublas-11.8.0-bin-x64.zip',
      W_LATEST + 'whisper-cublas-12.4.0-bin-x64.zip'
    ],
    backendLog: /ggml_cuda|CUDA devices/i,
    deviceLog: /Device\s+\d+:\s*([^,]+)/i,
    fallback: ['vulkan', 'cpu']
  },
  rocm: {
    id: 'rocm',
    label: 'AMD (ROCm/HIP)',
    note: 'HIP inference on discrete AMD cards. Falls back to Vulkan if the backend will not load.',
    approxMB: 345,
    assets: PLAIN_ASSETS,
    overlay: {
      urls: [L_PIN + 'llama-' + LLAMA_TAG + '-bin-win-hip-radeon-x64.zip'],
      pick: [/^ggml-hip\.dll$/i, /^amdhip64.*\.dll$/i, /^rocblas\.dll$/i, /^hipblas(lt)?\.dll$/i],
      dirs: [/^rocblas[\\/]library$/i],
      require: /^ggml-hip\.dll$/i
    },
    backendLog: /ggml_(hip|cuda)|ROCm devices|loaded (HIP|ROCm) backend/i,
    deviceLog: /Device\s+\d+:\s*([^,]+)/i,
    fallback: ['vulkan', 'cpu']
  },
  vulkan: {
    id: 'vulkan',
    label: 'Vulkan (any GPU)',
    note: 'Vendor-neutral GPU inference. The right pick for AMD and Intel integrated graphics.',
    approxMB: 55,
    assets: PLAIN_ASSETS,
    overlay: {
      urls: [L_PIN + 'llama-' + LLAMA_TAG + '-bin-win-vulkan-x64.zip'],
      pick: [/^ggml-vulkan\.dll$/i],
      require: /^ggml-vulkan\.dll$/i
    },
    backendLog: /ggml_vulkan|loaded Vulkan backend/i,
    deviceLog: /ggml_vulkan:\s*\d+\s*=\s*([^|]+)/i,
    fallback: ['cpu']
  },
  cpu: {
    id: 'cpu',
    label: 'CPU (portable)',
    note: 'Runs anywhere. The default for older machines and for limited memory.',
    approxMB: 21,
    assets: CPU_ASSETS,
    fallback: []
  }
};

/**
 * Two families of weights, and when each one is right.
 *
 * whisper  OpenAI's own weights, 99 languages, MIT. The safe default and the
 *          only option for anything that is not English or German.
 * crisper  CrisperWhisper 2.0, a Whisper fine-tune trained to transcribe
 *          verbatim -- it keeps the filler words, false starts and repetitions
 *          that Whisper quietly paraphrases away, and its word timestamps land
 *          on the word rather than near it. English and German only, and the
 *          weights are licensed for non-commercial research use, so the choice
 *          is surfaced in the settings pane rather than made silently.
 *
 * The ggml conversions are not published by nyra health, so every CrisperWhisper
 * file is pinned by sha256 below: the community repository they come from can
 * change under us, and a mismatch has to fail the install rather than run.
 */
const FAMILIES = {
  whisper: {
    id: 'whisper',
    label: 'Whisper',
    note: '99 languages, MIT licensed. The safe default.',
    languages: null,                       // null: no restriction
    license: 'MIT'
  },
  crisper: {
    id: 'crisper',
    label: 'CrisperWhisper',
    note: 'Verbatim transcription, sharper word timing. English and German only.',
    languages: ['en', 'de'],
    license: 'Non-commercial research (nyra health)',
    licenseURL: 'https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md',
    homepage: 'https://github.com/nyrahealth/CrisperWhisper'
  }
};

/**
 * Models, smallest first.
 *
 * large-v3-turbo is the accuracy-per-millisecond pick: the large-v3 encoder
 * with four decoder layers instead of thirty-two, so it lands near large-v3
 * word error rate at roughly small-model latency. Its q5_0 quantisation is the
 * sweet spot for anything that is not a discrete card.
 *
 * The English-only weights are used when the transcription language is pinned
 * to English, where they are both smaller and more accurate than multilingual.
 *
 * CrisperWhisper is published as f16 only. Where a tier promises a quantised
 * model, the f16 is quantised on the machine after download with the
 * whisper-quantize binary that ships inside every whisper.cpp build, and the
 * f16 is deleted afterwards -- one large download, then the small file forever.
 */
const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODEL_MIRROR = 'https://huggingface.co/ggml-org/whisper.cpp/resolve/main/';
const CRISPER_HOST = 'https://huggingface.co/drbaph/CrisperWhisper2.0-GGML/resolve/main/';

function modelURLs(file) {
  return [MODEL_HOST + file + '?download=true', MODEL_MIRROR + file + '?download=true'];
}

function crisperURLs(file) {
  return [CRISPER_HOST + file + '?download=true'];
}

const MODELS = {
  base: {
    id: 'base',
    label: 'base',
    note: 'Fastest, roughest. For old hardware and small memory.',
    approxMB: 148,
    whisper: { en: 'ggml-base.en.bin', multi: 'ggml-base.bin', approxMB: 148 }
    // No CrisperWhisper at this size; base machines stay on stock Whisper.
  },
  small: {
    id: 'small',
    label: 'small',
    note: 'A clear step up in accuracy, still light.',
    approxMB: 488,
    whisper: { en: 'ggml-small.en.bin', multi: 'ggml-small.bin', approxMB: 488 },
    crisper: {
      en: 'ggml-crisperwhisper-small-f16.bin',
      multi: 'ggml-crisperwhisper-small-f16.bin',
      approxMB: 488,
      sha256: 'c9fbe6cc329636d35f223e0655c8507326294321d206c5c8aab99c1a56f27f0a'
    }
  },
  'turbo-q5': {
    id: 'turbo-q5',
    label: 'turbo (quantised)',
    note: 'Near large-v3 accuracy at a third of the memory. Best all-round choice.',
    approxMB: 574,
    whisper: {
      en: 'ggml-large-v3-turbo-q5_0.bin',
      multi: 'ggml-large-v3-turbo-q5_0.bin',
      approxMB: 574
    },
    crisper: {
      en: 'ggml-crisperwhisper-turbo-f16.bin',
      multi: 'ggml-crisperwhisper-turbo-f16.bin',
      approxMB: 1625,
      sha256: 'f9a12306a577c99cbdaab5a4988725fbceed5a92993baec10436e579116ffa41',
      quantize: 'q5_0'                     // downloaded f16, kept as q5_0
    }
  },
  turbo: {
    id: 'turbo',
    label: 'turbo',
    note: 'Full precision turbo. Wants a real GPU or plenty of RAM.',
    approxMB: 1620,
    whisper: {
      en: 'ggml-large-v3-turbo.bin',
      multi: 'ggml-large-v3-turbo.bin',
      approxMB: 1620
    },
    crisper: {
      en: 'ggml-crisperwhisper-turbo-f16.bin',
      multi: 'ggml-crisperwhisper-turbo-f16.bin',
      approxMB: 1625,
      sha256: 'f9a12306a577c99cbdaab5a4988725fbceed5a92993baec10436e579116ffa41'
    }
  },
  large: {
    id: 'large',
    label: 'large',
    note: 'The most accurate, and the heaviest. Only worth it on a discrete card.',
    approxMB: 3100,
    whisper: { en: 'ggml-large-v3.bin', multi: 'ggml-large-v3.bin', approxMB: 3100 },
    crisper: {
      en: 'ggml-crisperwhisper-large-f16.bin',
      multi: 'ggml-crisperwhisper-large-f16.bin',
      approxMB: 3095,
      sha256: '4160d90dcc11fb234bd126c85956e74c866b288524e8ec29a0a0a5c3e11c0cb7'
    }
  }
};

/** A build definition plus the chain to walk if it cannot be installed. */
function resolveBuild(id) {
  const build = BUILDS[id] || BUILDS.cpu;
  const chain = [build];
  for (const next of build.fallback || []) if (BUILDS[next]) chain.push(BUILDS[next]);
  return { build, chain };
}

/** Can this family transcribe that language at all? 'auto' counts as yes. */
function familySpeaks(familyId, language) {
  const fam = FAMILIES[familyId];
  if (!fam || !fam.languages) return true;
  const lang = String(language || 'auto').toLowerCase();
  if (!lang || lang === 'auto') return true;
  return fam.languages.some((l) => lang.startsWith(l));
}

/**
 * File and URLs for a model tier.
 *
 * language is the STT language setting: 'en' takes the English-only weights,
 * anything else (including 'auto') takes multilingual.
 *
 * family is a preference, not a promise. A tier with no weights in that family,
 * or a language that family was never trained on, silently resolves to stock
 * Whisper -- the alternative is confident nonsense in the user's own language.
 */
function resolveModel(tier, language, family) {
  const m = MODELS[tier] || MODELS.base;
  const wanted = FAMILIES[family] ? family : 'whisper';
  const usable = (m[wanted] && familySpeaks(wanted, language)) ? wanted : 'whisper';
  const v = m[usable];
  const en = String(language || '').toLowerCase().startsWith('en');
  const file = en ? v.en : v.multi;
  const out = {
    id: m.id,
    label: m.label,
    family: usable,
    familyLabel: FAMILIES[usable].label,
    downgraded: usable !== wanted,
    file,
    approxMB: v.approxMB || m.approxMB,
    sha256: v.sha256 || null,
    urls: usable === 'crisper' ? crisperURLs(file) : modelURLs(file)
  };
  if (v.quantize) {
    out.quantize = v.quantize;
    out.quantized = file.replace(/-f16\.bin$/i, '-' + v.quantize + '.bin');
  }
  return out;
}

/** Everything the settings pane needs to draw its dropdowns. */
function options() {
  return {
    builds: Object.values(BUILDS).map((b) => ({
      id: b.id, label: b.label, note: b.note, approxMB: b.approxMB
    })),
    models: Object.values(MODELS).map((m) => ({
      id: m.id, label: m.label, note: m.note, approxMB: m.approxMB,
      families: Object.keys(FAMILIES).filter((f) => !!m[f])
    })),
    families: Object.values(FAMILIES).map((f) => ({
      id: f.id, label: f.label, note: f.note, license: f.license,
      licenseURL: f.licenseURL || null, languages: f.languages
    }))
  };
}

module.exports = {
  BUILDS, MODELS, FAMILIES, HOSTS, WHISPER_TAG, LLAMA_TAG,
  resolveBuild, resolveModel, familySpeaks, options, isAllowedURL, modelURLs
};
