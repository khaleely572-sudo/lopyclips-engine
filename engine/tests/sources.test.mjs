import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildCaptions} from '../clipping/captions.mjs';
import {setPermission} from '../db/creators.mjs';
import {getSettings} from '../db/settings.mjs';
import {discoverCreator} from '../discovery/discover.mjs';
import {parseIsoDuration} from '../discovery/youtubeData.mjs';
import {PermanentError} from '../jobs/queue.mjs';
import {checkAccess} from '../sources/access.mjs';
import {MAX_SECTION_SECONDS, createYtdlpProvider} from '../sources/providers.mjs';
import {buildLines, parseJson3} from '../sources/transcript.mjs';
import {BASIS, makeCreator, makeDb} from './helpers.mjs';

const video = (videoId, overrides = {}) => ({videoId, title: `Stream ${videoId}`, channelTitle: 'Chan', publishedAt: new Date().toISOString(), liveState: 'none', durationS: 7200, wasLive: true, language: 'en', ...overrides});
const fakeYt = (videos) => ({
  resolveChannel: async () => ({channelId: 'UC123', title: 'Chan', uploadsPlaylistId: 'UU123'}),
  recentUploadIds: async () => videos.map((v) => v.videoId),
  videoDetails: async (ids) => videos.filter((v) => ids.includes(v.videoId)),
});
const jobsOfType = (db, type) => db.all('SELECT payload_json FROM jobs WHERE type = ?', type).map((row) => JSON.parse(row.payload_json));

test('permission needs an explicit status and a written basis', () => {
  assert.equal(checkAccess(null).allowed, false);
  assert.equal(checkAccess({permission_status: 'unknown'}).allowed, false);
  assert.equal(checkAccess({permission_status: 'denied', permission_basis: 'x'}).allowed, false);
  assert.equal(checkAccess({permission_status: 'authorized', permission_basis: '  '}).allowed, false);
  assert.equal(checkAccess({permission_status: 'authorized', permission_basis: BASIS}).allowed, true);
});

test('a creator cannot be authorized without a basis', () => {
  const db = makeDb();
  const creator = makeCreator(db);
  assert.throws(() => setPermission(db, creator.id, 'authorized', ''), /basis/);
  assert.equal(db.get('SELECT permission_status FROM creators WHERE id = ?', creator.id).permission_status, 'unknown');
});

test('a discovered video is stored with its original URL; without permission it is blocked and nothing is queued', async () => {
  const db = makeDb();
  const creator = makeCreator(db);
  const added = await discoverCreator(db, fakeYt([video('abcDEF12345')]), creator, getSettings(db));
  assert.equal(added.length, 1);
  const source = db.get('SELECT * FROM sources WHERE video_id = ?', 'abcDEF12345');
  assert.equal(source.url, 'https://www.youtube.com/watch?v=abcDEF12345');
  assert.equal(source.status, 'blocked');
  assert.match(source.blocked_reason, /permission/);
  assert.deepEqual(jobsOfType(db, 'transcript'), []);
});

test('an authorized creator\'s video is queued for analysis, and is not stored twice', async () => {
  const db = makeDb();
  const creator = makeCreator(db, {authorized: true});
  const yt = fakeYt([video('abcDEF12345')]);
  await discoverCreator(db, yt, creator, getSettings(db));
  await discoverCreator(db, yt, db.get('SELECT * FROM creators WHERE id = ?', creator.id), getSettings(db));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sources').n, 1);
  assert.equal(db.get('SELECT status FROM sources').status, 'discovered');
  assert.deepEqual(jobsOfType(db, 'transcript'), [{videoId: 'abcDEF12345'}]);
});

test('short videos are skipped and live ones are left for later', async () => {
  const db = makeDb();
  const creator = makeCreator(db, {authorized: true});
  await discoverCreator(db, fakeYt([video('short000001', {durationS: 300}), video('live0000001', {liveState: 'live'}), video('old00000001', {publishedAt: '2020-01-01T00:00:00Z'})]), creator, getSettings(db));
  const rows = Object.fromEntries(db.all('SELECT video_id, status FROM sources').map((row) => [row.video_id, row.status]));
  assert.deepEqual(rows, {short000001: 'skipped', old00000001: 'skipped'});
  assert.deepEqual(jobsOfType(db, 'transcript'), []);
});

test('a handle that leads to a channel with no uploads is a clear, final error', async () => {
  const db = makeDb();
  const creator = makeCreator(db);
  const empty = {...fakeYt([]), recentUploadIds: async () => null};
  await assert.rejects(discoverCreator(db, empty, creator, getSettings(db)), (err) => err instanceof PermanentError && /wrong handle/.test(err.message));
});

