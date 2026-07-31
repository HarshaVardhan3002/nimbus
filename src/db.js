'use strict';
/**
 * Local database.
 *
 * Chat history used to be a folder of JSON files: one index plus one file per
 * session. That works until you want to *retrieve* rather than just list --
 * searching meant reading and parsing every session on every keystroke, and a
 * crash between the two writes could leave the index disagreeing with the files.
 *
 * This is SQLite through `node:sqlite`, which Electron ships in its own Node
 * build. That matters: there is no compiled dependency, no electron-rebuild
 * step, and no ABI to break on the next Electron bump. `better-sqlite3` would
 * have been the same SQL and a native module in the installer.
 *
 * -------------------------------------------------------------- Postgres
 * The schema is deliberately portable, because the plan is to point this at
 * Postgres once an agent harness needs to share the store across processes.
 * Everything here is standard SQL except two things, and both are contained:
 *
 *   sessions/messages        portable as written. INTEGER epoch-millis columns
 *                            become BIGINT; INTEGER PRIMARY KEY AUTOINCREMENT
 *                            becomes BIGSERIAL.
 *   messages_fts (FTS5)      SQLite-only. The Postgres equivalent is a tsvector
 *                            column with a GIN index; `searchMessages` below is
 *                            the only function that touches it.
 *
 * Callers never see SQL. `history.js` talks to the functions exported here, so
 * a port replaces this file and nothing else.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SCHEMA_VERSION = 1;

let db = null;

/**
 * Open on first use, not at require time.
 *
 * Constructing a database is I/O, and this module is required from main.js's
 * top-level import block, which runs before anything has decided the app is
 * even going to start.
 */
function conn() {
  if (db) return db;

  // Required lazily too: on a runtime without it, the throw should happen here,
  // where `open()` can report it, rather than at import.
  const { DatabaseSync } = require('node:sqlite');

  const file = path.join(app.getPath('userData'), 'nimbus.db');
  db = new DatabaseSync(file);

  // WAL lets a reader run while a write is in flight. The write here is a chat
  // turn landing mid-stream and the reader is the history list, so without it
  // opening history during a reply can block on the writer.
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL rather than FULL: the cost of FULL is an fsync per commit, and the
  // worst case it buys back is losing the last turn after an OS-level crash.
  db.exec('PRAGMA synchronous = NORMAL');
  // Off by default in SQLite, and the messages -> sessions cascade depends on it.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 4000');

  migrate(db);
  return db;
}

/**
 * Schema migration, keyed on SQLite's `user_version`.
 *
 * Each step is applied in order and only once. Adding a step means appending to
 * the array and bumping SCHEMA_VERSION -- never editing an existing entry, since
 * databases in the field have already run it.
 */
