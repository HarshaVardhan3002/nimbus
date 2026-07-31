#!/usr/bin/env node
'use strict';
/**
 * Conversation store tests.
 *
 * Runs outside Electron by stubbing the one Electron API the store uses
 * (`app.getPath`) and pointing it at a throwaway folder, so this needs no
 * window, no display and no user data.
 *
 * The cases worth keeping are the ones that already caught something: FTS5
 * refusing `snippet()` under a GROUP BY, and raw user text hitting `MATCH` as
 * an operator expression. Both looked correct on the page.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-db-'));

const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => USERDATA } };
  return realLoad.apply(this, arguments);
};

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

// ---- seed a legacy JSON store so the import path is covered -------------
const legacy = path.join(USERDATA, 'history');
fs.mkdirSync(legacy, { recursive: true });
fs.writeFileSync(path.join(legacy, 'index.json'), JSON.stringify([
  { id: 'oldone', title: 'Old thread', createdAt: 1000, updatedAt: 2000, count: 2, preview: 'x' }
]));
fs.writeFileSync(path.join(legacy, 'oldone.json'), JSON.stringify({
  id: 'oldone', title: 'Old thread', createdAt: 1000, updatedAt: 2000,
  messages: [
    { role: 'user', content: 'what is a kubernetes ingress', ts: 1000, mode: 'ask' },
    { role: 'assistant', content: 'An ingress routes external HTTP traffic.', ts: 1500, model: 'gpt-4o' }
  ]
}));

const history = require(path.join(ROOT, 'src/history.js'));
const db = require(path.join(ROOT, 'src/db.js'));

console.log('\n  history store\n  ' + '-'.repeat(58));

check('init opens the database', history.init() === true);
check('legacy JSON imported', history.count() === 1, 'count=' + history.count());
check('legacy folder renamed, not deleted', fs.existsSync(legacy + '.imported'));
check('imported messages survive', (history.load('oldone') || { messages: [] }).messages.length === 2);
check('imported meta survives', (history.load('oldone').messages[0] || {}).mode === 'ask');

// ---- a live conversation -----------------------------------------------
const s = history.create('How do I fix a CORS error in Express?');
// deriveTitle only capitalises the first character; it does not case-fold the
// rest, which is what keeps "CORS" and "Express" readable.
check('title derived from first message', s.title === 'How do I fix a CORS error in Express?', s.title);
check('empty session is not persisted', history.save(s) === false);

history.append(s, 'user', 'How do I fix a CORS error in Express?', { mode: 'ask' });
check('first save writes', history.save(s) === true);
check('count is now 2', history.count() === 2, 'count=' + history.count());

history.append(s, 'assistant', 'Use the cors middleware and set origin.', { model: 'llama3', provider: 'ollama' });
check('incremental save writes only the new turn', history.save(s) === true);
const round = history.load(s.id);
check('round trip keeps both messages', round.messages.length === 2, 'len=' + round.messages.length);
check('round trip keeps order', round.messages[0].role === 'user' && round.messages[1].role === 'assistant');
check('round trip keeps meta', round.messages[1].model === 'llama3');

// Saving twice must not duplicate.
history.save(s);
history.save(s);
check('repeat save is idempotent', history.load(s.id).messages.length === 2);

// `__persisted` bookkeeping must not leak over IPC.
check('bookkeeping is non-enumerable', !Object.keys(s).includes('__persisted'));
check('bookkeeping absent from JSON', !JSON.stringify(s).includes('__persisted'));

// ---- search -------------------------------------------------------------
check('body search finds a message', history.search('middleware').some((r) => r.id === s.id));
check('title search finds a session', history.search('Old thread').some((r) => r.id === 'oldone'));
check('prefix search matches as you type', history.search('kubern').some((r) => r.id === 'oldone'));
check('search returns a snippet', !!(history.search('ingress').find((r) => r.id === 'oldone') || {}).snippet);
check('no match returns empty', history.search('zzzzzznothing').length === 0);

// The reason raw input cannot go straight into MATCH.
for (const nasty of ['gpt-4', 'a"b', 'NEAR(', 'x AND', '*', '-foo', 'c++']) {
  let threw = null;
  try { history.search(nasty); } catch (e) { threw = e.message; }
  check('operator-ish query "' + nasty + '" does not throw', threw === null, threw || '');
}

// ---- list ---------------------------------------------------------------
const list = history.list();
check('list is newest first', list[0].id === s.id, list.map((x) => x.id).join(','));
check('list carries a message count', list[0].count === 2);
check('list carries a preview', typeof list[0].preview === 'string' && list[0].preview.length > 0);
check('list respects limit', history.list({ limit: 1 }).length === 1);
check('list respects offset', history.list({ limit: 1, offset: 1 })[0].id === 'oldone');

// ---- rename -------------------------------------------------------------
check('rename works', history.rename(s.id, '  CORS   in Express  ') === true);
check('rename normalises whitespace', history.load(s.id).title === 'CORS in Express');
check('rename of a missing id is false', history.rename('nope', 'x') === false);

// ---- delete -------------------------------------------------------------
check('delete removes the session', history.remove('oldone') === true && history.load('oldone') === null);
check('delete clears the search index', history.search('kubernetes').length === 0);

// ---- prune --------------------------------------------------------------
const conn = db._conn();
const before = history.count();
for (let i = 0; i < 5; i++) {
  const t = history.create('filler ' + i);
  history.append(t, 'user', 'filler body ' + i);
  history.save(t);
}
check('sessions accumulate', history.count() === before + 5);
db.pruneSessions(3);
check('prune keeps the newest N', history.count() === 3, 'count=' + history.count());
const orphans = conn.prepare(
  'SELECT COUNT(*) n FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)'
).get().n;
check('prune cascades to messages', orphans === 0, 'orphans=' + orphans);

// ---- clear --------------------------------------------------------------
history.clearAll();
check('clear empties the store', history.count() === 0);
check('clear empties the index', history.search('filler').length === 0);

db.close();
console.log('  ' + '-'.repeat(58));
console.log('  ' + failures + ' failures\n');
try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures ? 1 : 0);