test('authorizing a creator later releases their blocked videos; revoking blocks them again', async () => {
  const db = makeDb();
  const creator = makeCreator(db);
  await discoverCreator(db, fakeYt([video('abcDEF12345')]), creator, getSettings(db));
  setPermission(db, creator.id, 'authorized', BASIS);
  assert.equal(db.get('SELECT status FROM sources').status, 'discovered');
  assert.deepEqual(jobsOfType(db, 'transcript'), [{videoId: 'abcDEF12345'}]);
  setPermission(db, creator.id, 'denied', 'asked to stop');
  assert.equal(db.get('SELECT status FROM sources').status, 'blocked');
});

test('the fetcher is never run for a creator without permission, and never for a long section', async () => {
  const calls = [];
  const provider = createYtdlpProvider({run: async (...args) => calls.push(args)});
  const source = {video_id: 'abcDEF12345'};
  await assert.rejects(provider.fetchCaptions({permission_status: 'unknown'}, source, '.'), PermanentError);
  await assert.rejects(provider.fetchSection({permission_status: 'unknown'}, source, 10, 30, 'x.mp4'), PermanentError);
  const allowed = {permission_status: 'authorized', permission_basis: BASIS};
  await assert.rejects(provider.fetchSection(allowed, source, 0, MAX_SECTION_SECONDS + 1, 'x.mp4'), /Refusing/);
  assert.equal(calls.length, 0, 'yt-dlp was never invoked');
});

test('captions: a file on disk is reused, a rate limit is a retry, and no captions is not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-captions-'));
  const allowed = {permission_status: 'authorized', permission_basis: BASIS};
  const source = {video_id: 'abcDEF12345'};
  const file = path.join(dir, 'abcDEF12345.en-orig.json3');

  let calls = 0;
  const limited = createYtdlpProvider({
    run: async () => {
      calls += 1;
      throw Object.assign(new Error('Command failed'), {stderr: "ERROR: Unable to download video subtitles for 'en-orig': HTTP Error 429: Too Many Requests"});
    },
  });
  await assert.rejects(limited.fetchCaptions(allowed, source, dir), (err) => /rate-limiting/.test(err.message) && err.retryAfterMs > 60_000);
  assert.equal(calls, 1, 'it does not keep asking once it is rate-limited');

  const none = createYtdlpProvider({run: async () => {}});
  assert.equal(await none.fetchCaptions(allowed, source, dir), null, 'both tracks asked for, neither exists');

  // yt-dlp wrote the file and then exited with an error: the file is still good.
  const partial = createYtdlpProvider({
    run: async () => {
      fs.writeFileSync(file, '{}');
      throw new Error('exit code 1');
    },
  });
  assert.equal(await partial.fetchCaptions(allowed, source, dir), file);

  const untouched = createYtdlpProvider({run: async () => assert.fail('no request should be made')});
  assert.equal(await untouched.fetchCaptions(allowed, source, dir), file);
});

test('durations and captions are parsed', () => {
  assert.equal(parseIsoDuration('PT2H49M51S'), 10191);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration('nonsense'), null);
  const words = parseJson3({events: [{tStartMs: 1000, segs: [{utf8: 'Hello', tOffsetMs: 0}, {utf8: ' there.', tOffsetMs: 400}]}, {tStartMs: 2000, segs: [{utf8: '\n'}]}, {tStartMs: 5000, segs: [{utf8: '>> What?'}]}]});
  assert.deepEqual(words.map((w) => [w.t, w.w]), [[1, 'Hello'], [1.4, 'there.'], [5, '>> What?']]);
  const lines = buildLines(words);
  assert.equal(lines.length, 2, 'a change of speaker starts a new line');
  assert.equal(lines[1].text, '>> What?');
});

test('captions are timed from the clip start, drop tags, and mute censored words', () => {
  const words = [
    {t: 9.5, e: 10, w: 'before'},
    {t: 10, e: 10.4, w: 'I'},
    {t: 10.4, e: 10.9, w: '[ __ ]'},
    {t: 10.9, e: 11.3, w: 'won.'},
    {t: 11.3, e: 12, w: '[laughter]'},
    {t: 12, e: 12.5, w: '[music]'},
    {t: 12.6, e: 13, w: '>> No.'},
    {t: 20, e: 20.5, w: 'after'},
  ];
  const captions = buildCaptions(words, 10, 15);
  assert.equal(captions.text, 'I won. No.');
  assert.equal(captions.censored, 1);
  assert.equal(captions.musicTags, 1);
  assert.deepEqual(captions.mutes, [[0.35, 0.85]]);
  assert.equal(captions.chunks[0].words[0].t, 0);
  assert.equal(captions.chunks.length, 2, 'a new speaker starts a new caption');
});
