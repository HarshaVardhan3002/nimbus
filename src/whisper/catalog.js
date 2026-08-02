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

// Only these hosts are ever fetched from, whatever a manifest asks for.
const HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.hf.co',
  'cas-bridge.xethub.hf.co'
];

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
 * Models, smallest first.
 *
 * large-v3-turbo is the accuracy-per-millisecond pick: the large-v3 encoder
 * with four decoder layers instead of thirty-two, so it lands near large-v3
 * word error rate at roughly small-model latency. Its q5_0 quantisation is the
 * sweet spot for anything that is not a discrete card.
 *
 * The English-only weights are used when the transcription language is pinned
 * to English, where they are both smaller and more accurate than multilingual.
 */
const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODEL_MIRROR = 'https://huggingface.co/ggml-org/whisper.cpp/resolve/main/';

function modelURLs(file) {
  return [MODEL_HOST + file + '?download=true', MODEL_MIRROR + file + '?download=true'];
}

const MODELS = {
  base: {
    id: 'base',
    label: 'base',
    note: 'Fastest, roughest. For old hardware and small memory.',
    en: 'ggml-base.en.bin',
    multi: 'ggml-base.bin',
    approxMB: 148
  },
  small: {
    id: 'small',
    label: 'small',
    note: 'A clear step up in accuracy, still light.',
    en: 'ggml-small.en.bin',
    multi: 'ggml-small.bin',
    approxMB: 488
  },
  'turbo-q5': {
    id: 'turbo-q5',
    label: 'large-v3-turbo (quantised)',
    note: 'Near large-v3 accuracy at a third of the memory. Best all-round choice.',
    en: 'ggml-large-v3-turbo-q5_0.bin',
    multi: 'ggml-large-v3-turbo-q5_0.bin',
    approxMB: 574
  },
  turbo: {
    id: 'turbo',
    label: 'large-v3-turbo',
    note: 'Full precision turbo. Wants a real GPU or plenty of RAM.',
    en: 'ggml-large-v3-turbo.bin',
    multi: 'ggml-large-v3-turbo.bin',
    approxMB: 1620
  }
};

function isAllowedURL(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** A build definition plus the chain to walk if it cannot be installed. */
function resolveBuild(id) {
  const build = BUILDS[id] || BUILDS.cpu;
  const chain = [build];
  for (const next of build.fallback || []) if (BUILDS[next]) chain.push(BUILDS[next]);
  return { build, chain };
}

/**
 * File and URLs for a model tier.
 *
 * language is the STT language setting: 'en' takes the English-only weights,
 * anything else (including 'auto') takes multilingual.
 */
function resolveModel(tier, language) {
  const m = MODELS[tier] || MODELS.base;
  const en = String(language || '').toLowerCase().startsWith('en');
  const file = en ? m.en : m.multi;
  return { id: m.id, label: m.label, file, approxMB: m.approxMB, urls: modelURLs(file) };
}

/** Everything the settings pane needs to draw its two dropdowns. */
function options() {
  return {
    builds: Object.values(BUILDS).map((b) => ({
      id: b.id, label: b.label, note: b.note, approxMB: b.approxMB
    })),
    models: Object.values(MODELS).map((m) => ({
      id: m.id, label: m.label, note: m.note, approxMB: m.approxMB
    }))
  };
}

module.exports = {
  BUILDS, MODELS, HOSTS, WHISPER_TAG, LLAMA_TAG,
  resolveBuild, resolveModel, options, isAllowedURL, modelURLs
};
