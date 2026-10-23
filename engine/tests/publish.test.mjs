import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {SessionExpiredError, uploadVideoResumable} from '../../scripts/youtube/youtube.mjs';
import {setPermission} from '../db/creators.mjs';
import {getSettings, setSetting} from '../db/settings.mjs';
import {PermanentError} from '../jobs/queue.mjs';
import {quotaUsed, recordQuota} from '../publish/quota.mjs';
import {inQuietHours, nextSlots, pickForSlot, slotKeyAt, tick} from '../publish/scheduler.mjs';
import {uploadShort} from '../publish/uploader.mjs';
import {goLive, makeCreator, makeDb, makeShort, makeSource, silentLog} from './helpers.mjs';

// Asia/Riyadh is UTC+3 all year: 11:00 UTC is 14:00 there, an even hour, so a slot.
const SLOT = new Date('2026-10-13T11:00:00Z');
const NOT_SLOT = new Date('2026-10-13T12:00:00Z');

const world = ({authorized = true} = {}) => {
  const db = makeDb();
  const creator = makeCreator(db, {authorized});
  const source = makeSource(db, creator.id);
  return {db, creator, source};
};
const uploadJobs = (db) => db.all("SELECT payload_json FROM jobs WHERE type = 'upload'").map((row) => JSON.parse(row.payload_json).shortId);

test('slots fall on even hours in Riyadh time, within the first minutes of the hour', () => {
  const settings = getSettings(makeDb());
  assert.equal(slotKeyAt(SLOT, settings), '2026-10-13T14');
  assert.equal(slotKeyAt(new Date('2026-10-13T11:14:00Z'), settings), '2026-10-13T14');
  assert.equal(slotKeyAt(new Date('2026-10-13T11:20:00Z'), settings), null);
  assert.equal(slotKeyAt(NOT_SLOT, settings), null);
  assert.equal(slotKeyAt(new Date('2026-10-13T21:00:00Z'), settings), '2026-10-14T00', 'the local day rolls over');
  const upcoming = nextSlots(SLOT, settings, 3);
  assert.deepEqual(upcoming.map((slot) => slot.key), ['2026-10-13T16', '2026-10-13T18', '2026-10-13T20']);
});

test('quiet hours can wrap past midnight', () => {
  const quiet = {start: '23:00', end: '07:00'};
  assert.equal(inQuietHours({hour: 23, minute: 30}, quiet), true);
  assert.equal(inQuietHours({hour: 3, minute: 0}, quiet), true);
  assert.equal(inQuietHours({hour: 7, minute: 0}, quiet), false);
  assert.equal(inQuietHours({hour: 12, minute: 0}, null), false);
});

test('nothing is scheduled while automation is paused or stopped', () => {
  const {db, source} = world();
  makeShort(db, source.video_id);
  assert.equal(tick(db, SLOT).acted, false, 'paused by default');
  goLive(db);
  setSetting(db, 'automation.emergencyStop', true);
  assert.equal(tick(db, SLOT).acted, false);
  assert.deepEqual(uploadJobs(db), []);
});

test('a slot queues at most two approved Shorts, once, and only approved ones', () => {
  const {db, source} = world();
  goLive(db);
  const approved = [makeShort(db, source.video_id), makeShort(db, source.video_id), makeShort(db, source.video_id)];
  for (const status of ['awaiting_approval', 'compliance_rejected', 'verify_failed', 'rejected', 'rendering', 'planned']) {
    makeShort(db, source.video_id, {status});
  }
  assert.equal(tick(db, NOT_SLOT).acted, false);
  const result = tick(db, SLOT);
  assert.deepEqual(result.queued, approved.slice(0, 2));
  assert.deepEqual(uploadJobs(db), approved.slice(0, 2));
  assert.equal(tick(db, new Date(SLOT.getTime() + 60_000)).reason, 'slot already handled');
  assert.equal(uploadJobs(db).length, 2, 'a second tick in the same slot adds nothing');
});

