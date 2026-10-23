import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {applyWatch, extractFrames, sectionFor, watchMoments} from '../analysis/watch.mjs';
import {SETTINGS} from '../db/settings.mjs';

const settings = {...Object.fromEntries(Object.entries(SETTINGS).map(([key, [value]]) => [key, value])), 'analysis.model': 'first', 'analysis.secondModel': 'second'};
const lines = Array.from({length: 60}, (_, i) => ({i, start: i * 4, end: i * 4 + 3.5, text: `line ${i} words`}));
const source = {video_id: 'vid00000001', title: 'A long stream'};
const creator = {name: 'Test Streamer'};
const review = {verdict: 'funny', humor: 8, standalone: 8, payoff: 8, tone: 'joking', humorType: 'banter', joke: 'x', flags: []};
const moment = (start, status = 'candidate', extra = {}) => ({start, end: start + 12, score: 7.5, status, rejectReason: status === 'uncertain' ? 'could not tell' : null, review, details: {humor: 7.6}, ...extra});

const world = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-watch-'));
  const sectionsDir = path.join(dir, 'sections');
  const workDir = path.join(dir, 'work');
  fs.mkdirSync(sectionsDir);
  fs.mkdirSync(workDir);
  const fetched = [];
  const provider = {
    fetchSection: async (who, src, from, to, dest) => {
      fetched.push([from, to]);
      fs.writeFileSync(dest, 'section');
    },
  };
  const frames = async (file, outDir) => {
    fs.mkdirSync(outDir, {recursive: true});
    const frame = path.join(outDir, 'frame.jpg');
    fs.writeFileSync(frame, 'jpeg');
    return {engine: 'test', frames: [{t: 2.5, path: frame}, {t: 6, path: frame}]};
  };
  return {dir, sectionsDir, workDir, provider, frames, fetched};
};

/** The two models: the second watches (decided per clip by its start time), the first re-judges the notes. */
const models = ({watchBy, judge = () => ({humor: 7, verdict: 'funny', why: 'It lands.'}), seen = []} = {}) => ({
  json: async ({model, schema, messages}) => {
    const user = messages.at(-1).content;
    seen.push({model, kind: schema.required[0], user});
    if (schema.required[0] === 'seen') {
      const at = /Frame at (\d+):(\d\d)/.exec(user.find((part) => part.type === 'text' && part.text.startsWith('Frame at')).text);
      return watchBy(Number(at[1]) * 60 + Number(at[2]));
    }
    return {clips: [...user.matchAll(/^Clip (\d+)$/gm)].map((match) => ({id: Number(match[1]), ...judge(Number(match[1]))}))};
  },
});
const saw = (overrides = {}) => ({seen: ['0:01 he laughs'], adds: 'same', joke: 'A comeback lands.', verdict: 'funny', humor: 7, flags: [], ...overrides});

test('the section is named exactly as the editing step names it, so it is fetched once', () => {
  assert.deepEqual(sectionFor('/s', 'vid', {start: 100.4, end: 112.2}), {from: 98, to: 115, file: path.join('/s', 'vid_98_115.mp4')});
  assert.equal(sectionFor('/s', 'vid', {start: 0.5, end: 8}).from, 0);
});

test('watching confirms, settles and rejects, and only footage that may still be used is kept', async () => {
  const w = world();
  const seen = [];
  const moments = [moment(40), moment(100, 'uncertain'), moment(160), {...moment(200), review: null}, moment(220, 'rejected')];
  const llm = models({
    seen,
    watchBy: (at) => (at < 60 ? saw({adds: 'funnier', humor: 8, flags: ['reaction_visible']}) : at < 120 ? saw({humor: 7}) : saw({verdict: 'not_funny', humor: 2, adds: 'less_funny', joke: 'He just reads chat.', flags: ['nothing_happens']})),
    judge: (id) => (id === 2 ? {humor: 3, verdict: 'not_funny', why: 'Nothing happens.'} : {humor: 8, verdict: 'funny', why: 'The reaction sells it.'}),
  });
  const result = await watchMoments({moments, lines, source, creator, provider: w.provider, llm, settings, sectionsDir: w.sectionsDir, workDir: w.workDir, frames: w.frames});
  assert.deepEqual(result, {watched: 3, shortlisted: 3, stopped: null}, 'candidates and uncertain moments that were reviewed are watched; others are not');
  assert.deepEqual(moments.map((m) => m.status), ['candidate', 'candidate', 'rejected', 'candidate', 'rejected']);

  const [confirmed, settled, flat] = moments;
  assert.equal(confirmed.details.watch.outcome, 'funnier on screen');
  assert.ok(confirmed.score > 7.5, 'watching it raised the score');
  assert.equal(settled.details.watch.outcome, 'settled by watching');
  assert.equal(settled.rejectReason, null);
  assert.match(flat.rejectReason, /after watching the clip, no joke: He just reads chat/);
  assert.deepEqual(flat.details.watch.seer.flags, ['nothing_happens']);

  const watching = seen.filter((call) => call.kind === 'seen');
  assert.ok(watching.every((call) => call.model === 'second' && call.user.filter((part) => part.type === 'image_url').length === 2), 'the second model is shown the frames');
  assert.ok(watching.every((call) => call.user[0].text.includes('Captions:\n')), 'together with the captions of the clip');
  assert.ok(watching.some((call) => call.user[0].text.includes('line 10 words') && !call.user[0].text.includes('line 25 words')), 'only the lines inside that clip');
  const judging = seen.find((call) => call.kind === 'clips');
  assert.equal(judging.model, 'first');
  assert.equal(typeof judging.user, 'string', 'the first model is sent text only: it cannot see images');
  assert.match(judging.user, /What happens on screen:\n0:01 he laughs/);

  assert.deepEqual(fs.readdirSync(w.sectionsDir).sort(), ['vid00000001_38_54.mp4', 'vid00000001_98_114.mp4'], 'the rejected clip’s footage is deleted at once');
  assert.deepEqual(fs.readdirSync(w.workDir), [], 'no frames are left behind');
});

