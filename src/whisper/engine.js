'use strict';
/**
 * The local transcription engine: fetch it, assemble it, run it, watch it.
 *
 * Nimbus ships no inference binary and no weights. On first run the hardware
 * probe picks a build, this module downloads that build and a model sized to
 * the machine, starts whisper.cpp's server on loopback and health-checks it.
 * src/stt.js then talks to it over the same HTTP path it uses for any other
 * local server, so nothing downstream knows the difference.
 *
 * "Assemble" rather than "install" because the accelerated builds are a base
 * archive plus a backend DLL copied in beside the server binary -- see the
 * catalog for why. That overlay step is the only unusual part of an otherwise
 * ordinary download-verify-launch cycle.
 *
 * Everything lives under <userData>/whisper, so clearing user data clears the
 * models too, and a corrupt install is fixed by deleting one directory.
 *
 * State machine: idle -> downloading -> extracting -> starting -> ready,
 * with error as an absorbing state that ensure() can be called out of.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { resolveBuild, resolveModel, isAllowedURL } = require('./catalog');

const HEALTH_TIMEOUT_MS = 180000;   // a cold large model off a slow disk, first run
const HEALTH_POLL_MS = 750;
const MAX_RESTARTS = 3;

// ------------------------------------------------------------------- helpers
const mkdirp = (dir) => fsp.mkdir(dir, { recursive: true });

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * bsdtar, by absolute path on Windows.
 *
 * Windows has shipped bsdtar as System32\tar.exe since build 17063 and it
 * reads zip. The absolute path matters: a developer machine with git or MSYS
 * ahead on PATH resolves plain `tar` to GNU tar, which cannot read zip at all.
 */
function tarBin() {
  if (process.platform !== 'win32') return 'tar';
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(sys) ? sys : 'tar';
}

function extract(archive, dest) {
  return new Promise((resolve, reject) => {
    execFile(tarBin(), ['-xf', archive, '-C', dest],
      { windowsHide: true, timeout: 600000 },
      (err, _out, stderr) => {
        if (err) reject(new Error('unpack failed: ' + ((stderr || '').trim().split('\n')[0] || err.message)));
        else resolve();
      });
  });
}

/** Every file under root, as absolute paths. */
async function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

/** The server binary, wherever the archive chose to put it. */
async function findServer(root) {
  const wanted = process.platform === 'win32'
    ? ['whisper-server.exe', 'server.exe']
    : ['whisper-server', 'server'];
  for (const f of await walk(root)) {
    if (wanted.includes(path.basename(f).toLowerCase())) return f;
  }
  return null;
}

/** True when nothing is listening, i.e. the port is ours to take. */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 12; p++) {
    if (await portFree(p)) return p;
  }
  return preferred;
}

/**
 * Download to a .part file, then rename.
 *
 * The rename is the commit: a half-written model can never be mistaken for a
 * complete one, however the app died mid-transfer.
 */
async function download(url, dest, onProgress) {
  if (!isAllowedURL(url)) throw new Error('refusing to download from ' + url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' for ' + path.basename(new URL(url).pathname));
    err.status = res.status;
    throw err;
  }
  const total = Number(res.headers.get('content-length') || 0);
  const part = dest + '.part';
  await mkdirp(path.dirname(dest));
  const out = fs.createWriteStream(part);
  let done = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!out.write(Buffer.from(chunk))) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress(done, total);
    }
    await new Promise((ok, bad) => { out.end(); out.once('finish', ok); out.once('error', bad); });
  } catch (e) {
    out.destroy();
    await fsp.rm(part, { force: true });
    throw e;
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  return { bytes: done, total };
}

