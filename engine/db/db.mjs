import {DatabaseSync} from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT UNIQUE,
  channel_id TEXT UNIQUE,
  uploads_playlist_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  permission_status TEXT NOT NULL DEFAULT 'unknown' CHECK (permission_status IN ('unknown','authorized','denied')),
  permission_basis TEXT,
  permission_recorded_at TEXT,
  facecam_rect TEXT,
  caption_fixes TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  video_id TEXT PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES creators(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  duration_s INTEGER,
  kind TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  blocked_reason TEXT,
  meta_json TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(video_id),
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  label TEXT,
  quote TEXT,
  risks_json TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  humor_type TEXT,
  review_json TEXT
);
CREATE TABLE IF NOT EXISTS moment_feedback (
  moment_id INTEGER NOT NULL REFERENCES moments(id),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (moment_id, label)
);
CREATE TABLE IF NOT EXISTS shorts (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(video_id),
  status TEXT NOT NULL,
  title TEXT,
  plan_json TEXT NOT NULL,
  style TEXT,
  compliance_json TEXT,
  metadata_json TEXT,
  verify_json TEXT,
  output_path TEXT,
  output_sha256 TEXT,
  progress REAL NOT NULL DEFAULT 0,
  fail_reason TEXT,
  render_count INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS short_moments (
  short_id INTEGER NOT NULL REFERENCES shorts(id),
  moment_id INTEGER NOT NULL REFERENCES moments(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (short_id, moment_id)
);
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY,
  short_id INTEGER NOT NULL UNIQUE REFERENCES shorts(id),
  state TEXT NOT NULL,
  visibility TEXT NOT NULL,
  slot_key TEXT,
  session_uri TEXT,
  video_id TEXT,
  reported_privacy TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, run_after);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quota_ledger (
  day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket)
);
`;

/** Columns added after the first release. Adding one never touches the rows already stored. */
const ADDED_COLUMNS = [
  ['moments', 'humor_type', 'TEXT'],
  ['moments', 'review_json', 'TEXT'],
];

export const now = () => new Date().toISOString();

/** Open (and create if needed) the database. Use ':memory:' in tests. */
export const openDb = (file) => {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  raw.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    if (!raw.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column)) {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  return {
    raw,
    get: (sql, ...params) => raw.prepare(sql).get(...params),
    all: (sql, ...params) => raw.prepare(sql).all(...params),
    run: (sql, ...params) => raw.prepare(sql).run(...params),
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => raw.close(),
  };
};

/** Append to the audit trail. Never throws: a logging failure must not break a job. */
export const logEvent = (db, level, message, {entity = null, id = null, data = null} = {}) => {
  try {
    db.run(
      'INSERT INTO events (ts, level, entity, entity_id, message, data_json) VALUES (?,?,?,?,?,?)',
      now(),
      level,
      entity,
      id === null ? null : String(id),
      message,
      data === null ? null : JSON.stringify(data),
    );
  } catch {
    // ignore
  }
};
