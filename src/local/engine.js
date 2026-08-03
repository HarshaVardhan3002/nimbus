'use strict';
/**
 * The in-the-box chat model: fetch it, run it, watch it, and get out of the way.
 *
 * Same machine as src/whisper/engine.js -- download a build, download weights,
 * launch a loopback server, health-check it, restart it a bounded number of
 * times -- because it is the same problem. Read that file first; the comments
 * here cover only what differs.
 *
 * What differs:
 *
 *   1. Cancel. The transcription model is 600 MB and arrives during setup. This
 *      one is a deliberate download the user asked for, mid-session, and a
 *      download you cannot stop is a bad citizen. Every fetch runs under an
 *      AbortController that cancel() trips.
 *
 *   2. It is not always meant to be running. A user with a real provider should
 *      not have a 400 MB model resident to serve a tier nothing routes to.
 *      stop() and ensure() are called by the supervisor in main.js as providers
 *      come and go, so this module treats being told to shut down as normal
 *      rather than as an error.
 *
 *   3. llama-server speaks OpenAI. Once ready it is an ordinary local provider
 *      at http://127.0.0.1:<port>/v1, and src/providers.js talks to it the same
 *      way it talks to anything else. Nothing downstream special-cases it.
 *
 * Everything lives under <userData>/local.
 *
 * State machine: idle -> downloading -> extracting -> starting -> ready, with
 * error as an absorbing state that ensure() can be called out of.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { resolveBuild, resolveModel, footprintMB } = require('./catalog');
const {
  mkdirp, exists, extract, walk, findBinary,
  pickPort, download, assetExists, assetSize, sha256
} = require('../artifacts');

const HEALTH_TIMEOUT_MS = 120000;   // loading a quantised 1B off a cold disk
const HEALTH_POLL_MS = 500;
const MAX_RESTARTS = 3;
const DEFAULT_PORT = 8090;          // clear of whisper's 8081 and its 12-port search

/** The server binary, wherever the archive chose to put it. */
function findServer(root) {
  return findBinary(root, process.platform === 'win32'
    ? ['llama-server.exe', 'server.exe']
    : ['llama-server', 'server']);
}

/** Thrown when the user pressed Cancel, so callers can tell it from a failure. */
class Cancelled extends Error {
  constructor() { super('cancelled'); this.name = 'Cancelled'; this.cancelled = true; }
}

const isAbort = (e) => !!e && (e.cancelled || e.name === 'AbortError');

