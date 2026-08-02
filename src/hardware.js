'use strict';
/**
 * Hardware probe, and the one place that decides which transcription build to run.
 *
 * Two callers, one answer: the installer runs build/probe-hardware.ps1 elevated
 * and drops the raw report next to the install, and the app runs the same script
 * on first launch. Both hand the report to classify(), so the choice cannot
 * drift between install time and run time.
 *
 * The script reports facts only. Everything judgemental -- is that an APU or a
 * real card, is 8 GB of shared memory enough for the turbo model -- is decided
 * here, in one function, in a language that can be unit tested.
 *
 * probe(opts)      -> report   (cached, never throws)
 * classify(report) -> decision { build, modelTier, gpu, reasons }
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCHEMA = 1;
const GB = 1024 * 1024 * 1024;

// A probe older than this is re-run: people do swap graphics cards.
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

// ------------------------------------------------------------------- probing
function scriptPath() {
  const candidates = [
    // packaged: shipped via build.extraResources
    process.resourcesPath && path.join(process.resourcesPath, 'probe-hardware.ps1'),
    // dev
    path.join(__dirname, '..', 'build', 'probe-hardware.ps1')
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

function readJSON(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    // Strip a UTF-8 BOM: PowerShell's older redirects write one, JSON.parse chokes on it.
    const j = JSON.parse(raw.replace(/^﻿/, ''));
    return (j && j.schema === SCHEMA) ? j : null;
  } catch {
    return null;
  }
}

/**
 * What can be known without shelling out.
 *
 * Used on macOS and Linux, and on Windows when PowerShell is locked down. No
 * GPU means classify() picks the CPU build, which is the safe way to be wrong.
 */
function fallbackReport() {
  const cpus = os.cpus() || [];
  return {
    schema: SCHEMA,
    ts: Math.floor(Date.now() / 1000),
    source: 'node',
    elevated: false,
    os: process.platform,
    arch: process.arch,
    ramBytes: os.totalmem(),
    cpu: {
      name: (cpus[0] && cpus[0].model) || '',
      vendor: 'unknown',
      cores: cpus.length,
      threads: cpus.length
    },
    gpus: []
  };
}

function runScript(outFile, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const script = scriptPath();
    if (process.platform !== 'win32' || !script) return resolve(null);
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', outFile],
      { timeout: timeoutMs, windowsHide: true },
      () => resolve(readJSON(outFile)));   // the script always exits 0; trust the file, not the code
  });
}

/**
 * Where the installer leaves its report.
 *
 * Two locations because the install can be per-machine (Program Files, which
 * the app cannot write to later) or per-user, and because a per-machine install
 * elevates to a different account than the one that ends up running Nimbus.
 */
function installerReportPaths() {
  const out = [];
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Nimbus', 'hardware.json'));
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, '..', 'hardware.json'));
  return out;
}

let cached = null;

/**
 * Best available report, cheapest source first.
 *
 * userDataDir is where the app's own copy lives; pass force to re-probe after a
 * hardware change without waiting out MAX_AGE_MS.
 */
async function probe({ userDataDir, force = false } = {}) {
  if (cached && !force) return cached;

  const mine = userDataDir ? path.join(userDataDir, 'hardware.json') : null;
  const fresh = (r) => r && (Date.now() / 1000 - (r.ts || 0)) * 1000 < MAX_AGE_MS;

  if (!force && mine) {
    const own = readJSON(mine);
    if (fresh(own)) { cached = own; return cached; }
  }

  if (!force) {
    for (const p of installerReportPaths()) {
      const r = readJSON(p);
      if (fresh(r)) {
        cached = r;
        if (mine) { try { fs.writeFileSync(mine, JSON.stringify(r)); } catch { /* cache is optional */ } }
        return cached;
      }
    }
  }

  const out = mine || path.join(os.tmpdir(), 'nimbus-hardware.json');
  cached = (await runScript(out)) || fallbackReport();
  if (mine && cached.source === 'node') {
    try { fs.writeFileSync(mine, JSON.stringify(cached)); } catch { /* cache is optional */ }
  }
  return cached;
}

// ---------------------------------------------------------------- judgement
const VIRTUAL = /^(microsoft|virtual|unknown)$/;

/**
 * Integrated or not.
 *
 * Matters because it changes the backend (an AMD APU wants Vulkan, an AMD card
 * wants ROCm) and the memory budget (an APU carves its VRAM out of system RAM,
 * so the reported figure is a window, not a limit).
 *
 * The tell is the pairing: a GPU from the same vendor as the CPU, with a
 * consumer part name that is missing from every discrete SKU. Discrete cards
 * are named RX / RTX / GTX / Arc; integrated ones are "... Graphics".
 */
function isIntegrated(gpu, cpuVendor) {
  if (!gpu) return false;
  if (gpu.vendor === 'nvidia') return false;
  const name = String(gpu.name || '');
  /**
   * Discrete parts carry a series name. Arc needs the model number too: the
   * card is "Arc(TM) A770 Graphics" while Core Ultra's integrated graphics are
   * plain "Intel(R) Arc(TM) Graphics", and only the number separates them.
   */
  if (/\b(RX|RTX|GTX|Quadro|Tesla|Instinct)\b/i.test(name)) return false;
  if (/\bArc\b[^,]*\b[AB]\d{3}\b/i.test(name)) return false;
  if (gpu.vendor !== cpuVendor) return /\b(UHD|Iris|Vega|integrated|APU)\b/i.test(name);
  return /graphics|APU|Vega|UHD|Iris/i.test(name) || (gpu.vramBytes || 0) < 1.5 * GB;
}

