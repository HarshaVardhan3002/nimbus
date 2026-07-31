'use strict';
/**
 * Conversation history.
 *
 * Every response used to wipe the previous one: nothing persisted, no context
 * carried between turns. That made the app a one-shot query box rather than an
 * assistant -- you could not ask a follow-up, and closing the panel lost
 * everything.
 *
 * Storage is SQLite (see src/db.js). This module owns the *shape* of a
 * conversation and the rules about it; db.js owns the SQL. The split is what
 * makes the eventual move to Postgres a one-file change.
 *
 * A session is a plain object while it is being spoken:
 *
 *   { id, title, createdAt, updatedAt, messages: [{ role, content, ts, ... }] }
 *
 * `save()` is incremental -- it writes only the messages added since the last
 * call -- so persisting after every turn costs one INSERT rather than a rewrite
 * of the whole conversation.
 */

const path = require('path');
const { app } = require('electron');
const db = require('./db');

// Turns fed back to the model as context. Chosen against the measured local
// TTFT: every extra turn is prompt the model must re-read, and on a 622ms-warm
// local model a long history is the difference between snappy and sluggish.
// Callers can override per request.
const DEFAULT_CONTEXT_TURNS = 12;

// Sessions kept. Beyond this the oldest are pruned so the store cannot grow
// without bound on a machine that runs this for months.
const MAX_SESSIONS = 200;

// How many rows the list view asks for at once.
const PAGE = 60;

let ready = false;

/**
 * Open the database and absorb any JSON-era history.
 *
 * Returns false rather than throwing if the store is unusable: an assistant that
 * cannot remember is still an assistant, and taking the app down over it would
 * be the worse failure. Every function below degrades to a no-op in that case.
 */
function init() {
  const res = db.open();
  ready = res.ok;
  if (ready) {
    try { db.importLegacy(path.join(app.getPath('userData'), 'history')); }
    catch (e) { console.error('[nimbus] history import failed:', e && e.message); }
  }
  return ready;
}

function isReady() { return ready; }

/** Anything that reaches SQLite is wrapped: a store error must not reach the UI. */
function guard(fallback, fn) {
  if (!ready) return fallback;
  try { return fn(); } catch (e) {
    console.error('[nimbus] history:', e && e.message);
    return fallback;
  }
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

/**
 * How many of a session's messages are already on disk.
 *
 * Non-enumerable on purpose: the session object is sent to the renderer over
 * IPC, and bookkeeping the UI has no use for should not be part of that payload.
 */
function persisted(session, set) {
  if (set != null) {
    Object.defineProperty(session, '__persisted', { value: set, writable: true, enumerable: false, configurable: true });
    return set;
  }
  return session.__persisted || 0;
}

// ---------------------------------------------------------------- sessions
/**
 * A new session, in memory only.
 *
 * Nothing is written until the first message is saved, so opening the panel and
 * closing it again does not leave an empty conversation in the list.
 */
function create(firstText) {
  const now = Date.now();
  const session = { id: newId(), title: deriveTitle(firstText), createdAt: now, updatedAt: now, messages: [] };
  persisted(session, 0);
  return session;
}

function load(id) {
  return guard(null, () => {
    const s = db.getSession(String(id));
    if (s) persisted(s, s.messages.length);
    return s;
  });
}

/**
 * Write the messages added since the last save.
 *
 * Idempotent: the insert is keyed on (session, seq) and ignores conflicts, so
 * calling this twice for the same turn -- which happens when a request is
 * aborted after the reply already landed -- cannot duplicate a message.
 */
function save(session) {
  if (!session || !session.id || !session.messages.length) return false;
  return guard(false, () => {
    const from = persisted(session);
    session.updatedAt = Date.now();

    db.tx(db._conn(), () => {
      db.upsertSession(session);
      const pending = [];
      for (let i = from; i < session.messages.length; i++) {
        const m = session.messages[i];
        pending.push({
          seq: i,
          role: m.role,
          content: m.content,
          ts: m.ts || session.updatedAt,
          meta: metaOf(m)
        });
      }
      if (pending.length) db.insertMessages(session.id, pending);
    });

    persisted(session, session.messages.length);
    db.pruneSessions(MAX_SESSIONS);
    return true;
  });
}

/** Fields of a message that are annotation rather than content. */
function metaOf(m) {
  const out = {};
  for (const k of ['mode', 'model', 'provider', 'tier']) {
    if (m[k] != null) out[k] = m[k];
  }
  return Object.keys(out).length ? out : null;
}

function remove(id) {
  return guard(false, () => { db.deleteSession(String(id)); return true; });
}

function clearAll() {
  return guard(false, () => { db.deleteAllSessions(); return true; });
}

function rename(id, title) {
  return guard(false, () => {
    const s = db.getSession(String(id));
    if (!s) return false;
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    db.upsertSession({ id: s.id, title: clean || s.title, createdAt: s.createdAt, updatedAt: s.updatedAt });
    return true;
  });
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

/** Newest sessions first, with the counts and preview the list renders. */
function list(opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(MAX_SESSIONS, o.limit || PAGE));
  return guard([], () => db.listSessions(limit, Math.max(0, o.offset || 0)));
}

function count() {
  return guard(0, () => db.countSessions());
}

/**
 * Full-text search over every message, plus title matches.
 *
 * The JSON store did this by reading and parsing every session file on each
 * keystroke. This is an index lookup, so it stays instant as history grows --
 * which is what makes it usable as retrieval for an agent and not just a filter
 * on a short list.
 */
function search(query, limit = 40) {
  const q = String(query || '').trim();
  if (!q) return list({ limit });
  return guard([], () => db.searchMessages(q, limit));
}

module.exports = {
  MAX_SESSIONS, DEFAULT_CONTEXT_TURNS, PAGE,
  init, isReady,
  create, load, save, remove, clearAll, rename, append,
  contextTurns, search, list, count, deriveTitle
};
