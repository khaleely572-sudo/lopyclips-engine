import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The data folder is read when the engine's config loads, so point it at a temp folder first.
process.env.LOPYCLIPS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-pipeline-'));
const {dirs, ensureDirs} = await import('../config.mjs');
const {createHandlers} = await import('../pipeline.mjs');
const {setFeedback} = await import('../analysis/feedback.mjs');
const {getSettings} = await import('../db/settings.mjs');
const {makeCreator, makeDb, makeSource, silentLog} = await import('./helpers.mjs');
ensureDirs();

const VIDEO_ID = 'vid00000001';
// 200 caption lines of 8 words, 3.2 seconds each, every line with words of its own: "line 17 a17 b17 c17 d17 e17 f17."
const words = Array.from({length: 200}, (_, i) => ['line', String(i), `a${i}`, `b${i}`, `c${i}`, `d${i}`, `e${i}`, `f${i}.`]).flat().map((w, n) => ({t: n * 0.4, e: n * 0.4 + 0.4, w}));
fs.writeFileSync(path.join(dirs.transcripts, `${VIDEO_ID}.words.json`), JSON.stringify(words));

const FUNNY = [5, 25, 95, 115];
const LOUD = 175;
const proposal = (line) => ({setup_line: line, punch_line: line + 4, end_line: line + 4, quote: `line ${line + 4} a${line + 4} b${line + 4}`, humor_type: 'banter', tone: 'joking', why_funny: `The exchange at line ${line} ends on a comeback.`, funny: 8, standalone: 8, confidence: 0.8, label: `moment ${line}`, risks: []});

const setup = ({reviewerDown = false} = {}) => {
  const db = makeDb();
  const creator = makeCreator(db, {authorized: true});
  makeSource(db, creator.id, {videoId: VIDEO_ID, status: 'transcript_ready'});
  const calls = [];
  const llm = {
    json: async ({model, schema, messages}) => {
      const kind = schema.required[0];
      const user = messages.at(-1).content;
      calls.push({kind, model});
      if (kind === 'moments') {
        const shown = [...user.matchAll(/^(\d+)\t/gm)].map((match) => Number(match[1]));
        return {moments: [...FUNNY, LOUD].filter((line) => line >= shown[0] && line + 4 <= shown.at(-1)).map(proposal)};
      }
      if (kind === 'reviews') {
        if (reviewerDown) {
          throw new Error('second model down');
        }
        return {
          reviews: user.split(/^Proposal \d+\n/m).slice(1).map((block, id) => {
            const line = Number(/^> (\d+)\t/m.exec(block)[1]);
            const funny = line !== LOUD;
            return {id, joke: funny ? 'A comeback lands.' : 'He just shouts.', verdict: funny ? 'funny' : 'not_funny', humor: funny ? 8 : 2, standalone: 8, payoff: 8, tone: 'joking', humor_type: 'banter', start_line: line, end_line: line + 4, flags: funny ? [] : ['just_loud'], risks: []};
          }),
        };
      }
      if (kind === 'seen') {
        // The second model watching one clip: it is sent the frames as images.
        calls.at(-1).images = user.filter((part) => part.type === 'image_url').length;
        return {seen: ['0:00:12 he grins at the camera'], adds: 'funnier', joke: 'A comeback lands.', verdict: 'funny', humor: 8, flags: ['reaction_visible']};
      }
      if (kind === 'clips') {
        // The first model re-judging from the notes: text only.
        calls.at(-1).text = user;
        return {clips: [...user.matchAll(/^Clip (\d+)$/gm)].map((match) => ({id: Number(match[1]), humor: 8, verdict: 'funny', why: 'The grin sells it.'}))};
      }
      return kind === 'order' ? {order: [0, 1, 2, 3], repeats: []} : {header: 'Test header', order: [0, 1, 2], labels: []};
    },
  };
  // Stand-ins for fetching a short section and taking frames from it.
  const providers = {ytdlp: {fetchSection: async (creator, source, from, to, dest) => fs.writeFileSync(dest, `section ${from}-${to}`)}};
  const watchFrames = async (file, outDir) => {
    fs.mkdirSync(outDir, {recursive: true});
    const frame = path.join(outDir, 'frame_0001.jpg');
    fs.writeFileSync(frame, 'jpeg');
    return {engine: 'test', frames: [{t: 2, path: frame}]};
  };
  return {db, calls, handlers: createHandlers({db, log: silentLog, llm, providers, watchFrames})};
};