/** HEAD, to find out whether an asset exists before committing to a download. */
async function assetExists(url) {
  if (!isAllowedURL(url)) return false;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- engine
function createEngine({ userDataDir, log = () => {} } = {}) {
  const root = path.join(userDataDir, 'whisper');
  const binRoot = path.join(root, 'bin');
  const modelRoot = path.join(root, 'models');
  const tmpRoot = path.join(root, 'tmp');
  const statePath = path.join(root, 'state.json');

  const listeners = new Set();
  let child = null;
  let restarts = 0;
  let busy = null;               // in-flight ensure(), so two callers cannot race
  let state = {
    phase: 'idle',               // idle | downloading | extracting | starting | ready | error
    build: null,                 // build actually installed, which may be a fallback
    wanted: null,                // build asked for
    model: null,
    family: null,                // weights actually loaded: whisper | crisper
    wantedFamily: null,
    port: 0,
    endpoint: '',
    message: '',
    accel: null,                 // did the accelerated backend really load
    device: '',                  // what the backend reported, e.g. the GPU name
    progress: null               // { what, done, total }
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

  // ------------------------------------------------------------- installing
  /**
   * Copy a backend into place beside the server binary.
   *
   * The overlay archive is llama.cpp's build of the same ggml the whisper
   * release was cut from, and only the files named in `pick` are taken -- the
   * rest of that archive is a whole second inference stack we have no use for.
   */
  async function applyOverlay(overlay, serverDir, onProgress) {
    const stage = path.join(tmpRoot, 'overlay-' + Date.now());
    await mkdirp(stage);
    try {
      let unpacked = false;
      for (const url of overlay.urls) {
        if (!(await assetExists(url))) continue;
        emit({ phase: 'downloading', message: 'Downloading the GPU backend...' });
        const archive = path.join(stage, path.basename(new URL(url).pathname));
        await download(url, archive, (done, total) => {
          emit({ progress: { what: 'backend', done, total } });
          if (onProgress) onProgress('backend', done, total);
        });
        emit({ phase: 'extracting', message: 'Unpacking the GPU backend...', progress: null });
        await extract(archive, stage);
        await fsp.rm(archive, { force: true });
        unpacked = true;
        break;
      }
      if (!unpacked) throw new Error('no backend archive available');

      const files = await walk(stage);
      let required = !overlay.require;
      let copied = 0;
      for (const f of files) {
        const name = path.basename(f);
        if (!overlay.pick.some((re) => re.test(name))) continue;
        await fsp.copyFile(f, path.join(serverDir, name));
        copied++;
        if (overlay.require && overlay.require.test(name)) required = true;
      }
      // Some backends need a data directory alongside their DLL, not just the DLL.
      for (const re of overlay.dirs || []) {
        for (const d of files.map((f) => path.dirname(f))) {
          const rel = path.relative(stage, d);
          if (!re.test(rel)) continue;
          await fsp.cp(d, path.join(serverDir, rel), { recursive: true, force: true });
        }
      }
      if (!copied || !required) throw new Error('backend archive did not contain the expected library');
      return copied;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Get a build on disk, walking the fallback chain when a tier cannot be had.
   *
   * Returns the build that actually landed, which is not always the one asked
   * for: upstream publishes no accelerated asset for every combination, and a
   * machine running one tier down beats a machine with no transcription.
   */
  async function ensureBuild(wantedId, onProgress) {
    const { chain } = resolveBuild(wantedId);
    const errors = [];

    for (const build of chain) {
      const dir = path.join(binRoot, build.id);
      const cached = await findServer(dir);
      if (cached) {
        // An overlay build is only complete if its backend library is still there.
        const ok = !build.overlay || !build.overlay.require
          || (await fsp.readdir(path.dirname(cached))).some((f) => build.overlay.require.test(f));
        if (ok) return { build, exe: cached, cached: true };
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }

      let landed = null;
      for (const url of build.assets) {
        try {
          if (!(await assetExists(url))) { errors.push(build.id + ': no asset ' + path.basename(url)); continue; }
          emit({ phase: 'downloading', message: 'Downloading the ' + build.label + ' build...' });
          await mkdirp(dir);
          const archive = path.join(dir, path.basename(new URL(url).pathname));
          await download(url, archive, (done, total) => {
            emit({ progress: { what: 'build', done, total } });
            if (onProgress) onProgress('build', done, total);
          });
          emit({ phase: 'extracting', message: 'Unpacking the ' + build.label + ' build...', progress: null });
          await extract(archive, dir);
          await fsp.rm(archive, { force: true });
          const exe = await findServer(dir);
          if (!exe) { errors.push(build.id + ': archive had no server binary'); continue; }
          landed = exe;
          break;
        } catch (e) {
          errors.push(build.id + ': ' + ((e && e.message) || String(e)));
        }
      }

      if (landed && build.overlay) {
        try {
          await applyOverlay(build.overlay, path.dirname(landed), onProgress);
        } catch (e) {
          errors.push(build.id + ': ' + ((e && e.message) || String(e)));
          landed = null;
        }
      }
      if (landed) return { build, exe: landed, cached: false };

      // Nothing usable at this tier; leave no half-unpacked directory behind.
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    throw new Error('no usable build. ' + errors.join('; '));
  }

  /**
   * Shrink an f16 model in place with the quantizer that ships in every build.
   *
   * CrisperWhisper is only published at full precision, and a 1.6 GB model on a
   * machine that was sized for a 600 MB one is the difference between a warm
   * model and one that pages. Quantising costs a minute once; the f16 is dropped
   * afterwards so the disk cost is the small file, not both.
   */
  function quantize(exeDir, src, dest, type) {
    const bin = path.join(exeDir, process.platform === 'win32' ? 'whisper-quantize.exe' : 'whisper-quantize');
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(bin)) return reject(new Error('no quantizer in this build'));
      execFile(bin, [src, dest, type], { windowsHide: true, timeout: 1200000 },
        (err, _out, stderr) => {
          if (err) reject(new Error('quantize failed: ' + ((stderr || '').trim().split('\n').pop() || err.message)));
          else resolve(dest);
        });
    });
  }

  /** Hash a file we did not build, because the catalog says what it should be. */
  function sha256(file) {
    return new Promise((resolve, reject) => {
      const h = require('crypto').createHash('sha256');
      const rs = fs.createReadStream(file);
      rs.on('data', (b) => h.update(b));
      rs.on('error', reject);
      rs.on('end', () => resolve(h.digest('hex')));
    });
  }

  /**
   * Get the weights on disk, in the family that was asked for where possible.
   *
   * The stock Whisper weights are the floor: if the preferred family cannot be
   * downloaded, verified or quantised, the tier is served by Whisper rather than
   * left with nothing. Every failure is reported, since silently transcribing
   * with a different model than the settings pane claims is worse than slow.
   */
  async function ensureModel(tier, language, family, exeDir, onProgress) {
    const attempts = [];
    const first = resolveModel(tier, language, family);
    attempts.push(first);
    if (first.family !== 'whisper') attempts.push(resolveModel(tier, language, 'whisper'));

    const errors = [];
    for (const model of attempts) {
      const raw = path.join(modelRoot, model.file);
      const dest = model.quantize ? path.join(modelRoot, model.quantized) : raw;
      if (await exists(dest)) return { file: dest, id: model.id, family: model.family, cached: true };

      // A full-precision file left over from a quantisation that failed last
      // time is worth a gigabyte and a half; re-verify it rather than re-fetch.
      const urls = (await exists(raw)) ? [null].concat(model.urls) : model.urls;
      for (const url of urls) {
        try {
          if (url) {
            emit({
              phase: 'downloading',
              message: 'Downloading the ' + model.familyLabel + ' ' + model.label
                + ' model (' + model.approxMB + ' MB)...'
            });
            await download(url, raw, (done, total) => {
              emit({ progress: { what: 'model', done, total } });
              if (onProgress) onProgress('model', done, total);
            });
          }

          if (model.sha256) {
            emit({ phase: 'extracting', message: 'Verifying the model...', progress: null });
            const got = await sha256(raw);
            if (got !== model.sha256) {
              await fsp.rm(raw, { force: true });
              throw new Error('checksum mismatch (' + got.slice(0, 12) + ')');
            }
          }

          if (model.quantize) {
            emit({ phase: 'extracting', message: 'Quantising the model...', progress: null });
            try {
              await quantize(exeDir, raw, dest, model.quantize);
              await fsp.rm(raw, { force: true });
            } catch (e) {
              // Usable at full precision; keep it rather than throw the download away.
              log('whisper: ' + ((e && e.message) || String(e)) + ', keeping f16');
              return { file: raw, id: model.id, family: model.family, cached: false, quantized: false };
            }
          }
          return { file: dest, id: model.id, family: model.family, cached: false };
        } catch (e) {
          errors.push(model.family + ': ' + ((e && e.message) || String(e)));
        }
      }
    }
    throw new Error('model download failed. ' + errors.join('; '));
  }

  // ---------------------------------------------------------------- running
  async function health(port, deadline) {
    while (Date.now() < deadline) {
      if (!child) return false;                  // it died while we were waiting
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/', { method: 'GET' });
        if (res.ok || res.status === 404) return true;   // 404 still proves it speaks HTTP
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
    if (state.phase !== 'error') emit({ phase: 'idle', endpoint: '', message: '', accel: null, device: '' });
  }

  /**
   * Start the server and prove the accelerator is live.
   *
   * whisper-server announces its backends on startup, so the log is the only
   * honest way to know whether the Vulkan DLL we copied in actually bound to a
   * device: ggml falls back to CPU inside the same process, silently, if it
   * cannot. Anything else would report "GPU" on machines that are not using one.
   */
  async function launch({ build, exe, modelFile, port, threads }) {
    stop();
    restarts = 0;
    const chosen = await pickPort(port || 8081);
    const args = [
      '-m', modelFile,
      '--host', '127.0.0.1',
      '--port', String(chosen),
      '-t', String(threads || Math.max(2, Math.min(8, Math.floor((os.cpus() || []).length / 2))))
    ];
    emit({ phase: 'starting', port: chosen, message: 'Starting the transcription server...', progress: null });
    log('whisper: ' + path.basename(exe) + ' ' + args.join(' '));

    child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onLine = (b) => {
      const line = String(b).trim();
      if (!line) return;
      log('whisper: ' + line);
      if (build.backendLog && build.backendLog.test(line)) {
        const dev = build.deviceLog && build.deviceLog.exec(line);
        emit({ accel: true, device: (dev && dev[1].trim()) || state.device });
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('exit', (code) => {
      const wasReady = state.phase === 'ready';
      child = null;
      if (restarts >= MAX_RESTARTS) return;
      if (wasReady) {
        // Crashed in service. Retry a bounded number of times, then stay down.
        restarts++;
        log('whisper: server exited (' + code + '), restart ' + restarts + '/' + MAX_RESTARTS);
        setTimeout(() => { launch({ build, exe, modelFile, port: chosen, threads }).catch(() => {}); },
          1500 * restarts);
      } else {
        emit({ phase: 'error', message: 'The transcription server exited with code ' + code + '.' });
      }
    });

    const ok = await health(chosen, Date.now() + HEALTH_TIMEOUT_MS);
    if (!ok) {
      stop();
      emit({ phase: 'error', message: 'The transcription server did not answer on port ' + chosen + '.' });
      throw new Error('health check failed');
    }
    emit({
      phase: 'ready',
      port: chosen,
      endpoint: 'http://127.0.0.1:' + chosen,
      message: '',
      accel: build.backendLog ? !!state.accel : false
    });
    return chosen;
  }

  /**
   * Bring the engine up to match the settings and the hardware decision.
   *
   * Safe to call repeatedly: a no-op once the requested build and model are
   * already running, which is what lets it serve as both the first-run
   * installer and the settings-changed handler.
   */
  async function ensure({ build, modelTier, language, family, port, threads, force = false } = {}) {
    if (busy) return busy;
    busy = (async () => {
      try {
        const unchanged = state.phase === 'ready'
          && state.wanted === build && state.model === modelTier
          && state.wantedFamily === family && child;
        if (unchanged && !force) return state;

        emit({
          wanted: build, wantedFamily: family, phase: 'downloading',
          message: '', progress: null, accel: null, device: ''
        });
        const got = await ensureBuild(build);
        const model = await ensureModel(modelTier, language, family, path.dirname(got.exe));
        emit({ build: got.build.id, model: modelTier, family: model.family });
        await launch({ build: got.build, exe: got.exe, modelFile: model.file, port, threads });
        await writeState({
          build: got.build.id, wanted: build, model: modelTier, modelFile: model.file,
          family: model.family, wantedFamily: family,
          exe: got.exe, accel: state.accel, device: state.device, ts: Date.now()
        });
        return state;
      } catch (e) {
        emit({ phase: 'error', message: (e && e.message) || String(e), progress: null });
        throw e;
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  /** Delete an installed build so the next ensure() fetches it again. */
  async function purge(buildId) {
    stop();
    await fsp.rm(path.join(binRoot, buildId), { recursive: true, force: true });
  }

  return {
    ensure,
    stop,
    purge,
    status: () => Object.assign({}, state, { running: !!child }),
    endpoint: () => state.endpoint,
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
        for (const f of await fsp.readdir(modelRoot)) if (f.endsWith('.bin')) models.push(f);
      } catch { /* nothing downloaded yet */ }
      return { builds, models, saved };
    }
  };
}

module.exports = { createEngine, findServer, portFree, tarBin };
