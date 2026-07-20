#!/usr/bin/env node
'use strict';
/**
 * Stamp the app icon onto the built exe.
 *
 * electron-builder normally does this itself, but on a machine without
 * Developer Mode the winCodeSign package fails to extract -- it contains macOS
 * symlinks and creating those needs a privilege a standard user does not have.
 * rcedit lives inside that same package, so the icon step is skipped silently
 * and the build ships with the default Electron atom.
 *
 * This finds a cached rcedit and applies the icon directly. Run after `pack`
 * or `dist`.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'Nimbus.exe');
const ICON = path.join(__dirname, '..', 'build', 'icon.ico');

function findRcedit() {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache)) {
    const p = path.join(cache, dir, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

if (process.platform !== 'win32') { console.log('[icon] not windows, skipping'); process.exit(0); }
if (!fs.existsSync(EXE))  { console.error('[icon] no exe at ' + EXE); process.exit(1); }
if (!fs.existsSync(ICON)) { console.error('[icon] no icon at ' + ICON); process.exit(1); }

const rc = findRcedit();
if (!rc) {
  console.error('[icon] rcedit not found in the electron-builder cache.');
  console.error('[icon] Run a full `npm run dist` once so it downloads, or enable Developer Mode.');
  process.exit(1);
}

execFileSync(rc, [EXE, '--set-icon', ICON], { stdio: 'inherit' });
console.log('[icon] applied ' + path.basename(ICON) + ' to ' + path.basename(EXE));