function rankGPU(g, cpuVendor) {
  if (VIRTUAL.test(g.vendor || '')) return -1;
  const integrated = isIntegrated(g, cpuVendor);
  const base = { nvidia: 300, amd: 200, intel: 100 }[g.vendor] || 0;
  return base + (integrated ? 0 : 50) + Math.min(40, (g.vramBytes || 0) / GB);
}

/**
 * Which build to download, and how big a model it can carry.
 *
 * The backend map is the user-facing contract: NVIDIA gets CUDA, an AMD card
 * gets ROCm, an AMD or Intel integrated part gets Vulkan, and anything else --
 * including any machine too short on memory to hold a useful model -- gets the
 * portable CPU build. Vulkan is the fallback for GPUs we recognise but whose
 * vendor toolchain we have no build for, since it is the one accelerator that
 * is not tied to a vendor.
 */
function classify(report) {
  const r = report || fallbackReport();
  const ramGB = (r.ramBytes || 0) / GB;
  const cpuVendor = (r.cpu && r.cpu.vendor) || 'unknown';
  const cores = (r.cpu && r.cpu.cores) || 0;
  const reasons = [];

  const usable = (r.gpus || []).filter((g) => rankGPU(g, cpuVendor) >= 0);
  usable.sort((a, b) => rankGPU(b, cpuVendor) - rankGPU(a, cpuVendor));
  const top = usable[0] || null;
  const integrated = top ? isIntegrated(top, cpuVendor) : false;
  /**
   * Clamped, because an APU driver reports the window it is allowed to map,
   * not memory it owns: a Radeon 8060S on a 32 GB machine reports 96 GB. Left
   * unclamped it reads as a workstation card in the settings pane and inflates
   * the model budget below.
   */
  let vramGB = top ? (top.vramBytes || 0) / GB : 0;
  if (integrated && ramGB > 0) vramGB = Math.min(vramGB, ramGB);

  let build = 'cpu';
  if (!top) {
    reasons.push('no usable display adapter found');
  } else if (ramGB > 0 && ramGB < 8) {
    reasons.push(Math.round(ramGB) + ' GB of RAM: staying on the portable CPU build');
  } else if (top.vendor === 'nvidia') {
    build = 'cuda';
    reasons.push('NVIDIA ' + (top.name || 'GPU'));
  } else if (top.vendor === 'amd' && !integrated) {
    build = 'rocm';
    reasons.push('discrete AMD ' + (top.name || 'GPU'));
  } else if (top.vendor === 'amd' || top.vendor === 'intel') {
    // An APU with little system RAM shares too little with the GPU to win.
    if (integrated && ramGB > 0 && ramGB < 12) {
      reasons.push('integrated GPU with only ' + Math.round(ramGB) + ' GB shared: CPU build is faster');
    } else {
      build = 'vulkan';
      reasons.push((integrated ? 'integrated ' : '') + (top.name || top.vendor));
    }
  } else {
    reasons.push('unrecognised adapter ' + (top.name || top.vendor));
  }

  /**
   * Memory the model may actually use.
   *
   * A discrete card is bounded by its own VRAM. An APU reports a carve-out that
   * the driver grows on demand, so system RAM is the real ceiling and a quarter
   * of it is the polite share. CPU inference pages through system RAM too, but
   * competes with the browser engine, so it gets the same quarter.
   */
  const budget = build === 'cpu' ? ramGB / 4
    : integrated ? Math.max(vramGB, ramGB / 4)
      : vramGB;

  /**
   * Full-precision turbo is reserved for discrete cards.
   *
   * Everywhere else -- CPU inference, and integrated graphics that read through
   * system memory -- the work is bandwidth-bound, so the q5 quantisation of the
   * same model is both faster and a third of the download for accuracy that is
   * hard to tell apart on speech.
   */
  let modelTier;
  if (budget >= 6 && !integrated && build !== 'cpu') modelTier = 'turbo';
  else if (budget >= 3 && (build !== 'cpu' || cores >= 8)) modelTier = 'turbo-q5';
  else if (budget >= 1.5) modelTier = 'small';
  else modelTier = 'base';

  return {
    build,
    modelTier,
    ramGB: Math.round(ramGB * 10) / 10,
    cores,
    elevated: !!r.elevated,
    probedAt: r.ts || 0,
    source: r.source || 'node',
    gpu: top ? {
      name: top.name || '',
      vendor: top.vendor || 'unknown',
      vramGB: Math.round(vramGB * 10) / 10,
      integrated
    } : null,
    reasons
  };
}

/** One line for the settings pane and the logs. */
function describe(decision) {
  const d = decision || {};
  const gpu = d.gpu ? d.gpu.name + (d.gpu.vramGB ? ' (' + d.gpu.vramGB + ' GB)' : '') : 'no GPU';
  return gpu + ', ' + (d.ramGB || 0) + ' GB RAM -> ' + (d.build || 'cpu') + ' build, ' + (d.modelTier || 'base') + ' model';
}

module.exports = { probe, classify, describe, fallbackReport, isIntegrated, SCHEMA };
