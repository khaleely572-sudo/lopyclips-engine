import {addCreator, setPermission} from '../db/creators.mjs';
import {now, openDb} from '../db/db.mjs';
import {setSetting} from '../db/settings.mjs';

export const makeDb = (file = ':memory:') => openDb(file);

export const BASIS = 'Creator posted a public clipping policy on 2026-10-01 allowing clip channels.';

export const makeCreator = (db, {name = 'Test Streamer', handle = '@TestStreamer', authorized = false} = {}) => {
  const creator = addCreator(db, {name, handle});
  if (authorized) {
    setPermission(db, creator.id, 'authorized', BASIS);
  }
  return db.get('SELECT * FROM creators WHERE id = ?', creator.id);
};

export const makeSource = (db, creatorId, {videoId = 'vid00000001', status = 'analyzed'} = {}) => {
  db.run(
    'INSERT INTO sources (video_id, creator_id, title, url, published_at, duration_s, kind, status, discovered_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    videoId, creatorId, 'A long stream', `https://www.youtube.com/watch?v=${videoId}`, now(), 7200, 'stream', status, now(), now(),
  );
  return db.get('SELECT * FROM sources WHERE video_id = ?', videoId);
};

export const makeMoment = (db, videoId, start, end, score = 7) =>
  Number(
    db.run(
      'INSERT INTO moments (source_id, start_s, end_s, score, confidence, reason, label, quote, risks_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      videoId, start, end, score, 0.8, 'a boast that backfires straight away', 'boast backfires', 'i am not losing this', '[]', 'selected', now(),
    ).lastInsertRowid,
  );

/** A Short with clean stored compliance, in the given status. */
export const makeShort = (db, videoId, {status = 'approved', outputPath = 'C:/renders/short.mp4', momentIds = null} = {}) => {
  const ids = momentIds ?? [makeMoment(db, videoId, 100, 118), makeMoment(db, videoId, 300, 320), makeMoment(db, videoId, 500, 518)];
  const clips = ids.map((momentId, i) => ({momentId, start: 100 + i * 200, end: 118 + i * 200, seconds: 18, label: `CLIP ${i + 1}`, censored: 0, musicTags: 0, wordCount: 30, risks: [], text: 'he said he would win and then he lost'}));
  const plan = {header: 'TEST SHORT', arrangedBy: 'stream order', clips: clips.map(({momentId, start, end, label}) => ({momentId, start, end, label}))};
  const compliance = {passed: true, failures: [], warnings: [], review: {slurs: false, sexual_content: false, graphic_violence: false, dangerous_acts: false, harassment: false, notes: ''}, clips};
  const metadata = {title: `A test Short ${Math.random().toString(36).slice(2, 8)}`, description: 'What happens in the clips.', tags: ['shorts'], categoryId: '24'};
  const id = Number(
    db.run(
      'INSERT INTO shorts (source_id, status, title, plan_json, compliance_json, metadata_json, output_path, approved_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      videoId, status, plan.header, JSON.stringify(plan), JSON.stringify(compliance), JSON.stringify(metadata), outputPath, status === 'approved' ? now() : null, now(), now(),
    ).lastInsertRowid,
  );
  ids.forEach((momentId, position) => db.run('INSERT INTO short_moments (short_id, moment_id, position) VALUES (?,?,?)', id, momentId, position));
  return id;
};

/** Settings as a live system would have them: not paused, not a dry run. */
export const goLive = (db) => {
  setSetting(db, 'automation.paused', false);
  setSetting(db, 'dryRun', false);
};

export const silentLog = () => {};
