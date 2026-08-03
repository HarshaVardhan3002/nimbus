#!/usr/bin/env node
'use strict';
/**
 * Build integrity check.
 *
 * Catches the class of bug that a syntax check cannot: an IPC channel the
 * renderer sends that nobody handles, a preload allowlist entry main never
 * emits, a <script src> pointing at a file that no longer exists, or a leftover
 * call into an API that was deleted in the refactor. All of those fail silently
 * at runtime.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];
const warnings = [];
const ok = [];

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

const files = walk('.');
const jsFiles = files.filter((f) => f.endsWith('.js'));

// ---------------------------------------------------------------- 1. syntax
for (const f of jsFiles) {
  try {
    new (require('vm').Script)(read(f), { filename: f });
    ok.push('parse ' + f);
  } catch (e) {
    problems.push('SYNTAX ' + f + ': ' + e.message);
  }
}

// ------------------------------------------------------- 1b. source hygiene
/**
 * A control character written into source as a literal byte rather than an
 * escape. This is not cosmetic: git classifies a file containing NUL as binary,
 * which silently disables line-ending normalisation, `git diff` and `git blame`
 * for that file. It happened here -- a NUL separator in a template literal
 * was written as a raw NUL, and the whole file started staging as a rewrite.
 *
 * Tab and the CR of a CRLF pair are legitimate; nothing else below 0x20 is.
 */
const sourceFiles = files.filter((f) => /\.(js|css|html|json|md)$/.test(f));
for (const f of sourceFiles) {
  const buf = fs.readFileSync(path.join(ROOT, f));
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 || b === 0x09 || b === 0x0a) continue;
    if (b === 0x0d && buf[i + 1] === 0x0a) continue;
    const line = buf.slice(0, i).toString('utf8').split('\n').length;
    problems.push(
      'CONTROL CHAR ' + f + ':' + line + ': raw byte 0x' + b.toString(16).padStart(2, '0')
      + ' in source. Write it as an escape, or use a printable delimiter.'
    );
    break;   // one report per file is enough to act on
  }
}
if (!problems.some((p) => p.startsWith('CONTROL CHAR'))) {
  ok.push('hygiene: no raw control bytes in ' + sourceFiles.length + ' source files');
}

// ---------------------------------------------------------------- 2. ipc parity
const preload = read('preload.js');
const mainSrc = read('main.js');

const uniq = (a) => Array.from(new Set(a));
const grab = (src, re) => {
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return uniq(out);
};

const rendererSends = grab(preload, /ipcRenderer\.send\(\s*'([^']+)'/g);
const rendererInvokes = grab(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g);
const mainOn = grab(mainSrc, /ipcMain\.on\(\s*'([^']+)'/g);
const mainHandle = grab(mainSrc, /ipcMain\.handle\(\s*'([^']+)'/g);

for (const c of rendererSends) {
  if (!mainOn.includes(c)) problems.push('IPC: preload sends "' + c + '" but main has no ipcMain.on for it');
}
for (const c of rendererInvokes) {
  if (!mainHandle.includes(c)) problems.push('IPC: preload invokes "' + c + '" but main has no ipcMain.handle for it');
}
for (const c of mainOn) {
  if (!rendererSends.includes(c)) warnings.push('IPC: main handles "' + c + '" which preload never sends');
}
for (const c of mainHandle) {
  if (!rendererInvokes.includes(c)) warnings.push('IPC: main handles "' + c + '" which preload never invokes');
}
ok.push('ipc: ' + rendererSends.length + ' send + ' + rendererInvokes.length + ' invoke channels matched');

// ---------------------------------------------------------------- 3. inbound allowlist
const inboundBlock = /const INBOUND = \[([\s\S]*?)\];/.exec(preload);
const inbound = inboundBlock
  ? uniq(inboundBlock[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean))
  : [];

const allSrc = jsFiles.map(read).join('\n');
const emitted = uniq([
  ...grab(allSrc, /broadcast\(\s*'([^']+)'/g),
  ...grab(allSrc, /toPanel\(\s*'([^']+)'/g),
  ...grab(allSrc, /sendToPanel\(\s*'([^']+)'/g),
  ...grab(allSrc, /webContents\.send\(\s*'([^']+)'/g),
  ...grab(allSrc, /onEvent\(\s*'([^']+)'/g)
]);

for (const c of inbound) {
  if (!emitted.includes(c)) warnings.push('INBOUND: preload allows "' + c + '" but nothing in main emits it');
}

