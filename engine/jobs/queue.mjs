import {now} from '../db/db.mjs';

/** Thrown for failures that retrying cannot fix; the job goes straight to "dead". */
export class PermanentError extends Error {}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export const backoffMs = (attempts) => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

/** Add a job. With a key, a second enqueue of the same key is ignored. Returns true when added. */
export const enqueue = (db, type, payload, {key = null, runAfter = new Date(), maxAttempts = 4} = {}) =>
  db.run(
    'INSERT OR IGNORE INTO jobs (type, payload_json, idempotency_key, run_after, max_attempts, created_at) VALUES (?,?,?,?,?,?)',
    type,
    JSON.stringify(payload),
    key,
    runAfter.toISOString(),
    maxAttempts,
    now(),
  ).changes === 1;

/** Later pipeline stages go first, so work already started is finished before new work begins. */
const STAGE_ORDER = ['upload', 'produce', 'plan', 'analyze', 'transcript', 'discover'];
const PRIORITY_SQL = `CASE type ${STAGE_ORDER.map((type, i) => `WHEN '${type}' THEN ${i}`).join(' ')} ELSE ${STAGE_ORDER.length} END`;

/**
 * Take the ready job from the latest pipeline stage (oldest first within a stage) and mark it running, atomically.
 * `only` limits the claim to some job types and `except` leaves some out, so separate lanes can share one queue.
 */
export const claim = (db, at = new Date(), {only = null, except = null} = {}) =>
  db.tx(() => {
    const types = only ?? except ?? [];
    const filter = types.length > 0 ? `AND type ${only ? 'IN' : 'NOT IN'} (${types.map(() => '?').join(',')})` : '';
    const job = db.get(`SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ${filter} ORDER BY ${PRIORITY_SQL}, id LIMIT 1`, at.toISOString(), ...types);
    if (!job) {
      return null;
    }
    db.run("UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1 WHERE id = ?", at.toISOString(), job.id);
    return {...job, status: 'running', attempts: job.attempts + 1, payload: JSON.parse(job.payload_json)};
  });

export const complete = (db, id) =>
  db.run("UPDATE jobs SET status = 'succeeded', finished_at = ?, locked_at = NULL, last_error = NULL WHERE id = ?", now(), id);

/** Record a failure. Returns 'retry' when the job was rescheduled, 'dead' when it will not run again. */
export const fail = (db, job, err, at = new Date()) => {
  const message = String(err?.message ?? err).slice(0, 2000);
  if (err instanceof PermanentError || job.attempts >= job.max_attempts) {
    db.run("UPDATE jobs SET status = 'dead', finished_at = ?, locked_at = NULL, last_error = ? WHERE id = ?", at.toISOString(), message, job.id);
    return 'dead';
  }
  // An error can ask for a longer wait than the usual backoff, e.g. when a service is rate-limiting.
  const runAfter = new Date(at.getTime() + (err?.retryAfterMs ?? backoffMs(job.attempts))).toISOString();
  db.run("UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = ?, run_after = ? WHERE id = ?", message, runAfter, job.id);
  return 'retry';
};

/** After a crash, jobs left "running" go back to the queue. Handlers are idempotent, so this is safe. */
export const recoverStale = (db) => db.run("UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running'").changes;

export const retryJob = (db, id) =>
  db.run("UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, last_error = NULL, finished_at = NULL WHERE id = ? AND status = 'dead'", now(), id)
    .changes === 1;
