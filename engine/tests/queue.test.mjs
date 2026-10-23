import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {PermanentError, backoffMs, claim, complete, enqueue, fail, recoverStale, retryJob} from '../jobs/queue.mjs';
import {LANES, createWorker} from '../jobs/worker.mjs';
import {makeDb} from './helpers.mjs';

const statusOf = (db, id) => db.get('SELECT status FROM jobs WHERE id = ?', id).status;

test('a job with the same key is only queued once', () => {
  const db = makeDb();
  assert.equal(enqueue(db, 'upload', {shortId: 1}, {key: 'upload:1'}), true);
  assert.equal(enqueue(db, 'upload', {shortId: 1}, {key: 'upload:1'}), false);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM jobs').n, 1);
});

test('jobs are claimed oldest first and never twice', () => {
  const db = makeDb();
  enqueue(db, 'a', {n: 1});
  enqueue(db, 'b', {n: 2});
  assert.equal(claim(db).type, 'a');
  assert.equal(claim(db).type, 'b');
  assert.equal(claim(db), null);
});

test('later pipeline stages are claimed first, so a planned Short renders before more streams are analysed', () => {
  const db = makeDb();
  enqueue(db, 'transcript', {n: 1});
  enqueue(db, 'analyze', {n: 2});
  enqueue(db, 'analyze', {n: 3});
  enqueue(db, 'produce', {n: 4});
  enqueue(db, 'upload', {n: 5});
  const order = [];
  for (let job = claim(db); job; job = claim(db)) {
    order.push(`${job.type}:${job.payload.n}`);
  }
  assert.deepEqual(order, ['upload:5', 'produce:4', 'analyze:2', 'analyze:3', 'transcript:1']);
});

test('an error can ask for a longer wait before the retry', () => {
  const db = makeDb();
  const at = new Date('2026-10-13T10:00:00Z');
  enqueue(db, 'transcript', {}, {runAfter: at});
  const job = claim(db, at);
  fail(db, job, Object.assign(new Error('rate limited'), {retryAfterMs: 15 * 60_000}), at);
  assert.equal(claim(db, new Date(at.getTime() + 10 * 60_000)), null);
  assert.equal(claim(db, new Date(at.getTime() + 16 * 60_000)).type, 'transcript');
});

test('a job scheduled for later is not claimed early', () => {
  const db = makeDb();
  enqueue(db, 'later', {}, {runAfter: new Date(Date.now() + 60_000)});
  assert.equal(claim(db), null);
  assert.equal(claim(db, new Date(Date.now() + 120_000)).type, 'later');
});

test('a failing job backs off, retries, and dies at its attempt limit', () => {
  const db = makeDb();
  const at = new Date('2026-10-13T10:00:00Z');
  enqueue(db, 'flaky', {}, {maxAttempts: 2, runAfter: at});
  const first = claim(db, at);
  assert.equal(fail(db, first, new Error('network'), at), 'retry');
  assert.equal(claim(db, at), null, 'not retried before the backoff has passed');
  const second = claim(db, new Date(at.getTime() + backoffMs(1)));
  assert.equal(second.attempts, 2);
  assert.equal(fail(db, second, new Error('network again'), at), 'dead');
  assert.equal(statusOf(db, first.id), 'dead');
  assert.ok(backoffMs(3) > backoffMs(2) && backoffMs(50) <= 3_600_000);
});

test('a permanent error kills the job at once, and it can be retried by hand', () => {
  const db = makeDb();
  enqueue(db, 'blocked', {});
  const job = claim(db);
  assert.equal(fail(db, job, new PermanentError('not allowed')), 'dead');
  assert.equal(retryJob(db, job.id), true);
  assert.equal(statusOf(db, job.id), 'queued');
});

test('jobs left running by a crash go back to the queue', () => {
  const db = makeDb();
  enqueue(db, 'render', {});
  claim(db);
  assert.equal(recoverStale(db), 1);
  assert.equal(claim(db).type, 'render');
});

test('the queue survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-queue-')), 'q.db');
  let db = makeDb(file);
  enqueue(db, 'upload', {shortId: 7}, {key: 'upload:7'});
  db.close();
  db = makeDb(file);
  const job = claim(db);
  assert.deepEqual(job.payload, {shortId: 7});
  complete(db, job.id);
  assert.equal(statusOf(db, job.id), 'succeeded');
  db.close();
});

test('the worker only marks a job succeeded when its handler finishes', async () => {
  const db = makeDb();
  enqueue(db, 'good', {});
  enqueue(db, 'bad', {}, {maxAttempts: 1});
  enqueue(db, 'unknown', {});
  const worker = createWorker({
    db,
    handlers: {
      good: async () => {},
      bad: async () => {
        throw new Error('render crashed');
      },
    },
  });
  await worker.drain();
  const byType = Object.fromEntries(db.all('SELECT type, status, last_error FROM jobs').map((row) => [row.type, row]));
  assert.equal(byType.good.status, 'succeeded');
  assert.equal(byType.bad.status, 'dead');
  assert.match(byType.bad.last_error, /render crashed/);
  assert.equal(byType.unknown.status, 'dead');
});

test('the worker claims nothing while it is told not to run', async () => {
  const db = makeDb();
  enqueue(db, 'upload', {});
  let ran = 0;
  const worker = createWorker({db, handlers: {upload: async () => (ran += 1)}, canRun: () => false});
  await worker.drain();
  assert.equal(ran, 0);
  assert.equal(db.get('SELECT status FROM jobs').status, 'queued');
});

test('a lane only claims its own kinds of job', () => {
  const db = makeDb();
  enqueue(db, 'analyze', {n: 1});
  enqueue(db, 'upload', {n: 2});
  enqueue(db, 'produce', {n: 3});
  assert.equal(claim(db, new Date(), {only: ['produce', 'transcript']}).type, 'produce');
  assert.equal(claim(db, new Date(), {only: ['produce', 'transcript']}), null);
  assert.equal(claim(db, new Date(), {except: ['upload', 'discover', 'produce', 'transcript']}).type, 'analyze');
  assert.equal(claim(db, new Date(), {except: ['upload', 'discover', 'produce', 'transcript']}), null, 'the upload is left for its own lane');
  assert.equal(claim(db, new Date(), {only: ['upload', 'discover']}).type, 'upload');
});

test('a long analysis does not hold up a scheduled upload or a render', async () => {
  const db = makeDb();
  let finishAnalysis;
  const analysing = new Promise((resolve) => (finishAnalysis = resolve));
  const done = [];
  const worker = createWorker({
    db,
    idleMs: 5,
    lanes: LANES,
    handlers: {
      analyze: async () => {
        await analysing;
        done.push('analyze');
      },
      upload: async () => done.push('upload'),
      produce: async () => done.push('produce'),
      plan: async () => done.push('plan'),
    },
  });
  enqueue(db, 'analyze', {});
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(statusOf(db, 1), 'running');
  enqueue(db, 'upload', {});
  enqueue(db, 'produce', {});
  enqueue(db, 'plan', {});
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual([...done].sort(), ['produce', 'upload'], 'both ran while the analysis was still going');
  assert.equal(statusOf(db, 4), 'queued', 'planning waits its turn behind the analysis, in the same lane');
  finishAnalysis();
  await new Promise((resolve) => setTimeout(resolve, 60));
  worker.stop();
  assert.deepEqual(done.slice(2), ['analyze', 'plan']);
  assert.deepEqual(db.all('SELECT status FROM jobs').map((row) => row.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
});