// Matches whatever the bridge is bound to. This regex hardcoded `cue.on` and
// silently matched nothing after the rename to `app.on`, reporting "0 listeners
// all allowlisted" as a pass. A check that can quietly validate nothing is
// worse than no check, so it now also asserts it found something.
const rendererListens = uniq(grab(
  [read('renderer/pill/pill.js'), read('renderer/panel/panel.js')].join('\n'),
  /\b(?:app|cue|nimbus)\.on\(\s*'([^']+)'/g
));
if (rendererListens.length === 0) {
  problems.push('INBOUND: found zero renderer listeners, the detection regex is stale');
}
for (const c of rendererListens) {
  if (!inbound.includes(c)) problems.push('INBOUND: a renderer listens for "' + c + '" but preload does not allow it — it will never fire');
}
ok.push('inbound: ' + rendererListens.length + ' renderer listeners all allowlisted');

// ---------------------------------------------------------------- 4. dead api refs
const REMOVED = [
  'setIgnoreMouseEvents', 'micPcm', 'systemPcm', 'captureToggle', 'captureState',
  'openPane', 'setZoomLevel', 'pcm-processor', 'showExample', 'obScrim'
];

/**
 * Strip comments before scanning. Half this refactor's comments explain which
 * API was removed and why, so a naive substring scan flags the documentation
 * as the bug. Word boundaries matter too: 'openPane' is a prefix of the very
 * much alive 'openPanel'.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * The pre-split renderer (renderer/renderer.js, index.html, styles.css,
 * pcm-processor.js) was deleted rather than kept as an exemption list: it was
 * packaged by the `renderer/**` glob, so dead code was shipping in the
 * installer, and an exemption list only makes stale files permanent.
 */
const SUPERSEDED = [];

for (const f of jsFiles.concat(files.filter((x) => x.endsWith('.html')))) {
  if (f.startsWith('scripts/')) continue;
  if (SUPERSEDED.includes(f)) continue;
  const src = stripComments(read(f));
  for (const sym of REMOVED) {
    const re = new RegExp('\\b' + sym.replace(/[-]/g, '\\-') + '\\b');
    if (re.test(src)) problems.push('DEAD API: ' + f + ' still references "' + sym + '" in live code');
  }
}
ok.push('dead-api: no live code references a removed symbol (comments excluded)');