test('a stream is analysed by both models, and only what both find funny can be planned', async () => {
  const {db, calls, handlers} = setup();
  await handlers.analyze({videoId: VIDEO_ID});

  const settings = getSettings(db);
  assert.ok(calls.filter((call) => ['moments', 'clips'].includes(call.kind)).every((call) => call.model === settings['analysis.model']), 'the first model finds, and re-judges after the watching');
  assert.ok(calls.filter((call) => !['moments', 'clips'].includes(call.kind)).every((call) => call.model === settings['analysis.secondModel']), 'the second model reviews, watches and ranks');
  const watching = calls.filter((call) => call.kind === 'seen');
  assert.equal(watching.length, 4, 'every shortlisted clip is watched; the loud one was already rejected');
  assert.ok(watching.every((call) => call.images === 1), 'the second model is sent the frames');
  assert.match(calls.find((call) => call.kind === 'clips').text, /What happens on screen:\n0:00:12 he grins at the camera/, "the first model gets the second model's notes");
  const moments = db.all('SELECT * FROM moments ORDER BY start_s');
  assert.deepEqual(moments.map((moment) => moment.status), ['candidate', 'candidate', 'candidate', 'candidate', 'rejected']);
  assert.match(moments[4].reject_reason, /no joke here/);
  assert.ok(moments.every((moment) => moment.humor_type === 'banter'));
  const stored = JSON.parse(moments[0].review_json);
  assert.deepEqual([stored.discovery.funny, stored.review.verdict, stored.review.humor, stored.rank], [8, 'funny', 8, 1], 'both opinions are kept with the moment');
  assert.deepEqual([stored.watch.seer.verdict, stored.watch.judge.humor, stored.watch.outcome, stored.watch.frames], ['funny', 8, 'funnier on screen', 1], 'and what both made of it after watching');
  assert.equal(db.get('SELECT status FROM sources').status, 'analyzed');
  assert.match(db.get("SELECT message FROM events WHERE message LIKE 'Analysed%'").message, /4 candidate\(s\) out of 5 proposed; the second model rejected 1 and left 0 uncertain; .* Watched 4 of 4 shortlisted clip\(s\) before deciding\./);
  assert.equal(fs.readdirSync(dirs.sections).length, 4, 'the sections of the four candidates are kept for editing');
  assert.deepEqual(fs.readdirSync(dirs.work), [], 'the draft of step 1 is removed once the analysis is stored');

  // The owner's rating reorders the pool before planning: the top moment is passed over.
  setFeedback(db, moments[0].id, 'not_funny');
  await handlers.plan({videoId: VIDEO_ID});
  const shorts = db.all('SELECT * FROM shorts');
  assert.equal(shorts.length, 1);
  assert.equal(shorts[0].status, 'planned', 'a rating never approves or publishes anything');
  assert.deepEqual(JSON.parse(shorts[0].plan_json).clips.map((clip) => clip.momentId), [moments[1].id, moments[2].id, moments[3].id]);
  assert.deepEqual(db.all('SELECT status FROM moments ORDER BY start_s').map((row) => row.status), ['candidate', 'selected', 'selected', 'selected', 'rejected']);
  const expected = JSON.parse(shorts[0].plan_json).clips.map((clip) => `${VIDEO_ID}_${Math.max(0, Math.floor(clip.start - 2))}_${Math.ceil(clip.end + 2)}.mp4`).sort();
  assert.deepEqual(fs.readdirSync(dirs.sections).sort(), expected, 'after planning only the sections the Short uses are left, named as the editing step looks for them');
  fs.rmSync(dirs.sections, {recursive: true, force: true});
  fs.mkdirSync(dirs.sections, {recursive: true});
});

test('if the second model is down, nothing is stored and the first model\'s work is kept for the retry', async () => {
  const {db, calls, handlers} = setup({reviewerDown: true});
  await assert.rejects(handlers.analyze({videoId: VIDEO_ID}), /second model down/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM moments').n, 0);
  assert.equal(db.get('SELECT status FROM sources').status, 'transcript_ready');
  assert.deepEqual(fs.readdirSync(dirs.work), [`discovery_${VIDEO_ID}.json`]);
  const firstPass = calls.filter((call) => call.kind === 'moments').length;
  await assert.rejects(handlers.analyze({videoId: VIDEO_ID}), /second model down/);
  assert.equal(calls.filter((call) => call.kind === 'moments').length, firstPass, 'the retry does not ask the first model again');
  fs.rmSync(path.join(dirs.work, `discovery_${VIDEO_ID}.json`));
});

test('a new stream whose captions YouTube has not made yet is checked again later, not given up on', async () => {
  const db = makeDb();
  const creator = makeCreator(db, {authorized: true});
  const fresh = makeSource(db, creator.id, {videoId: 'fresh000001', status: 'discovered'});
  const old = makeSource(db, creator.id, {videoId: 'old00000001', status: 'discovered'});
  db.run('UPDATE sources SET published_at = ? WHERE video_id = ?', new Date(Date.now() - 2 * 3600_000).toISOString(), fresh.video_id);
  db.run('UPDATE sources SET published_at = ? WHERE video_id = ?', new Date(Date.now() - 4 * 24 * 3600_000).toISOString(), old.video_id);
  const handlers = createHandlers({db, log: silentLog, llm: {json: async () => ({})}, providers: {ytdlp: {fetchCaptions: async () => null}}});

  await handlers.transcript({videoId: fresh.video_id});
  const waiting = db.get('SELECT status, blocked_reason FROM sources WHERE video_id = ?', fresh.video_id);
  assert.equal(waiting.status, 'discovered', 'still in line');
  assert.match(waiting.blocked_reason, /not made captions for this video yet; checking again around \d\d:\d\d/);
  const recheck = db.get("SELECT run_after FROM jobs WHERE type = 'transcript' AND json_extract(payload_json, '$.videoId') = ?", fresh.video_id);
  const wait = Date.parse(recheck.run_after) - Date.now();
  assert.ok(wait > 2.9 * 3600_000 && wait <= 3 * 3600_000, 'checked again in three hours');

  await handlers.transcript({videoId: old.video_id});
  const given = db.get('SELECT status, blocked_reason FROM sources WHERE video_id = ?', old.video_id);
  assert.equal(given.status, 'blocked', 'after three days, no captions means none are coming');
  assert.match(given.blocked_reason, /three days/);
});
