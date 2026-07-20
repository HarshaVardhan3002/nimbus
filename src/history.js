'use strict';
/**
 * Conversation history.
 *
 * Until now every response wiped the previous one: `clearMessages()` on each
 * `llm:start`, nothing persisted, no context carried between turns. That makes
 * the app a one-shot query box rather than an assistant -- you could not ask a
 * follow-up, and closing the panel lost everything.
 *
 * Storage shape:
 *
 *   userData/history/index.json        [{ id, title, createdAt, updatedAt, count, preview }]
 *   userData/history/<id>.json         { id, title, createdAt, updatedAt, messages: [...] }
 *
 * One file per session rather than one big file, because the index is what the
 * list view reads and it must stay small no matter how much history exists.
 * Loading a session is then a single read of only that session.
 *
 * Writes are atomic (temp + rename) for the same reason as settings: a
 * half-written session file that fails to parse would silently vanish.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DIR = path.join(app.getPath('userData'), 'history');
const INDEX = path.join(DIR, 'index.json');

// Turns fed back to the model as context. Chosen against the measured local
// TTFT: every extra turn is prompt the model must re-read, and on a 622ms-warm
// local model a long history is the difference between snappy and sluggish.
// Callers can override per request.
const DEFAULT_CONTEXT_TURNS = 12;

// Sessions kept on disk. Beyond this the oldest are pruned so the store cannot
// grow without bound on a machine that runs this for months.
const MAX_SESSIONS = 200;

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
}

function writeAtomic(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('[nimbus] history write failed:', e && e.message);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * A title derived from the first user message.
 *
 * Cheap and deterministic: asking a model to name the session would cost a
 * round trip on every new conversation, which on a cold local model is 15s.
 */
function deriveTitle(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New conversation';
  const cut = t.length > 52 ? t.slice(0, 51).replace(/\s\S*$/, '') + '…' : t;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

// ---------------------------------------------------------------- index
function loadIndex() {
  const idx = readJSON(INDEX, []);
  return Array.isArray(idx) ? idx : [];
}

function saveIndex(idx) {
  return writeAtomic(INDEX, idx.slice(0, MAX_SESSIONS));
}

function sessionFile(id) {
  // `id` is generated internally, but it is also accepted over IPC, so it is
  // constrained rather than trusted -- a crafted id must not escape the folder.
  const safe = String(id).replace(/[^a-z0-9]/gi, '');
  return path.join(DIR, safe + '.json');
}

// ---------------------------------------------------------------- sessions
function create(firstText) {
  const now = Date.now();
  const session = {
    id: newId(),
    title: deriveTitle(firstText),
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  return session;
}

function load(id) {
  const s = readJSON(sessionFile(id), null);
  if (!s || !Array.isArray(s.messages)) return null;
  return s;
}

function save(session) {
  if (!session || !session.id) return false;
  session.updatedAt = Date.now();
  const ok = writeAtomic(sessionFile(session.id), session);
  if (!ok) return false;

  const idx = loadIndex().filter((e) => e.id !== session.id);
  const last = session.messages[session.messages.length - 1];
  idx.unshift({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    count: session.messages.length,
    preview: last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 90) : ''
  });

  // Prune beyond the cap, deleting the files too so the folder does not keep
  // growing after the index forgets about them.
  const keep = idx.slice(0, MAX_SESSIONS);
  for (const gone of idx.slice(MAX_SESSIONS)) {
    try { fs.unlinkSync(sessionFile(gone.id)); } catch { /* ignore */ }
  }
  saveIndex(keep);
  return true;
}

function remove(id) {
  try { fs.unlinkSync(sessionFile(id)); } catch { /* ignore */ }
  saveIndex(loadIndex().filter((e) => e.id !== id));
  return true;
}

function clearAll() {
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(DIR, f));
    }
  } catch { /* ignore */ }
  saveIndex([]);
  return true;
}

function append(session, role, content, meta) {
  if (!session) return session;
  const msg = { role, content: String(content == null ? '' : content), ts: Date.now() };
  if (meta) Object.assign(msg, meta);
  session.messages.push(msg);
  // The first user message names the session.
  if (role === 'user' && session.messages.filter((m) => m.role === 'user').length === 1) {
    session.title = deriveTitle(content);
  }
  return session;
}

/**
 * Prior turns formatted for the model.
 *
 * Returns [{ role, text }] excluding the message currently being composed.
 * Assistant turns are included so follow-ups actually resolve pronouns; without
 * them "explain that differently" has nothing to refer to.
 */
function contextTurns(session, limit) {
  if (!session || !Array.isArray(session.messages)) return [];
  const n = typeof limit === 'number' ? limit : DEFAULT_CONTEXT_TURNS;
  if (n <= 0) return [];
  return session.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .slice(-n)
    .map((m) => ({ role: m.role, text: m.content }));
}

/**
 * Substring search across titles and message bodies.
 *
 * Reads every session file, so it is linear in history size. At the 200-session
 * cap that is fine; a larger cap would want an inverted index instead.
 */
function search(query, limit = 40) {
  const q = String(query || '').trim().toLowerCase();
  const idx = loadIndex();
  if (!q) return idx.slice(0, limit);

  const out = [];
  for (const entry of idx) {
    if (out.length >= limit) break;
    if (entry.title.toLowerCase().includes(q)) { out.push({ ...entry, hit: 'title' }); continue; }
    const s = load(entry.id);
    if (!s) continue;
    const m = s.messages.find((x) => String(x.content || '').toLowerCase().includes(q));
    if (m) {
      const body = String(m.content);
      const at = body.toLowerCase().indexOf(q);
      out.push({ ...entry, hit: 'body', snippet: body.slice(Math.max(0, at - 30), at + 70).replace(/\s+/g, ' ') });
    }
  }
  return out;
}

module.exports = {
  DIR, MAX_SESSIONS, DEFAULT_CONTEXT_TURNS,
  create, load, save, remove, clearAll, append,
  contextTurns, search, list: loadIndex, deriveTitle
};