// -------------------------------------------------------------------- engine
function createEngine({ userDataDir, log = () => {} } = {}) {
  const root = path.join(userDataDir, 'local');
  const binRoot = path.join(root, 'bin');
  const modelRoot = path.join(root, 'models');
  const tmpRoot = path.join(root, 'tmp');
  const statePath = path.join(root, 'state.json');

  const listeners = new Set();
  let child = null;
  let apiKey = '';               // bearer token the running server demands
  let restarts = 0;
  let busy = null;               // in-flight ensure(), so two callers cannot race
  let aborter = null;            // live while anything is downloading
  let state = {
    phase: 'idle',               // idle | downloading | extracting | starting | ready | error
    build: null,                 // build actually installed, which may be a fallback
    wanted: null,                // build asked for
    model: null,                 // tier actually loaded
    wantedModel: null,
    label: '',                   // what to call it in the UI
    port: 0,
    endpoint: '',                // OpenAI-compatible base, i.e. .../v1
    message: '',
    accel: null,                 // did the accelerated backend really load
    device: '',
    progress: null,              // { what, done, total }
    ctx: 0
  };

  function emit(patch) {
    state = Object.assign({}, state, patch);
    for (const fn of listeners) {
      try { fn(state); } catch { /* a bad listener must not stall the engine */ }
    }
  }

  async function readState() {
    try { return JSON.parse(await fsp.readFile(statePath, 'utf8')); } catch { return {}; }
  }

  async function writeState(patch) {
    const next = Object.assign(await readState(), patch);
    await mkdirp(root);
    await fsp.writeFile(statePath, JSON.stringify(next, null, 2));
    return next;
  }

  const signal = () => (aborter ? aborter.signal : undefined);

  function checkCancelled() {
    if (aborter && aborter.signal.aborted) throw new Cancelled();
  }

  // ------------------------------------------------------------- installing
  /**
   * Copy the CUDA runtime in beside the server binary.
   *
   * llama.cpp publishes a complete archive per backend, so unlike whisper this
   * is not how accelerated builds are assembled -- it is one exception. The CUDA
   * build links against a runtime that upstream ships separately because it is
   * larger than the build itself, and without it the binary will not start at
   * all: not slower, not on CPU, it fails to load.
   */
  async function applyOverlay(overlay, serverDir, onProgress) {
    const stage = path.join(tmpRoot, 'overlay-' + Date.now());
    await mkdirp(stage);
    try {
      let unpacked = false;
      for (const url of overlay.urls) {
        if (!(await assetExists(url))) continue;
        emit({ phase: 'downloading', message: 'Downloading the CUDA runtime...' });
        const archive = path.join(stage, path.basename(new URL(url).pathname));
        await download(url, archive, (done, total) => {
          emit({ progress: { what: 'runtime', done, total } });
          if (onProgress) onProgress('runtime', done, total);
        }, { signal: signal() });
        emit({ phase: 'extracting', message: 'Unpacking the CUDA runtime...', progress: null });
        await extract(archive, stage);
        await fsp.rm(archive, { force: true });
        unpacked = true;
        break;
      }
      if (!unpacked) throw new Error('no runtime archive available');

      let required = !overlay.require;
      let copied = 0;
      for (const f of await walk(stage)) {
        const name = path.basename(f);
        if (!overlay.pick.some((re) => re.test(name))) continue;
        await fsp.copyFile(f, path.join(serverDir, name));
        copied++;
        if (overlay.require && overlay.require.test(name)) required = true;
      }
      if (!copied || !required) throw new Error('runtime archive did not contain the expected library');
      return copied;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Get a build on disk, walking the fallback chain when a tier cannot be had.
   *
   * Same rule as whisper: a machine one tier down still answers questions, and
   * one that insisted on CUDA and could not have it does not.
   */
  async function ensureBuild(wantedId, onProgress) {
    const { chain } = resolveBuild(wantedId);
    const errors = [];

    for (const build of chain) {
      checkCancelled();
      const dir = path.join(binRoot, build.id);
      const cached = await findServer(dir);
      if (cached) {
        const ok = !build.overlay || !build.overlay.require
          || (await fsp.readdir(path.dirname(cached))).some((f) => build.overlay.require.test(f));
        if (ok) return { build, exe: cached, cached: true };
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }

      let landed = null;
      for (const url of build.assets) {
        try {
          if (!(await assetExists(url))) { errors.push(build.id + ': no asset ' + path.basename(url)); continue; }
          emit({ phase: 'downloading', message: 'Downloading the ' + build.label + ' runtime...' });
          await mkdirp(dir);
          const archive = path.join(dir, path.basename(new URL(url).pathname));
          await download(url, archive, (done, total) => {
            emit({ progress: { what: 'build', done, total } });
            if (onProgress) onProgress('build', done, total);
          }, { signal: signal() });
          emit({ phase: 'extracting', message: 'Unpacking the ' + build.label + ' runtime...', progress: null });
          await extract(archive, dir);
          await fsp.rm(archive, { force: true });
          const exe = await findServer(dir);
          if (!exe) { errors.push(build.id + ': archive had no server binary'); continue; }
          landed = exe;
          break;
        } catch (e) {
          if (isAbort(e)) throw new Cancelled();
          errors.push(build.id + ': ' + ((e && e.message) || String(e)));
        }
      }

      if (landed && build.overlay) {
        try {
          await applyOverlay(build.overlay, path.dirname(landed), onProgress);
        } catch (e) {
          if (isAbort(e)) throw new Cancelled();
          errors.push(build.id + ': ' + ((e && e.message) || String(e)));
          landed = null;
        }
      }
      if (landed) return { build, exe: landed, cached: false };

      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    throw new Error('no usable runtime. ' + errors.join('; '));
  }

  /**
   * Get the weights on disk.
   *
   * No fallback chain here, unlike whisper's. Whisper falls back to a different
   * family because a worse transcript beats no transcript and the user still
   * gets their words. Silently swapping in a different chat model would change
   * the answers a user is reading without telling them, so a failure here is a
   * failure: it is reported, and the tier stays uninstalled.
   */
  async function ensureModel(tier, onProgress) {
    const model = resolveModel(tier);
    const dest = path.join(modelRoot, model.file);
    if (await exists(dest)) return { file: dest, model, cached: true };

    const errors = [];
    for (const url of model.urls) {
      try {
        checkCancelled();
        emit({
          phase: 'downloading',
          message: 'Downloading ' + model.label + ' (' + model.approxMB + ' MB)...'
        });
        await download(url, dest, (done, total) => {
          emit({ progress: { what: 'model', done, total } });
          if (onProgress) onProgress('model', done, total);
        }, { signal: signal() });

        if (model.sha256) {
          emit({ phase: 'extracting', message: 'Verifying ' + model.label + '...', progress: null });
          const got = await sha256(dest);
          if (got !== model.sha256) {
            await fsp.rm(dest, { force: true });
            throw new Error('checksum mismatch (' + got.slice(0, 12) + ')');
          }
        }
        return { file: dest, model, cached: false };
      } catch (e) {
        if (isAbort(e)) throw new Cancelled();
        errors.push((e && e.message) || String(e));
      }
    }
    throw new Error('model download failed. ' + errors.join('; '));
  }

  // ---------------------------------------------------------------- running
  /**
   * Wait for /health to say ok.
   *
   * llama-server answers 503 with {"status":"loading model"} while it is still
   * mapping weights, so unlike whisper's "does it speak HTTP at all" check, a
   * response here is not enough -- only a 200 means the model is loaded and the
   * first request will not hang.
   */
  async function health(port, deadline) {
    while (Date.now() < deadline) {
      if (!child) return false;                  // it died while we were waiting
      try {
        // /health is public in llama.cpp, but the header costs nothing and
        // survives that no longer being true.
        const res = await fetch('http://127.0.0.1:' + port + '/health',
          { headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {} });
        if (res.ok) return true;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    return false;
  }

  function stop() {
    restarts = MAX_RESTARTS;     // deliberate stop: do not resurrect
    if (child && !child.killed) {
      try { child.kill(); } catch { /* already gone */ }
    }
    child = null;
    apiKey = '';                 // the token dies with the server that honoured it
    if (state.phase !== 'error') {
      emit({ phase: 'idle', endpoint: '', port: 0, message: '', accel: null, device: '' });
    }
  }

  /**
   * Cancel whatever is in flight.
   *
   * Aborting the fetch unwinds through download()'s cleanup, which removes the
   * .part file, so a cancelled 400 MB download costs the user nothing but the
   * bandwidth already spent. A cancel is not an error state: the engine returns
   * to idle, where the button says Download again.
   */
  function cancel() {
    if (aborter) aborter.abort();
    if (state.phase === 'downloading' || state.phase === 'extracting') {
      emit({ phase: 'idle', message: '', progress: null });
    }
  }

  /**
   * Threads for CPU inference.
   *
   * Half the logical cores, capped. os.cpus() counts hyperthreads, and llama.cpp
   * gains nothing from the second thread on a core while the rest of the app --
   * a compositor, an audio capture thread, Chromium -- still needs somewhere to
   * run. The promise is that the minimum-spec machine stays responsive, and
   * taking every core is how that promise gets broken.
   */
  function threadCount() {
    const n = (os.cpus() || []).length || 4;
    return Math.max(2, Math.min(8, Math.floor(n / 2)));
  }

  /**
   * Ask the build what it can offload to, instead of reading its startup log.
   *
   * The whisper engine proves its accelerator by matching a line the server
   * prints on the way up. llama-server stopped printing that banner at default
   * verbosity somewhere before b10223: the Vulkan build here loads the model
   * into a Vulkan device and says nothing about it, so log-matching alone
   * reports "no accelerator" on a build that is plainly using one -- and the UI
   * would then invite the user to fix a problem they do not have.
   *
   * `--list-devices` is the same binary answering the same question in a format
   * meant to be read. The CPU build prints "(none)"; the Vulkan build prints
   * "Vulkan0: AMD Radeon(TM) 8060S Graphics (114507 MiB, 108782 MiB free)".
   * Costs one short-lived process per launch, and unlike the log it is a
   * question we asked rather than one we hoped would be answered.
   *
   * Returns the device name, or '' for a build with nothing to offload to.
   */
  function probeDevice(exe) {
    return new Promise((resolve) => {
      execFile(exe, ['--list-devices'],
        { cwd: path.dirname(exe), timeout: 15000, windowsHide: true },
        (_err, out) => {
          const m = /^\s+([A-Za-z]+\d*):\s*(\S.*)$/m.exec(String(out || ''));
          if (!m) return resolve('');
          // Trim the memory summary; the name is the part worth showing.
          resolve(m[2].replace(/\s*\([^()]*MiB[^()]*\)\s*$/, '').trim());
        });
    });
  }

  /**
   * Start the server and prove the accelerator is live.
   *
   * `optional` holds flags that a build might not recognise; llama-server exits
   * on an unknown argument, and an engine that refuses to start at all because
   * of a nicety is worse than one without the nicety. If the process dies before
   * it is ready, we retry once with the minimum set that every build has always
   * accepted, and say so in the log.
   */
  async function launch({ build, exe, modelFile, model, port, threads, minimal = false }) {
    stop();
    restarts = 0;
    const chosen = await pickPort(port || DEFAULT_PORT);
    // No point asking the CPU build, and no point offloading if the accelerated
    // build cannot see a device: -ngl on a build with nowhere to put the layers
    // is a flag that does nothing, and claiming acceleration for it is a lie.
    const device = build.id === 'cpu' ? '' : await probeDevice(exe);
    const optional = minimal ? [] : ['--jinja'];
    if (!minimal && device) optional.push('-ngl', '99');
    /**
     * A fresh secret per launch, and why a loopback bind is not enough.
     *
     * llama-server answers with `Access-Control-Allow-Origin: *`. Binding to
     * 127.0.0.1 keeps other machines out, but it does not keep web pages out:
     * any site the user has open can fetch http://127.0.0.1:8090 from their
     * browser and, thanks to that header, read the response. That is somebody
     * else's page driving a model on this machine.
     *
     * `--api-key` turns every request without the bearer token into a 401. The
     * token never leaves this process -- it is not written to settings, to the
     * state file or to the log -- so a page has no way to guess it. Minted per
     * launch because it costs nothing and nothing needs it to outlive the
     * server.
     */
    apiKey = crypto.randomBytes(24).toString('hex');
    const args = [
      '-m', modelFile,
      '--host', '127.0.0.1',
      '--port', String(chosen),
      '-c', String(model.ctx),
      '-t', String(threads || threadCount()),
      '--alias', model.model,
      '--api-key', apiKey
    ].concat(optional);

    emit({
      phase: 'starting', port: chosen, ctx: model.ctx, label: model.label,
      device, message: 'Starting ' + model.label + '...', progress: null
    });
    // The token is the one argument that must not reach the log.
    log('local: ' + path.basename(exe) + ' '
      + args.map((a) => (a === apiKey ? '<token>' : a)).join(' '));

    let exited = false;
    child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onLine = (b) => {
      const line = String(b).trim();
      if (!line) return;
      log('local: ' + line);
      // Kept as a second source: builds that still print the banner name the
      // device more precisely than the probe does.
      if (build.backendLog && build.backendLog.test(line)) {
        const dev = build.deviceLog && build.deviceLog.exec(line);
        emit({ accel: true, device: (dev && dev[1].trim()) || state.device });
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('exit', (code) => {
      const wasReady = state.phase === 'ready';
      exited = true;
      child = null;
      if (restarts >= MAX_RESTARTS) return;
      if (wasReady) {
        restarts++;
        log('local: server exited (' + code + '), restart ' + restarts + '/' + MAX_RESTARTS);
        setTimeout(() => { launch({ build, exe, modelFile, model, port: chosen, threads, minimal }).catch(() => {}); },
          1500 * restarts);
      }
    });

    const ok = await health(chosen, Date.now() + HEALTH_TIMEOUT_MS);
    if (!ok) {
      stop();
      if (exited && !minimal) {
        log('local: server would not start, retrying without ' + optional.join(' '));
        return launch({ build, exe, modelFile, model, port: chosen, threads, minimal: true });
      }
      emit({ phase: 'error', message: model.label + ' did not start on port ' + chosen + '.' });
      throw new Error('health check failed');
    }
    emit({
      phase: 'ready',
      port: chosen,
      endpoint: 'http://127.0.0.1:' + chosen + '/v1',
      message: '',
      accel: !!(device || state.accel),
      device: state.device || device
    });
    return chosen;
  }

  /**
   * Bring the engine up to match the settings and the hardware decision.
   *
   * Safe to call repeatedly, and cheap when nothing changed -- which is what
   * lets the supervisor call it every time a provider appears or disappears
   * without thinking about whether it needs to.
   */
  async function ensure({ build, modelTier, port, threads, force = false } = {}) {
    if (busy) return busy;
    aborter = new AbortController();
    busy = (async () => {
      try {
        const unchanged = state.phase === 'ready'
          && state.wanted === build && state.wantedModel === modelTier && child;
        if (unchanged && !force) return state;

        emit({
          wanted: build, wantedModel: modelTier, phase: 'downloading',
          message: '', progress: null, accel: null, device: ''
        });
        const got = await ensureBuild(build);
        const { file, model } = await ensureModel(modelTier);
        emit({ build: got.build.id, model: model.id, label: model.label });
        await launch({ build: got.build, exe: got.exe, modelFile: file, model, port, threads });
        await writeState({
          build: got.build.id, wanted: build, model: model.id, wantedModel: modelTier,
          modelFile: file, exe: got.exe, accel: state.accel, device: state.device, ts: Date.now()
        });
        return state;
      } catch (e) {
        if (isAbort(e)) {
          emit({ phase: 'idle', message: '', progress: null });
          return state;
        }
        emit({ phase: 'error', message: (e && e.message) || String(e), progress: null });
        throw e;
      } finally {
        aborter = null;
        busy = null;
      }
    })();
    return busy;
  }

  /** What a download will cost, asked of the servers rather than guessed. */
  async function estimate({ build, modelTier } = {}) {
    const { chain } = resolveBuild(build);
    const model = resolveModel(modelTier);
    let bytes = 0;
    let have = { build: false, model: false };

    for (const b of chain) {
      if (await findServer(path.join(binRoot, b.id))) { have.build = true; break; }
    }
    if (!have.build) {
      const b = chain[0];
      for (const url of b.assets) bytes += await assetSize(url);
      if (b.overlay) for (const url of b.overlay.urls) { bytes += await assetSize(url); break; }
    }
    if (await exists(path.join(modelRoot, model.file))) have.model = true;
    else for (const url of model.urls) { bytes += await assetSize(url); break; }

    return {
      bytes,
      mb: Math.round(bytes / 1048576),
      have,
      label: model.label,
      residentMB: footprintMB(model.id)
    };
  }

  /** Delete everything this engine downloaded. The user asked for the disk back. */
  async function purge() {
    stop();
    await fsp.rm(root, { recursive: true, force: true });
    emit({ phase: 'idle', build: null, model: null, label: '', message: '', progress: null });
  }

  /** Delete one model file, keeping the runtime, which is the cheap part. */
  async function removeModel(tier) {
    const model = resolveModel(tier);
    if (state.model === model.id) stop();
    await fsp.rm(path.join(modelRoot, model.file), { force: true });
  }

  return {
    ensure,
    stop,
    cancel,
    purge,
    removeModel,
    estimate,
    status: () => Object.assign({}, state, { running: !!child }),
    endpoint: () => state.endpoint,
    /**
     * The bearer token the running server demands.
     *
     * Deliberately not part of state: state is broadcast to the renderers on
     * every phase change, and a secret that rides along with a progress update
     * is a secret in more places than it needs to be. Only the code that has to
     * call the server asks for it.
     */
    key: () => apiKey,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async installed() {
      const saved = await readState();
      const builds = [];
      try {
        for (const e of await fsp.readdir(binRoot, { withFileTypes: true })) {
          if (e.isDirectory()) builds.push(e.name);
        }
      } catch { /* nothing installed yet */ }
      const models = [];
      try {
        for (const f of await fsp.readdir(modelRoot)) if (f.endsWith('.gguf')) models.push(f);
      } catch { /* nothing downloaded yet */ }
      return { builds, models, saved };
    }
  };
}

module.exports = { createEngine, findServer, DEFAULT_PORT };