test('an empty slot is skipped and logged, not filled', () => {
  const {db, source} = world();
  goLive(db);
  makeShort(db, source.video_id, {status: 'awaiting_approval'});
  const result = tick(db, SLOT);
  assert.deepEqual(result.queued, []);
  assert.match(db.get("SELECT message FROM events WHERE entity = 'schedule'").message, /skipped: no approved video/);
});

test('quiet hours, the daily limit and the upload quota each stop a slot', () => {
  const {db, source} = world();
  goLive(db);
  makeShort(db, source.video_id);
  const reasonWith = (key, value) => {
    setSetting(db, key, value);
    const reason = pickForSlot(db, getSettings(db), SLOT).reason;
    return reason;
  };
  assert.match(reasonWith('schedule.quietHours', {start: '13:00', end: '15:00'}), /quiet/);
  setSetting(db, 'schedule.quietHours', null);
  assert.match(reasonWith('schedule.dailyLimit', 0), /daily limit/);
  setSetting(db, 'schedule.dailyLimit', 12);
  recordQuota(db, 'insert', 100, SLOT);
  assert.match(pickForSlot(db, getSettings(db), SLOT).reason, /quota/);
});

const fakeYoutube = (overrides = {}) => {
  const calls = {sends: [], lists: 0};
  return {
    calls,
    api: {
      validateVideoFile: async (file) => ({file, size: 10, mimeType: 'video/mp4'}),
      hashFile: async () => 'hash',
      getPrivacyStatus: async () => 'private',
      listMyRecentUploads: async () => {
        calls.lists += 1;
        return [];
      },
      uploadVideoResumable: async (auth, video, body, hooks) => {
        calls.sends.push({privacy: body.status.privacyStatus, resumed: hooks.resumeSession});
        if (!hooks.resumeSession) {
          await hooks.onSession('https://upload.example/session-1');
        }
        return 'VIDEO_ID_1';
      },
      ...overrides,
    },
  };
};
const ctxFor = (db, youtube) => ({db, log: silentLog, youtube: youtube.api, getVerifiedClient: async () => ({client: {}, channel: {id: 'UC1', title: 'LopyClips'}})});

