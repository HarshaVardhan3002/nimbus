'use strict';
/**
 * Things fetched from the internet and unpacked: the download-verify-extract
 * plumbing, and the host allowlist that bounds it.
 *
 * This was written inside src/whisper/engine.js, which was the only thing that
 * downloaded anything. Nimbus now also fetches a llama.cpp build and a small
 * chat model, and a second copy of a *security-relevant* allowlist is how a
 * host gets added to one list and not the other. One copy, two callers.
 *
 * Nothing here knows what it is downloading. The catalogs decide what, this
 * decides how, and the engines decide what to do with the result.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/**
 * Only these hosts are ever fetched from, whatever a manifest asks for.
 *
 * The github pair is release assets and their redirect target; the huggingface
 * set is the model host and the CDNs it hands out. A URL that resolves anywhere
 * else is refused before a socket is opened, so a compromised or edited catalog
 * still cannot reach an arbitrary server.
 */
const HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.hf.co',
  'cas-bridge.xethub.hf.co'
];

function isAllowedURL(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

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

/** First file under root whose basename is one of `names`, case-insensitively. */
async function findBinary(root, names) {
  const wanted = names.map((n) => n.toLowerCase());
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
 *
 * `signal` is what makes a Cancel button real. Aborting mid-stream throws out
 * of the read loop and lands in the same cleanup path as a network failure, so
 * a cancelled download leaves nothing behind but the directory it was going to
 * live in.
 */
async function download(url, dest, onProgress, { signal } = {}) {
  if (!isAllowedURL(url)) throw new Error('refusing to download from ' + url);
  const res = await fetch(url, { redirect: 'follow', signal });
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

/** Size in bytes from a HEAD, or 0 when the server will not say. */
async function assetSize(url) {
  if (!isAllowedURL(url)) return 0;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok ? Number(res.headers.get('content-length') || 0) : 0;
  } catch {
    return 0;
  }
}

/** Hash a file we did not build, because a catalog says what it should be. */
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (b) => h.update(b));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = {
  HOSTS, isAllowedURL,
  mkdirp, exists, tarBin, extract, walk, findBinary,
  portFree, pickPort, download, assetExists, assetSize, sha256
};
