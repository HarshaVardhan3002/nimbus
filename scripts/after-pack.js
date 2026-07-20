'use strict';
/**
 * electron-builder afterPack hook.
 *
 * Stamps the app icon onto the exe. This runs immediately after packing and
 * BEFORE the code-signing step, which matters here: on a machine without
 * Developer Mode the winCodeSign package cannot extract (it contains macOS
 * symlinks), electron-builder exits non-zero, and any `&& node set-icon.js`
 * chained after it never runs. Doing it in the hook means the icon is applied
 * regardless of whether signing later fails.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findRcedit() {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache)) {
    const p = path.join(cache, dir, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exe = path.join(context.appOutDir, (context.packager.appInfo.productFilename || 'Nimbus') + '.exe');
  const icon = path.join(__dirname, '..', 'build', 'icon.ico');
  if (!fs.existsSync(exe) || !fs.existsSync(icon)) return;

  const rc = findRcedit();
  if (!rc) { console.log('  • icon skipped, rcedit not cached yet'); return; }

  try {
    execFileSync(rc, [exe, '--set-icon', icon]);
    console.log('  • icon applied  ' + path.basename(icon));
  } catch (e) {
    console.log('  • icon failed: ' + (e && e.message));
  }
};
