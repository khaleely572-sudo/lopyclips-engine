import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {FEEDBACK_LABELS, buildCalibration, getFeedback, rankingEffect, setFeedback} from '../analysis/feedback.mjs';
import {startDashboard} from '../dashboard/server.mjs';
import {openDb} from '../db/db.mjs';
import {getSettings} from '../db/settings.mjs';
import {makeCreator, makeDb, makeMoment, makeShort, makeSource, silentLog} from './helpers.mjs';

const seed = () => {
  const db = makeDb();
  const source = makeSource(db, makeCreator(db, {authorized: true}).id);
  return {db, videoId: source.video_id};
};

test('the eight ratings the owner asked for are the ones offered', () => {
  assert.deepEqual(Object.values(FEEDBACK_LABELS), ['Genuinely funny', 'Not funny', 'Good sarcasm or witty remark', 'Good reaction', 'Good punchline', 'Missing context', 'Poor editing or bad clip boundaries', 'Duplicate or repetitive']);
});

test('ratings switch on and off, and a moment cannot be both funny and not funny', () => {
  const {db, videoId} = seed();
  const id = makeMoment(db, videoId, 100, 118);
  assert.deepEqual(setFeedback(db, id, 'funny'), ['funny']);
  assert.deepEqual(setFeedback(db, id, 'good_punchline'), ['funny', 'good_punchline']);
  assert.deepEqual(setFeedback(db, id, 'bad_boundaries'), ['bad_boundaries', 'funny', 'good_punchline'], 'a funny clip can still be badly cut');
  assert.deepEqual(setFeedback(db, id, 'not_funny'), ['bad_boundaries', 'not_funny'], 'choosing "not funny" clears the praise');
  assert.deepEqual(setFeedback(db, id, 'funny'), ['bad_boundaries', 'funny']);
  assert.deepEqual(setFeedback(db, id, 'funny', false), ['bad_boundaries']);
  assert.throws(() => setFeedback(db, id, 'hilarious'), /Unknown rating/);
  assert.throws(() => setFeedback(db, 9999, 'funny'), /not found/);
});

test('ratings reorder the pool of moments: disliked ones are passed over, liked ones go first', () => {
  assert.deepEqual(rankingEffect([]), {skip: false, boost: 0});
  assert.deepEqual(rankingEffect(['good_sarcasm']), {skip: false, boost: 1});
  for (const label of ['not_funny', 'missing_context', 'bad_boundaries', 'duplicate']) {
    assert.equal(rankingEffect(['funny', label]).skip, true, label);
  }
});

test('ratings become examples of the owner\'s taste and a small lean towards the kinds of humor they like', () => {
  const {db, videoId} = seed();
  const rate = (start, type, label) => {
    const id = makeMoment(db, videoId, start, start + 10);
    db.run('UPDATE moments SET humor_type = ?, quote = ? WHERE id = ?', type, `quote at ${start}`, id);
    setFeedback(db, id, label);
    return id;
  };
  assert.deepEqual(buildCalibration(db), {examples: [], typeBias: {}, rated: 0});
  rate(10, 'sarcasm', 'good_sarcasm');
  rate(20, 'sarcasm', 'funny');
  assert.deepEqual(buildCalibration(db).typeBias, {}, 'two ratings of a kind are not enough to lean on');
  rate(30, 'sarcasm', 'funny');
  rate(40, 'reaction', 'not_funny');
  rate(50, 'reaction', 'not_funny');
  rate(60, 'reaction', 'not_funny');
  rate(70, 'reaction', 'funny');
  rate(80, 'fail', 'duplicate');
  rate(90, 'banter', 'missing_context');
  const calibration = buildCalibration(db, (moment) => (moment.start_s === 10 ? 'the words that were actually said in the clip' : null));
  assert.deepEqual(calibration.typeBias, {sarcasm: 0.75, reaction: -0.38}, 'never more than three quarters of a point either way');
  assert.equal(calibration.rated, 9);
  assert.equal(calibration.examples.length, 8, 'four the owner liked and four they did not');
  assert.ok(calibration.examples.some((example) => example.verdict === 'FUNNY (good sarcasm or wit)' && example.text === 'the words that were actually said in the clip'));
  assert.ok(calibration.examples.some((example) => example.verdict === 'NOT FUNNY' && example.text === 'quote at 60'), 'falls back to the verified quote when the transcript is gone');
  assert.ok(calibration.examples.some((example) => example.verdict.startsWith('REJECT')));
  assert.ok(!calibration.examples.some((example) => example.text === 'quote at 80'), 'a duplicate says nothing about taste');
});

