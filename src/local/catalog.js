'use strict';
/**
 * What the in-the-box model is: a llama.cpp build, and one small chat model.
 *
 * Same shape as src/whisper/catalog.js, deliberately. That file is the working
 * answer to "download an inference server and a model, sized to this machine,
 * without shipping either", and a second answer to the same question would be a
 * second set of bugs.
 *
 * One difference, and it is upstream's doing rather than ours: whisper.cpp
 * publishes no accelerated Windows asset, so its accelerated builds are a CPU
 * archive with a backend DLL dropped in beside the binary. llama.cpp publishes
 * a complete archive per backend, so there is no overlay here except CUDA's
 * runtime, which upstream ships as a separate download for the same reason it
 * always has: it is bigger than the build.
 *
 * Asset names were verified by HEAD against the pinned tag rather than assumed:
 *
 *   llama-b10223-bin-win-cpu-x64.zip           18 MB
 *   llama-b10223-bin-win-vulkan-x64.zip        33 MB
 *   llama-b10223-bin-win-cuda-12.4-x64.zip    239 MB
 *   llama-b10223-bin-win-hip-radeon-x64.zip   310 MB
 *   cudart-llama-bin-win-cuda-12.4-x64.zip    373 MB
 *
 * The tag is the same b10223 the whisper catalog pins its backend DLLs to, so a
 * machine that installed a GPU whisper build and then the local model is running
 * one ggml version, not two.
 */

const { isAllowedURL } = require('../artifacts');

const LLAMA_TAG = 'b10223';
const L_PIN = 'https://github.com/ggml-org/llama.cpp/releases/download/' + LLAMA_TAG + '/';
const L_LATEST = 'https://github.com/ggml-org/llama.cpp/releases/latest/download/';

function asset(name) {
  return [L_PIN + 'llama-' + LLAMA_TAG + '-bin-' + name + '.zip'];
}

/**
 * Build definitions.
 *
 * `assets` is tried in order, first hit wins, and `fallback` is walked when a
 * tier cannot be installed at all. A machine that ends up one tier down still
 * answers questions; a machine that insists on CUDA and cannot have it does not.
 *
 * `backendLog` is how we find out whether the accelerator really bound to a
 * device. ggml falls back to CPU inside the same process, silently, so the
 * startup log is the only honest source -- exactly as in the whisper engine.
 */