function migrate(d) {
  const current = d.prepare('PRAGMA user_version').get().user_version || 0;
  if (current >= SCHEMA_VERSION) return;

  const steps = [
    // ---- 1: sessions, messages, full-text index -------------------------
    () => {
      d.exec(`
        CREATE TABLE sessions (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        CREATE INDEX sessions_updated ON sessions (updated_at DESC);

        CREATE TABLE messages (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
          seq         INTEGER NOT NULL,
          role        TEXT    NOT NULL,
          content     TEXT    NOT NULL,
          ts          INTEGER NOT NULL,
          meta        TEXT,
          UNIQUE (session_id, seq)
        );

        CREATE INDEX messages_session ON messages (session_id, seq);
      `);

      // External-content FTS: the index stores only the terms and points back at
      // messages.id, so message bodies are not duplicated on disk. The triggers
      // are what keep the two in step -- and they fire on cascade deletes too,
      // which is why deleting a session does not leave orphaned index rows.
      d.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content,
          content='messages',
          content_rowid='id',
          tokenize='unicode61'
        );

        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts (messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        END;

        CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts (messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
          INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
        END;
      `);
    }
  ];

  for (let v = current; v < SCHEMA_VERSION; v++) {
    tx(d, steps[v]);
    d.exec('PRAGMA user_version = ' + (v + 1));
  }
}

/**
 * Run `fn` in a transaction.
 *
 * node:sqlite has no transaction wrapper, and a chat turn is several statements
 * that must land together: a half-written turn would show a question with no
 * answer, or an answer attributed to nothing.
 */
function tx(d, fn) {
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* the failure that matters is `e` */ }
    throw e;
  }
}

/**
 * Open the database, reporting failure instead of throwing.
 *
 * A missing `node:sqlite` or an unwritable userData folder must not take the app
 * down -- history is a feature, not a prerequisite for answering a question. The
 * caller decides what to do with a false.
 */
function open() {
  try {
    conn();
    return { ok: true };
  } catch (e) {
    console.error('[nimbus] database unavailable:', e && e.message);
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function close() {
  if (!db) return;
  try { db.close(); } catch { /* ignore */ }
  db = null;
}

// ---------------------------------------------------------------- sessions
function upsertSession(s) {
  conn().prepare(`
    INSERT INTO sessions (id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
  `).run(s.id, s.title, s.createdAt, s.updatedAt);
}

function insertMessages(sessionId, rows) {
  const stmt = conn().prepare(`
    INSERT INTO messages (session_id, seq, role, content, ts, meta)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id, seq) DO NOTHING
  `);
  for (const r of rows) {
    stmt.run(sessionId, r.seq, r.role, r.content, r.ts, r.meta == null ? null : JSON.stringify(r.meta));
  }
}

/** Sessions newest first, with the counts and preview the list view renders. */
function listSessions(limit, offset) {
  return conn().prepare(`
    SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS count,
           (SELECT m.content FROM messages m WHERE m.session_id = s.id
              ORDER BY m.seq DESC LIMIT 1) AS preview
    FROM sessions s
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function countSessions() {
  return conn().prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
}

function getSession(id) {
  const s = conn().prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
    FROM sessions WHERE id = ?
  `).get(id);
  if (!s) return null;

  const rows = conn().prepare(`
    SELECT role, content, ts, meta FROM messages WHERE session_id = ? ORDER BY seq
  `).all(id);

  s.messages = rows.map((r) => {
    const m = { role: r.role, content: r.content, ts: r.ts };
    if (r.meta) { try { Object.assign(m, JSON.parse(r.meta)); } catch { /* ignore */ } }
    return m;
  });
  return s;
}

function messageCount(id) {
  const r = conn().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(id);
  return r ? r.n : 0;
}

function deleteSession(id) {
  conn().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function deleteAllSessions() {
  // Not TRUNCATE-by-drop: going through DELETE fires the FTS triggers, so the
  // full-text index is emptied along with the rows it points at.
  tx(conn(), () => {
    conn().prepare('DELETE FROM messages').run();
    conn().prepare('DELETE FROM sessions').run();
  });
}

/** Trim to the newest `max` sessions. Cascades to their messages and index rows. */
function pruneSessions(max) {
  conn().prepare(`
    DELETE FROM sessions WHERE id IN (
      SELECT id FROM sessions ORDER BY updated_at DESC LIMIT -1 OFFSET ?
    )
  `).run(max);
}

// ---------------------------------------------------------------- search
/**
 * User text as an FTS5 MATCH expression.
 *
 * Raw input cannot go in: FTS5 reads `-`, `*`, `"`, `NEAR` and friends as
 * operators, so searching for "gpt-4" is a syntax error rather than no results.
 * Every token is quoted (making it a literal) and given a trailing `*` so the
 * list filters as you type rather than only on whole words.
 */
function ftsQuery(text) {
  const terms = String(text || '')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => '"' + t + '"*').join(' AND ');
}

/**
 * Sessions matching `query`, ranked, with the matching excerpt.
 *
 * Title matches are unioned in separately: the FTS index covers message bodies,
 * and a session whose title matches but whose messages do not should still be
 * findable.
 */
function searchMessages(query, limit) {
  const match = ftsQuery(query);
  const like = '%' + String(query || '').replace(/[%_\\]/g, '\\$&') + '%';

  if (!match) return [];

  /**
   * Two CTEs rather than one, and MATERIALIZED rather than a plain WITH.
   *
   * FTS5's `rank` and `snippet()` are only valid in a SELECT that queries the
   * index directly -- put them under a GROUP BY and SQLite answers "unable to
   * use function snippet in the requested context". So `hits` reads them into
   * ordinary columns and `best` does the per-session aggregation on those.
   * MATERIALIZED is what stops the optimiser from folding the two back together
   * and reintroducing exactly that error.
   *
   * `best` leans on a documented SQLite behaviour: with MIN(), the bare columns
   * come from the row that produced the minimum, so the snippet belongs to the
   * best-ranked message. Postgres has no such rule -- the port is DISTINCT ON.
   */
  return conn().prepare(`
    WITH hits AS MATERIALIZED (
      SELECT m.session_id AS sid,
             messages_fts.rank AS r,
             snippet(messages_fts, 0, '', '', '…', 12) AS snip
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY messages_fts.rank
      LIMIT 500
    ),
    best AS (
      SELECT sid, MIN(r) AS r, snip FROM hits GROUP BY sid
    )
    SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS count,
           (SELECT m.content FROM messages m WHERE m.session_id = s.id
              ORDER BY m.seq DESC LIMIT 1) AS preview,
           b.snip AS snippet
    FROM sessions s
    LEFT JOIN best b ON b.sid = s.id
    WHERE b.sid IS NOT NULL OR s.title LIKE ? ESCAPE '\\'
    ORDER BY (b.r IS NULL), b.r, s.updated_at DESC
    LIMIT ?
  `).all(match, like, limit);
}

// ---------------------------------------------------------------- import
/**
 * One-time import of the JSON history folder this replaced.
 *
 * Runs only into an empty database, so it cannot duplicate on a later launch,
 * and the folder is renamed rather than deleted afterwards -- if the import got
 * something wrong, the original files are still there to look at.
 *
 * @returns {number} sessions imported
 */
function importLegacy(dir) {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  } catch {
    return 0;   // no legacy store, which is the normal case
  }
  if (!Array.isArray(index) || !index.length) return 0;
  if (countSessions() > 0) return 0;

  let done = 0;
  tx(conn(), () => {
    for (const entry of index) {
      const safe = String(entry && entry.id).replace(/[^a-z0-9]/gi, '');
      if (!safe) continue;
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(dir, safe + '.json'), 'utf8')); } catch { continue; }
      if (!s || !Array.isArray(s.messages)) continue;

      const created = Number(s.createdAt) || Date.now();
      upsertSession({
        id: safe,
        title: String(s.title || 'Conversation'),
        createdAt: created,
        updatedAt: Number(s.updatedAt) || created
      });
      insertMessages(safe, s.messages.map((m, i) => ({
        seq: i,
        role: String(m.role || 'user'),
        content: String(m.content == null ? '' : m.content),
        ts: Number(m.ts) || created,
        meta: metaOf(m)
      })));
      done++;
    }
  });

  if (done) {
    try { fs.renameSync(dir, dir + '.imported'); } catch { /* keeping the folder is harmless */ }
    console.log('[nimbus] imported ' + done + ' conversations from the JSON store');
  }
  return done;
}

/** The non-structural fields of a stored message, or null if there are none. */
function metaOf(m) {
  const out = {};
  for (const k of ['mode', 'model', 'provider', 'tier']) {
    if (m[k] != null) out[k] = m[k];
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  open, close, tx,
  upsertSession, insertMessages,
  listSessions, countSessions, getSession, messageCount,
  deleteSession, deleteAllSessions, pruneSessions,
  searchMessages,
  importLegacy,
  _conn: conn
};