// ------------------------------------------------- 4b. geometry invariant
/**
 * Regression guard for the drag-creep bug.
 *
 * setBounds -> getBounds is not an identity on Windows (DIP/physical rounding,
 * plus stale frame metrics after an ex-style change). Any code that spreads a
 * readback back into setBounds inside a loop compounds that error once per
 * iteration. _dragTick runs at 125Hz, so a single drag inflated the window by a
 * visible amount toward the bottom-right.
 *
 * The invariant: manager.js owns exactly one setBounds call, inside _place(),
 * and _place states all four values explicitly.
 */
{
  const mgrRaw = read('src/windows/manager.js');
  const mgr = stripComments(mgrRaw);
  const calls = (mgr.match(/\.setBounds\(/g) || []).length;
  if (calls !== 1) {
    problems.push('GEOMETRY: manager.js has ' + calls + ' setBounds calls; exactly 1 is allowed (inside _place)');
  }
  const spreads = (mgr.match(/setBounds\(\s*\{\s*\.\.\./g) || []).length;
  if (spreads > 0) {
    problems.push('GEOMETRY: manager.js spreads a getBounds() readback into setBounds ' + spreads + 'x — this compounds rounding error every call and inflates the window on drag');
  }
  if (!/_place\(win, x, y, w, h\)/.test(mgr)) {
    problems.push('GEOMETRY: _place(win, x, y, w, h) helper is missing from manager.js');
  }
  ok.push('geometry: single explicit setBounds via _place(); no readback is fed back in');
}

// ------------------------------------------------- 4c. renderer <-> markup
/**
 * Every id a renderer selects must exist in its own document, and vice versa
 * for interactive ids.
 *
 * The settings screen once shipped with tab markup but no showTab(), so the
 * groups stayed display:none and the panel rendered as an empty box. Syntax was
 * valid, the asar contained the markup, and nothing caught it.
 */
{
  const pairs = [
    ['renderer/panel/panel.js', 'renderer/panel/index.html'],
    ['renderer/pill/pill.js',   'renderer/pill/index.html']
  ];
  for (const [js, html] of pairs) {
    const code = stripComments(read(js));
    const markup = read(html);
    const used = new Set();
    let m;
    const re = /\$\('#([a-zA-Z0-9_-]+)'\)/g;
    while ((m = re.exec(code))) used.add(m[1]);

    const dead = [...used].filter((id) => !markup.includes('id="' + id + '"'));
    if (dead.length) {
      problems.push('MARKUP: ' + js + ' selects #' + dead.join(', #') + ' which do not exist in ' + html);
    }

    // Buttons in the markup that nothing ever wires up.
    const btnIds = [];
    const bre = /<button[^>]*\bid="([a-zA-Z0-9_-]+)"/g;
    while ((m = bre.exec(markup))) btnIds.push(m[1]);
    const orphan = btnIds.filter((id) => !code.includes("'#" + id + "'"));
    if (orphan.length) {
      warnings.push('MARKUP: ' + html + ' has unwired button(s) #' + orphan.join(', #'));
    }
  }
  ok.push('markup: renderer selectors and document ids agree');
}

// ---------------------------------------------------------------- 5. html assets
for (const f of files.filter((x) => x.endsWith('.html'))) {
  if (f === 'renderer/index.html') continue; // superseded original
  const src = read(f);
  const dir = path.dirname(f);
  const refs = [
    ...grab(src, /<script src="([^"]+)"/g),
    ...grab(src, /<link rel="stylesheet" href="([^"]+)"/g)
  ];
  for (const r of refs) {
    const target = path.join(dir, r).split(path.sep).join('/');
    if (!exists(target)) problems.push('ASSET: ' + f + ' references missing file "' + r + '" (resolved ' + target + ')');
  }
}
ok.push('assets: every script/stylesheet reference resolves');

// ---------------------------------------------------------------- 6. package
const pkg = JSON.parse(read('package.json'));
if (!exists(pkg.main)) problems.push('PKG: main entry "' + pkg.main + '" does not exist');
for (const dep of ['koffi', 'openai', '@anthropic-ai/sdk', '@google/genai']) {
  if (!pkg.dependencies[dep]) problems.push('PKG: missing dependency ' + dep);
}
if (pkg.build && pkg.build.mac) problems.push('PKG: build.mac config still present in a Windows-only app');
if (pkg.build && pkg.build.asar && !(pkg.build.asarUnpack || []).some((p) => p.includes('koffi'))) {
  problems.push('PKG: asar is on but koffi is not unpacked — the native .node will not load from inside asar');
}
ok.push('package: entry, deps and asar/koffi config valid');

// ---------------------------------------------------------------- 7. settings/registry coherence
const storeSrc = read('src/store.js');
const provSrc = read('src/providers.js');
const registryIds = grab(provSrc, /^\s{2}(\w+):\s*\{$/gm);
for (const id of ['ollama', 'lmstudio', 'openai', 'anthropic', 'gemini', 'nvidia']) {
  if (!provSrc.includes(id + ':')) problems.push('REGISTRY: provider "' + id + '" missing from providers.js');
  if (!storeSrc.includes(id + ':')) problems.push('STORE: no default model entry for provider "' + id + '"');
}
ok.push('registry: all built-in providers present in both registry and store defaults');

// ------------------------------------------------- 7b. storage seam
/**
 * All SQL lives in src/db.js.
 *
 * The store is SQLite now and is meant to become Postgres when an agent harness
 * needs to share it across processes. That port is a one-file change only for as
 * long as no other module writes a query -- and the natural place for the first
 * leak is history.js, which sits directly on top of it.
 */
{
  // Case-sensitive on purpose. SQL here is written in upper case, while the
  // lower-case spellings are ordinary JavaScript: a case-insensitive `SELECT`
  // flags every `element.select()` in the renderer.
  const sqlUsers = jsFiles.filter((f) => {
    if (f === 'src/db.js' || f.startsWith('scripts/')) return false;
    return /\b(SELECT\b[\s\S]{0,400}?\bFROM|INSERT\s+INTO|DELETE\s+FROM|CREATE\s+TABLE|UPDATE\s+\w+\s+SET)\b/
      .test(stripComments(read(f)));
  });
  if (sqlUsers.length) {
    problems.push('STORAGE: SQL outside src/db.js in ' + sqlUsers.join(', ')
      + ' — keep queries in the storage module so the Postgres port stays one file');
  }

  const sqliteUsers = jsFiles.filter((f) => f !== 'src/db.js' && /require\('node:sqlite'\)/.test(read(f)));
  if (sqliteUsers.length) {
    problems.push('STORAGE: ' + sqliteUsers.join(', ') + ' requires node:sqlite directly; go through src/db.js');
  }
  ok.push('storage: SQL and the sqlite driver are confined to src/db.js');
}

// ------------------------------------------------- 7c. text contrast
/**
 * Is the text still readable over somebody else's desktop?
 *
 * A translucent window has no fixed background, so "does this look fine" is a
 * question about whatever the author happened to have open. This composites the
 * real tokens -- surface over backdrop, scrim over surface, text over that --
 * against four deliberately hostile backdrops and applies WCAG AA.
 *
 * It reads glass.css rather than duplicating the numbers, so moving a token
 * moves the test with it. If this fails, the fix is the token, not the test.
 */
{
  const css = read('renderer/shared/glass.css');

  const rgba = (s) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(s);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  // Tokens are declared per theme, so the block has to be sliced before the
  // lookup: a plain search finds obsidian's copy every time.
  const block = (name) => {
    const i = css.indexOf(name);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };
  const tok = (scope, name) => {
    const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(scope);
    return m ? rgba(m[1]) : null;
  };

  // src over dst, both straight alpha, dst opaque.
  const over = (src, dst) => ({
    r: src.a * src.r + (1 - src.a) * dst.r,
    g: src.a * src.g + (1 - src.a) * dst.g,
    b: src.a * src.b + (1 - src.a) * dst.b,
    a: 1
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const BACKDROPS = [
    ['white document', { r: 255, g: 255, b: 255, a: 1 }],
    ['black video', { r: 0, g: 0, b: 0, a: 1 }],
    ['mid grey', { r: 128, g: 128, b: 128, a: 1 }],
    ['saturated brand colour', { r: 255, g: 214, b: 0, a: 1 }]
  ];
  // tx-3 is placeholders and dim hints, held to the large-text floor rather than
  // the body-text one; it is never the only copy of anything.
  const FLOORS = { 'tx-1': 4.5, 'tx-2': 4.5, 'tx-3': 3.0 };

  const themes = [
    ['obsidian', block("html[data-theme='obsidian']")],
    ['porcelain', block("html[data-theme='porcelain']")]
  ];
  // Both glass modes matter: the translucent one is the weak case, the shaped
  // one is the default.
  const MODES = [['glass', 'bg-glass', 'scrim'], ['shaped', 'bg-solid', 'scrim-firm']];

  let worst = { ratio: Infinity, where: '' };
  for (const [themeName, scope] of themes) {
    for (const [modeName, surfaceTok, scrimTok] of MODES) {
      const surface = tok(scope, surfaceTok);
      const scrim = tok(scope, scrimTok);
      if (!surface || !scrim) {
        problems.push('CONTRAST: ' + themeName + ' is missing --' + surfaceTok + ' or --' + scrimTok);
        continue;
      }
      for (const [txName, floor] of Object.entries(FLOORS)) {
        const text = tok(scope, txName);
        if (!text) { problems.push('CONTRAST: ' + themeName + ' is missing --' + txName); continue; }
        for (const [bdName, bd] of BACKDROPS) {
          const under = over(scrim, over(surface, bd));
          const r = ratio(over(text, under), under);
          const where = themeName + '/' + modeName + ' ' + txName + ' over ' + bdName;
          if (r < worst.ratio) worst = { ratio: r, where };
          if (r < floor) {
            problems.push('CONTRAST: ' + where + ' is ' + r.toFixed(2) + ':1, below the '
              + floor + ':1 floor — raise --' + scrimTok + ' for ' + themeName);
          }
        }
      }
    }
  }
  if (Number.isFinite(worst.ratio)) {
    ok.push('contrast: worst text/background pair is ' + worst.ratio.toFixed(2) + ':1 ('
      + worst.where + ')');
  }

  // The scrim only does anything where it is actually mounted.
  const legibleUsers = ['renderer/panel/index.html', 'renderer/pill/index.html']
    .filter((f) => /class="[^"]*\blegible\b/.test(read(f)));
  if (legibleUsers.length < 2) {
    problems.push('CONTRAST: the .legible scrim is not applied in '
      + ['renderer/panel/index.html', 'renderer/pill/index.html']
        .filter((f) => !legibleUsers.includes(f)).join(', '));
  }
}

// ---------------------------------------------------------------- report
const line = (s) => process.stdout.write(s + '\n');
line('');
line('  cue build check');
line('  ' + '-'.repeat(58));
for (const o of ok) line('  ok    ' + o);
for (const w of warnings) line('  warn  ' + w);
for (const p of problems) line('  FAIL  ' + p);
line('  ' + '-'.repeat(58));
line('  ' + jsFiles.length + ' js files, ' + problems.length + ' problems, ' + warnings.length + ' warnings');
line('');
process.exit(problems.length ? 1 : 0);