test('a dry run uploads nothing', async () => {
  const {db, source} = world();
  const id = makeShort(db, source.video_id);
  const youtube = fakeYoutube();
  assert.equal((await uploadShort(ctxFor(db, youtube), id)).status, 'dry-run');
  assert.equal(youtube.calls.sends.length, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM uploads').n, 0);
});

test('an approved Short uploads as private, is confirmed, and cannot be uploaded twice', async () => {
  const {db, source} = world();
  goLive(db);
  const id = makeShort(db, source.video_id);
  const youtube = fakeYoutube();
  const first = await uploadShort(ctxFor(db, youtube), id);
  assert.deepEqual([first.status, first.videoId], ['uploaded', 'VIDEO_ID_1']);
  assert.equal(youtube.calls.sends[0].privacy, 'private');
  assert.equal(db.get('SELECT status FROM shorts WHERE id = ?', id).status, 'uploaded');
  assert.equal(db.get('SELECT state FROM uploads WHERE short_id = ?', id).state, 'confirmed');
  assert.equal(quotaUsed(db, 'insert'), 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM moments WHERE status = 'used'").n, 3);
  const again = await uploadShort(ctxFor(db, youtube), id);
  assert.equal(again.status, 'already-uploaded');
  assert.equal(youtube.calls.sends.length, 1, 'the repeated job sent nothing');
});

test('only approved Shorts are uploaded', async () => {
  const {db, source} = world();
  goLive(db);
  const youtube = fakeYoutube();
  for (const status of ['awaiting_approval', 'verify_failed', 'compliance_rejected', 'rejected', 'planned']) {
    const id = makeShort(db, source.video_id, {status});
    await assert.rejects(uploadShort(ctxFor(db, youtube), id), PermanentError);
  }
  assert.equal(youtube.calls.sends.length, 0);
});

test('a Short whose creator lost permission after approval is stopped at upload time', async () => {
  const {db, creator, source} = world();
  goLive(db);
  const id = makeShort(db, source.video_id);
  setPermission(db, creator.id, 'denied', 'creator asked us to stop');
  const youtube = fakeYoutube();
  await assert.rejects(uploadShort(ctxFor(db, youtube), id), /no longer passes compliance/);
  assert.equal(db.get('SELECT status FROM shorts WHERE id = ?', id).status, 'compliance_rejected');
  assert.equal(youtube.calls.sends.length, 0);
});

test('the emergency stop and the non-private lock both refuse uploads', async () => {
  const {db, source} = world();
  goLive(db);
  const id = makeShort(db, source.video_id);
  const youtube = fakeYoutube();
  setSetting(db, 'upload.visibility', 'public');
  await assert.rejects(uploadShort(ctxFor(db, youtube), id), /have not been switched on/);
  setSetting(db, 'upload.allowNonPrivate', true);
  await assert.rejects(uploadShort(ctxFor(db, youtube), id), /confirmed private upload/);
  setSetting(db, 'upload.visibility', 'private');
  setSetting(db, 'automation.emergencyStop', true);
  await assert.rejects(uploadShort(ctxFor(db, youtube), id), /emergency stop/);
  assert.equal(youtube.calls.sends.length, 0);
});

test('a quota error is reported, not swallowed', async () => {
  const {db, source} = world();
  goLive(db);
  const id = makeShort(db, source.video_id);
  const youtube = fakeYoutube({
    uploadVideoResumable: async () => {
      throw new Error('YouTube API error (quotaExceeded): The request cannot be completed because you have exceeded your quota.');
    },
  });
  await assert.rejects(uploadShort(ctxFor(db, youtube), id), /quotaExceeded/);
  assert.match(db.get('SELECT last_error FROM uploads WHERE short_id = ?', id).last_error, /quotaExceeded/);
  assert.equal(db.get('SELECT state FROM uploads WHERE short_id = ?', id).state, 'pending', 'never marked as done');
});

test('after a crash mid-upload the stored session is resumed, not restarted', async () => {
  const {db, source} = world();
  goLive(db);
  const id = makeShort(db, source.video_id);
  const crashing = fakeYoutube({
    uploadVideoResumable: async (auth, video, body, hooks) => {
      await hooks.onSession('https://upload.example/session-1');
      throw new Error('socket hang up');
    },
  });
  await assert.rejects(uploadShort(ctxFor(db, crashing), id), /socket hang up/);
  assert.equal(db.get('SELECT status FROM shorts WHERE id = ?', id).status, 'uploading');
  const youtube = fakeYoutube();
  const result = await uploadShort(ctxFor(db, youtube), id);
  assert.equal(result.status, 'uploaded');
  assert.deepEqual(youtube.calls.sends, [{privacy: 'private', resumed: 'https://upload.example/session-1'}]);
  assert.equal(quotaUsed(db, 'insert'), 1, 'only one upload was ever opened');
});

test('if the session is gone but the video reached the channel, it is adopted instead of sent again', async () => {
  const {db, source} = world();
  goLive(db);
  const id = makeShort(db, source.video_id);
  const title = JSON.parse(db.get('SELECT metadata_json FROM shorts WHERE id = ?', id).metadata_json).title;
  const crashing = fakeYoutube({
    uploadVideoResumable: async (auth, video, body, hooks) => {
      await hooks.onSession('https://upload.example/session-1');
      throw new Error('timed out');
    },
  });
  await assert.rejects(uploadShort(ctxFor(db, crashing), id));
  const sends = [];
  const youtube = fakeYoutube({
    uploadVideoResumable: async (auth, video, body, hooks) => {
      sends.push(hooks.resumeSession);
      throw new SessionExpiredError('gone');
    },
    listMyRecentUploads: async () => [{videoId: 'ALREADY_THERE', title, publishedAt: new Date().toISOString()}],
  });
  const result = await uploadShort(ctxFor(db, youtube), id);
  assert.equal(result.videoId, 'ALREADY_THERE');
  assert.deepEqual(sends, ['https://upload.example/session-1'], 'no second upload was started');
});

test('the resumable protocol recovers from a dropped connection and returns the confirmed ID', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-upload-')), 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(20, 1));
  const requests = [];
  let chunkTries = 0;
  const auth = {
    request: async (options) => {
      requests.push(`${options.method} ${options.headers['Content-Range'] ?? 'start'}`);
      if (options.method === 'POST') {
        return {status: 200, headers: {location: 'https://upload.example/s'}};
      }
      if (options.headers['Content-Range'] === 'bytes */20') {
        return {status: 308, headers: {range: 'bytes=0-9'}};
      }
      chunkTries += 1;
      if (chunkTries === 1) {
        throw Object.assign(new Error('ECONNRESET'), {code: 'ECONNRESET'});
      }
      return {status: 200, headers: {}, data: {id: 'CONFIRMED_ID'}};
    },
  };
  let stored = null;
  const id = await uploadVideoResumable(auth, {file, size: 20, mimeType: 'video/mp4'}, {snippet: {title: 't'}, status: {privacyStatus: 'private'}}, {onSession: (uri) => (stored = uri)});
  assert.equal(id, 'CONFIRMED_ID');
  assert.equal(stored, 'https://upload.example/s');
  assert.deepEqual(requests, ['POST start', 'PUT bytes 0-19/20', 'PUT bytes */20', 'PUT bytes 10-19/20']);
});

test('an upload that returns no video ID is never reported as a success', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-upload-')), 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(8, 1));
  const auth = {request: async (options) => (options.method === 'POST' ? {status: 200, headers: {location: 'https://upload.example/s'}} : {status: 200, headers: {}, data: {}})};
  await assert.rejects(uploadVideoResumable(auth, {file, size: 8, mimeType: 'video/mp4'}, {snippet: {}, status: {privacyStatus: 'private'}}), /not confirmed/);
});