test('rating from the dashboard stores a note and changes nothing else', async (t) => {
  const {db, videoId} = seed();
  const shortId = makeShort(db, videoId, {status: 'awaiting_approval'});
  const server = startDashboard({db, log: silentLog}, {port: 0});
  await once(server, 'listening');
  t.after(() => server.close());
  const call = async (method, url, body, headers = {'X-LopyClips-Token': server.token}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body ? JSON.stringify(body) : undefined});
    return {status: res.status, body: await res.json().catch(() => null)};
  };
  assert.deepEqual((await call('GET', '/api/state')).body.feedbackLabels, FEEDBACK_LABELS);
  const [first] = (await call('GET', `/api/shorts/${shortId}`)).body.moments;
  assert.deepEqual(first.feedback, []);

  const settingsBefore = JSON.stringify(getSettings(db));
  const snapshot = () => JSON.stringify([db.all('SELECT * FROM shorts'), db.all('SELECT * FROM moments'), db.all('SELECT * FROM jobs'), db.all('SELECT * FROM uploads'), db.all('SELECT * FROM creators')]);
  const before = snapshot();
  assert.equal((await call('POST', `/api/moments/${first.id}/feedback`, {label: 'funny', on: true}, {})).status, 403, 'needs the page token like every other change');
  assert.deepEqual((await call('POST', `/api/moments/${first.id}/feedback`, {label: 'funny', on: true})).body, {feedback: ['funny']});
  assert.deepEqual((await call('POST', `/api/moments/${first.id}/feedback`, {label: 'good_reaction', on: true})).body, {feedback: ['funny', 'good_reaction']});
  assert.equal((await call('POST', `/api/moments/${first.id}/feedback`, {label: 'nonsense', on: true})).status, 400);
  assert.equal((await call('POST', `/api/moments/${first.id}/feedback`, {label: 'funny'})).status, 400, 'on or off must be stated');
  assert.equal((await call('POST', '/api/moments/9999/feedback', {label: 'funny', on: true})).status, 400);

  assert.equal(snapshot(), before, 'no Short, moment, job, upload or creator was touched');
  assert.equal(JSON.stringify(getSettings(db)), settingsBefore, 'no setting was touched');
  assert.equal(db.get('SELECT status, approved_at FROM shorts WHERE id = ?', shortId).status, 'awaiting_approval', 'praising a clip does not approve its Short');
  assert.deepEqual(getFeedback(db, first.id), ['funny', 'good_reaction']);
  assert.deepEqual((await call('GET', `/api/sources/${videoId}/moments`)).body.find((moment) => moment.id === first.id).feedback, ['funny', 'good_reaction']);
  assert.deepEqual((await call('POST', `/api/moments/${first.id}/feedback`, {label: 'funny', on: false})).body, {feedback: ['good_reaction']});
});

test('an existing database gains the new columns without losing a row', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-migrate-')), 'old.db');
  const old = new DatabaseSync(file);
  // The moments table exactly as the first release created it.
  old.exec(`CREATE TABLE moments (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, start_s REAL NOT NULL, end_s REAL NOT NULL, score REAL NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL, label TEXT, quote TEXT, risks_json TEXT, status TEXT NOT NULL DEFAULT 'candidate', reject_reason TEXT, created_at TEXT NOT NULL);
    INSERT INTO moments (source_id, start_s, end_s, score, confidence, reason, status, created_at) VALUES ('vid00000001', 10, 20, 7.4, 0.8, 'an old moment', 'used', '2026-10-01T00:00:00.000Z');`);
  old.close();
  const db = openDb(file);
  const row = db.get('SELECT * FROM moments');
  assert.deepEqual([row.reason, row.score, row.status, row.humor_type, row.review_json], ['an old moment', 7.4, 'used', null, null]);
  assert.deepEqual(db.all('SELECT * FROM moment_feedback'), []);
  db.close();
  openDb(file).close(); // opening it again is harmless
});
