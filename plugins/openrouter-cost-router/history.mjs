import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const ROW = 'endpoint, recorded_at AS recordedAt, input, cached, writes, output, reasoning';

export function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function openHistory(path, scope) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS usage (
      sequence INTEGER PRIMARY KEY,
      scope TEXT NOT NULL,
      model TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      session TEXT,
      response TEXT,
      recorded_at INTEGER NOT NULL,
      input INTEGER NOT NULL,
      cached INTEGER NOT NULL,
      writes INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning INTEGER NOT NULL,
      UNIQUE (scope, response)
    );
    CREATE INDEX IF NOT EXISTS usage_model ON usage(scope, model, recorded_at, sequence);
    CREATE INDEX IF NOT EXISTS usage_session ON usage(scope, model, session, recorded_at, sequence);
  `);
  const recent = db.prepare(`SELECT ${ROW} FROM usage
    WHERE scope = ? AND model = ? AND recorded_at >= ?
    ORDER BY recorded_at DESC, sequence DESC LIMIT ?`);
  const lastForSession = db.prepare(`SELECT ${ROW} FROM usage
    WHERE scope = ? AND model = ? AND session = ?
    ORDER BY recorded_at DESC, sequence DESC LIMIT 1`);
  const byResponse = db.prepare(`SELECT ${ROW} FROM usage
    WHERE scope = ? AND model = ? AND response = ?`);
  const insert = db.prepare(`INSERT OR IGNORE INTO usage (
    scope, model, endpoint, session, response, recorded_at, input, cached, writes, output, reasoning
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.prepare('DELETE FROM usage WHERE scope = ? AND recorded_at < ?').run(scope, Date.now() - MAX_AGE_MS);

  return {
    recent(model, limit, now) {
      return recent.all(scope, model, now - MAX_AGE_MS, limit);
    },
    session(model, value) {
      return value ? lastForSession.get(scope, model, fingerprint(value)) : undefined;
    },
    response(model, value) {
      return value ? byResponse.get(scope, model, value) : undefined;
    },
    record({ model, endpoint, session, response, recordedAt, usage }) {
      insert.run(scope, model, endpoint, session ? fingerprint(session) : null,
        response ?? null, recordedAt, usage.input, usage.cached, usage.writes, usage.output, usage.reasoning);
    },
    close() { db.close(); },
  };
}