test('a clip that cannot be fetched keeps its captions-only verdict, and YouTube limiting stops the watching', async () => {
  const w = world();
  let calls = 0;
  const provider = {
    fetchSection: async () => {
      calls += 1;
      throw Object.assign(new Error('yt-dlp failed'), {stderr: 'ERROR: HTTP Error 429: Too Many Requests'});
    },
  };
  const moments = [moment(40), moment(100), moment(160)];
  const logged = [];
  const result = await watchMoments({moments, lines, source, creator, provider, llm: models({watchBy: () => saw()}), settings: {...settings, 'analysis.watchMax': 3}, sectionsDir: w.sectionsDir, workDir: w.workDir, frames: w.frames, log: (level, message) => logged.push(message)});
  assert.equal(result.watched, 0);
  assert.match(result.stopped, /limiting requests/);
  assert.ok(calls <= 2, 'it stops asking YouTube once it is told to slow down');
  assert.deepEqual(moments.map((m) => m.status), ['candidate', 'candidate', 'candidate'], 'nothing is decided on footage that was never seen');
  assert.ok(moments.every((m) => m.details.watch.skipped));
  assert.match(logged.join(' '), /Watching stopped/);
});

test('at most the set number of clips are watched per stream, best first', async () => {
  const w = world();
  const moments = [moment(40, 'candidate', {score: 6}), moment(100, 'candidate', {score: 9}), moment(160, 'uncertain', {score: 8})];
  const result = await watchMoments({moments, lines, source, creator, provider: w.provider, llm: models({watchBy: () => saw()}), settings: {...settings, 'analysis.watchMax': 1}, sectionsDir: w.sectionsDir, workDir: w.workDir, frames: w.frames});
  assert.equal(result.watched, 1);
  assert.deepEqual(w.fetched, [[98, 114]], 'the best candidate is watched first; uncertain ones come after every candidate');
});

test('after watching, the humor that counts is half the caption judgement and half the watched one', () => {
  const m = moment(40);
  applyWatch(m, {frames: 2, engine: 'test', seer: saw({humor: 9, adds: 'funnier'}), judge: {humor: 9, verdict: 'funny', why: ''}}, {minHumor: 6, minScore: 5});
  assert.ok(Math.abs(m.score - (7.5 + 0.6 * (0.5 * 7.6 + 0.5 * 9 - 7.6))) < 1e-9);
  const low = moment(40);
  applyWatch(low, {frames: 2, engine: 'test', seer: saw({humor: 5}), judge: {humor: 6, verdict: 'funny', why: ''}}, {minHumor: 6, minScore: 5});
  assert.match(low.rejectReason, /humor 5\.5 of 10 is below the minimum of 6/);
  const cut = moment(40);
  applyWatch(cut, {frames: 2, engine: 'test', seer: saw({humor: 7.6, flags: ['cut_off']}), judge: null}, {minHumor: 6, minScore: 5});
  assert.ok(Math.abs(cut.score - 7) < 1e-9, 'a payoff that looks cut off costs half a point');
  const lukewarm = moment(40);
  applyWatch(lukewarm, {frames: 2, engine: 'test', seer: saw({verdict: 'weak', humor: 6, adds: 'funnier'}), judge: {humor: 7, verdict: 'funny', why: ''}}, {minHumor: 6, minScore: 5});
  assert.deepEqual([lukewarm.status, lukewarm.details.watch.outcome], ['candidate', 'kept after watching'], 'only a clip the watcher calls funny is labelled funnier on screen');
  const unsure = moment(40, 'uncertain');
  applyWatch(unsure, {frames: 2, engine: 'test', seer: saw({verdict: 'unsure', humor: 7}), judge: {humor: 7, verdict: 'unsure', why: ''}}, {minHumor: 6, minScore: 5});
  assert.equal(unsure.status, 'uncertain', 'still not used automatically when neither model can tell');
});

const hasTools = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], {stdio: 'ignore'});
    return fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'watch', 'scripts', 'frames.py'));
  } catch {
    return false;
  }
})();

test('the /watch skill picks real frames from a section', {skip: !hasTools && 'ffmpeg or the /watch skill is not installed here'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-frames-'));
  const video = path.join(dir, 'section.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8', '-pix_fmt', 'yuv420p', video]);
  const picked = await extractFrames(video, path.join(dir, 'frames'), 1, 7, 6);
  assert.match(picked.engine, /^watch skill/);
  assert.ok(picked.frames.length >= 2 && picked.frames.length <= 6);
  assert.ok(picked.frames.every((frame) => fs.existsSync(frame.path) && frame.t >= 1 && frame.t <= 7));
  assert.deepEqual(picked.frames.map((frame) => frame.t), [...picked.frames.map((frame) => frame.t)].sort((a, b) => a - b), 'in time order');
});