test('one video per slot: a delayed upload is never doubled up, repeated, or joined by the video of the next slot', () => {
  const {db, source} = world();
  goLive(db);
  setSetting(db, 'schedule.maxPerSlot', 1);
  const [first, second, third] = [makeShort(db, source.video_id), makeShort(db, source.video_id), makeShort(db, source.video_id)];
  const later = (hours) => new Date(SLOT.getTime() + hours * 3600_000);
  assert.deepEqual(tick(db, SLOT).queued, [first]);

  // The upload has not gone out two hours later, so the first Short is still "approved".
  const held = tick(db, later(2));
  assert.deepEqual(held.queued, [], 'the next slot neither repeats that video nor adds another one behind it');
  assert.match(held.reason, /earlier slot/);
  assert.deepEqual(uploadJobs(db), [first]);

  // It goes out at last. The following slot carries on with the next video, one at a time.
  db.run("UPDATE jobs SET status = 'succeeded' WHERE type = 'upload'");
  db.run("UPDATE shorts SET status = 'uploaded' WHERE id = ?", first);
  assert.deepEqual(tick(db, later(4)).queued, [second]);

  // A video the owner sends by hand with "Upload now" is extra: it does not hold back the schedule, and is not picked again.
  db.run("UPDATE jobs SET status = 'succeeded' WHERE type = 'upload'");
  db.run("UPDATE shorts SET status = 'uploaded' WHERE id = ?", second);
  const fourth = makeShort(db, source.video_id);
  db.run("INSERT INTO jobs (type, payload_json, run_after, created_at) VALUES ('upload', ?, ?, ?)", JSON.stringify({shortId: third, slotKey: 'manual'}), later(5).toISOString(), later(5).toISOString());
  assert.deepEqual(tick(db, later(6)).queued, [fourth]);
});