const BUILDS = {
  cuda: {
    id: 'cuda',
    label: 'NVIDIA (CUDA)',
    note: 'GPU inference on NVIDIA cards. Large: the CUDA runtime is most of it.',
    approxMB: 612,
    assets: asset('win-cuda-12.4-x64'),
    overlay: {
      urls: [L_PIN + 'cudart-llama-bin-win-cuda-12.4-x64.zip', L_LATEST + 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
      pick: [/^cudart64.*\.dll$/i, /^cublas(Lt)?64.*\.dll$/i],
      require: /^cudart64.*\.dll$/i
    },
    backendLog: /ggml_cuda|CUDA devices|loaded CUDA backend/i,
    deviceLog: /Device\s+\d+:\s*([^,]+)/i,
    fallback: ['vulkan', 'cpu']
  },
  rocm: {
    id: 'rocm',
    label: 'AMD (ROCm/HIP)',
    note: 'HIP inference on discrete AMD cards. Falls back to Vulkan if it will not load.',
    approxMB: 310,
    assets: asset('win-hip-radeon-x64'),
    backendLog: /ggml_(hip|cuda)|ROCm devices|loaded (HIP|ROCm) backend/i,
    deviceLog: /Device\s+\d+:\s*([^,]+)/i,
    fallback: ['vulkan', 'cpu']
  },
  vulkan: {
    id: 'vulkan',
    label: 'Vulkan (any GPU)',
    note: 'Vendor-neutral GPU inference. The right pick for AMD and Intel integrated graphics.',
    approxMB: 33,
    assets: asset('win-vulkan-x64'),
    backendLog: /ggml_vulkan|loaded Vulkan backend/i,
    deviceLog: /ggml_vulkan:\s*\d+\s*=\s*([^|]+)/i,
    fallback: ['cpu']
  },
  cpu: {
    id: 'cpu',
    label: 'CPU (portable)',
    note: 'Runs anywhere. The default for older machines and for limited memory.',
    approxMB: 18,
    assets: process.arch === 'arm64' ? asset('win-cpu-arm64') : asset('win-cpu-x64'),
    fallback: []
  }
};

/**
 * The models, and what this tier is honestly for.
 *
 * This is the floor of the ladder, not a small version of the top of it. A 0.5B
 * model can follow an instruction, rewrite a sentence, tidy a transcript and
 * answer something short from what it already knows. It cannot reason through a
 * problem, and the UI says so in those words rather than implying a Smart model
 * that happens to be slower.
 *
 * Five candidates were measured through this engine on the CPU build before
 * these three were picked; LOCAL-MODELS.md has the numbers and the prompts.
 * `residentMB` and `tps` below are measured, not estimated, which is why they
 * are here rather than in a comment.
 *
 * Two of the five did not make it. SmolLM2 360M is the fastest thing that runs
 * but it failed two of six checks, and speed is not the constraint at this size.
 * Llama 3.2 1B refused to tidy a dictated sentence about a release date -- a
 * spurious refusal on the exact job this tier exists to do, and it costs 40%
 * more memory than Gemma for it.
 *
 * Every file is pinned by sha256. These are community conversions: the repos can
 * be re-uploaded under the same filename, and a model that silently changed
 * underneath the app is worse than one that refuses to install. Each hash is of
 * the file that produced the numbers beside it.
 *
 * Licensing decides what gets picked *for* a user, as much as the benchmark
 * does. `auto` marks the models the hardware probe may choose on its own; both
 * are Apache-2.0. Gemma is the best quality-per-megabyte in the field and is
 * offered, but it carries Google's use policy, so a user chooses it themselves
 * with the licence named on the button.
 */
const HF = 'https://huggingface.co/';

function hf(repo, file) {
  return [HF + repo + '/resolve/main/' + file + '?download=true'];
}

const MODELS = {
  tiny: {
    id: 'tiny',
    label: 'Qwen2.5 0.5B',
    model: 'qwen2.5-0.5b-instruct',
    note: 'Fits anywhere, including an 8 GB machine with the app running.',
    license: 'Apache-2.0',
    licenseURL: 'https://www.apache.org/licenses/LICENSE-2.0',
    auto: true,
    params: '0.5B',
    approxMB: 379,
    residentMB: 542,
    tps: 125,
    ctx: 4096,
    urls: hf('bartowski/Qwen2.5-0.5B-Instruct-GGUF', 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf'),
    file: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
    sha256: '6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653'
  },
  compact: {
    id: 'compact',
    label: 'Gemma 3 1B',
    model: 'gemma-3-1b-it',
    note: "Twice the model for half again the memory. Google's licence, not Apache.",
    license: 'Gemma Terms of Use',
    licenseURL: 'https://ai.google.dev/gemma/terms',
    auto: false,
    params: '1B',
    approxMB: 769,
    residentMB: 1021,
    tps: 65,
    ctx: 4096,
    urls: hf('ggml-org/gemma-3-1b-it-GGUF', 'gemma-3-1b-it-Q4_K_M.gguf'),
    file: 'gemma-3-1b-it-Q4_K_M.gguf',
    sha256: '8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135'
  },
  standard: {
    id: 'standard',
    label: 'Qwen2.5 1.5B',
    model: 'qwen2.5-1.5b-instruct',
    note: 'The steadiest of the three. Wants 12 GB or more.',
    license: 'Apache-2.0',
    licenseURL: 'https://www.apache.org/licenses/LICENSE-2.0',
    auto: true,
    params: '1.5B',
    approxMB: 940,
    residentMB: 1745,
    tps: 56,
    ctx: 4096,
    urls: hf('bartowski/Qwen2.5-1.5B-Instruct-GGUF', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'),
    file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    sha256: '1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370'
  }
};

const TIER_ORDER = ['tiny', 'compact', 'standard'];

/** A build definition plus the chain to walk if it cannot be installed. */
function resolveBuild(id) {
  const build = BUILDS[id] || BUILDS.cpu;
  const chain = [build];
  for (const next of build.fallback || []) if (BUILDS[next]) chain.push(BUILDS[next]);
  return { build, chain };
}

/** The model for a tier. Unknown tiers get the smallest, never nothing. */
function resolveModel(tier) {
  return MODELS[tier] || MODELS.tiny;
}

/**
 * How much memory the machine loses while this model is loaded.
 *
 * Measured with the server running at its full context, not derived from the
 * file size. The KV cache is the part an estimate forgets: it scales with the
 * context length, it is resident for as long as the server is, and a number that
 * ignores it promises a machine can hold a model that it then cannot hold. The
 * download figure is roughly half the truth -- Qwen 1.5B is a 940 MB file and
 * 1745 MB of memory -- and the UI shows both for that reason.
 */
function footprintMB(tier) {
  const m = resolveModel(tier);
  return m.residentMB || Math.round(m.approxMB + (m.ctx / 1024) * 32);
}

/** Everything the settings pane needs to describe the choice. */
function options() {
  return {
    builds: Object.values(BUILDS).map((b) => ({
      id: b.id, label: b.label, note: b.note, approxMB: b.approxMB
    })),
    models: TIER_ORDER.map((id) => {
      const m = MODELS[id];
      return {
        id: m.id, label: m.label, note: m.note, params: m.params,
        approxMB: m.approxMB, footprintMB: footprintMB(m.id), tps: m.tps || 0,
        auto: !!m.auto, license: m.license, licenseURL: m.licenseURL || null, ctx: m.ctx
      };
    })
  };
}

module.exports = {
  BUILDS, MODELS, TIER_ORDER, LLAMA_TAG,
  resolveBuild, resolveModel, footprintMB, options, isAllowedURL
};