test('when YouTube caps the channel, posting pauses and resumes by itself instead of knocking again', async () => {
  const {db, source} = world();
  goLive(db);
  setSetting(db, 'schedule.maxPerSlot', 1);
  const [first, second] = [makeShort(db, source.video_id), makeShort(db, source.video_id)];
  let capped = true;
  const youtube = fakeYoutube({
    uploadVideoResumable: async (auth, video, body, hooks) => {
      youtube.calls.sends.push(body.snippet.title);
      if (capped) {
        throw Object.assign(new Error('YouTube API error (uploadLimitExceeded): The user has exceeded the number of videos they may upload.'), {reason: 'uploadLimitExceeded'});
      }
      await hooks.onSession('https://upload.example/session-1');
      return 'VIDEO_ID_1';
    },
  });
  const ctx = ctxFor(db, youtube);

  const refused = await uploadShort(ctx, first, {slotKey: '2026-10-13T17'});
  assert.equal(refused.status, 'held', 'the job ends quietly: retrying in a few minutes cannot help');
  assert.equal(db.get('SELECT status FROM shorts WHERE id = ?', first).status, 'approved', 'the Short keeps its place in line');
  assert.match(db.get("SELECT message FROM events WHERE entity_id = 'upload-hold'").message, /YouTube's own limit.*on hold until \d\d:\d\d/);
  assert.equal(quotaUsed(db, 'insert'), 0);
  const until = new Date(refused.until);
  assert.ok(until - Date.now() >= 3_590_000 && until - Date.now() <= 6 * 3_600_000 + 1000, 'the wait is between one and six hours');

  // During the hold a scheduled upload does not contact YouTube, and slots are skipped with the reason.
  assert.equal((await uploadShort(ctx, second, {slotKey: '2026-10-13T18'})).status, 'held');
  assert.equal(youtube.calls.sends.length, 1);
  const skipped = pickForSlot(db, getSettings(db), new Date());
  assert.deepEqual(skipped.shortIds, []);
  assert.match(skipped.reason, /capped this channel's uploads.*after \d\d:\d\d/);

  // A video the owner sends by hand is still tried; another refusal just keeps the hold going.
  assert.equal((await uploadShort(ctx, second, {slotKey: 'manual'})).status, 'held');
  assert.equal(youtube.calls.sends.length, 2);

  // Once the hold has run out, the schedule carries on with the same Short, and a success ends the hold.
  const after = new Date(Date.parse(db.get("SELECT value_json FROM settings WHERE key = 'state.uploadHold'").value_json.match(/"until":"([^"]+)"/)[1]) + 60_000);
  assert.deepEqual(pickForSlot(db, getSettings(db), after).shortIds, [first]);
  db.run("UPDATE settings SET value_json = ? WHERE key = 'state.uploadHold'", JSON.stringify({until: new Date(Date.now() - 1000).toISOString(), since: new Date().toISOString(), uploadsLast24h: 7}));
  capped = false;
  assert.equal((await uploadShort(ctx, first, {slotKey: '2026-10-14T11'})).status, 'uploaded');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM settings WHERE key = 'state.uploadHold'").n, 0);
});

test('the wait after a cap is timed to when the oldest upload of the last day turns 24 hours old', async () => {
  const {startUploadHold, getUploadHold} = await import('../publish/hold.mjs');
  const {db, source} = world();
  const at = new Date('2026-10-13T14:00:00Z');
  const uploadedAt = (iso) => {
    const id = makeShort(db, source.video_id, {status: 'uploaded'});
    db.run("INSERT INTO uploads (short_id, state, visibility, video_id, confirmed_at, created_at) VALUES (?, 'confirmed', 'public', 'vid', ?, ?)", id, iso, iso);
  };
  assert.equal(startUploadHold(db, at).until, '2026-10-13T20:00:00.000Z', 'with nothing to go on, six hours');
  uploadedAt('2026-10-12T10:00:00.000Z'); // older than a day: no longer counts
  uploadedAt('2026-10-12T17:30:00.000Z');
  uploadedAt('2026-10-13T09:00:00.000Z');
  const hold = startUploadHold(db, at);
  assert.deepEqual([hold.until, hold.uploadsLast24h], ['2026-10-13T17:35:00.000Z', 2], 'room should open when the 17:30 upload is a day old');
  assert.equal(getUploadHold(db, new Date('2026-10-13T17:00:00Z')).until, hold.until);
  assert.equal(getUploadHold(db, new Date('2026-10-13T17:36:00Z')), null);
  db.run("UPDATE uploads SET confirmed_at = '2026-10-12T14:20:00.000Z' WHERE confirmed_at = '2026-10-12T17:30:00.000Z'");
  assert.equal(startUploadHold(db, at).until, '2026-10-13T15:00:00.000Z', 'never less than an hour');
});
