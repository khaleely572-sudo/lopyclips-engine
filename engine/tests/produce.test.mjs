import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The data folder is read when the engine's config loads, so point it at a temp folder first.
process.env.LOPYCLIPS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lopy-produce-'));
const {dirs, ensureDirs} = await import('../config.mjs');
const {produceShort} = await import('../produce.mjs');
const {createYtdlpProvider} = await import('../sources/providers.mjs');
const {setSetting} = await import('../db/settings.mjs');
const {makeCreator, makeDb, makeShort, makeSource, silentLog} = await import('./helpers.mjs');
ensureDirs();

const VIDEO_ID = 'vid00000001';
// A caption word every 0.4 s for 12 minutes, so every planned clip has speech.
fs.writeFileSync(path.join(dirs.transcripts, `${VIDEO_ID}.words.json`), JSON.stringify(Array.from({length: 1800}, (_, i) => ({t: i * 0.4, e: i * 0.4 + 0.4, w: i % 9 === 8 ? 'lost.' : 'word'}))));

const setup = ({authorized = true, status = 'planned', verifyOk = true} = {}) => {
  const db = makeDb();
  const creator = makeCreator(db, {authorized});
  makeSource(db, creator.id, {videoId: VIDEO_ID});
  const shortId = makeShort(db, VIDEO_ID, {status});
  const calls = {fetches: 0, renders: 0, cuts: 0, models: []};
  const ctx = {
    db,
    log: silentLog,
    providers: {
      ytdlp: createYtdlpProvider({
        run: async (command, args) => {
          calls.fetches += 1;
          fs.writeFileSync(args[args.indexOf('-o') + 1], 'section');
        },
      }),
    },
    clip: {
      prepareSection: async (input, output) => (fs.writeFileSync(output, 'prepared'), output),
      measureLevels: async () => Array.from({length: 100}, (_, i) => ({t: i * 0.25, level: 5000})),
      cutWithSkill: async (prepared, start, frames, output) => {
        calls.cuts += 1;
        fs.writeFileSync(output, 'clip');
      },
    },
    renderShort: async ({output, onProgress}) => {
      calls.renders += 1;
      fs.writeFileSync(output, `rendered video ${calls.renders}`);
      onProgress(1);
      return output;
    },
    verifyRender: async () => ({ok: verifyOk, checks: [{name: 'resolution', ok: verifyOk, detail: verifyOk ? '1080x1920' : '1920x1080', mandatory: true}]}),
    llm: {
      json: async ({schema}) => {
        calls.models.push(schema.required[0]);
        return schema.required.includes('title')
          ? {title: 'He promised he would not lose', summary: 'A streamer says he cannot lose, then loses.', hashtags: ['gaming', 'Test Streamer!']}
          : {slurs: false, sexual_content: false, graphic_violence: false, dangerous_acts: false, harassment: false, notes: ''};
      },
    },
  };
  return {db, ctx, shortId, calls};
};
const shortRow = (db, id) => db.get('SELECT * FROM shorts WHERE id = ?', id);

test('a planned Short from an authorized source becomes a verified video awaiting approval', async () => {
  const {db, ctx, shortId, calls} = setup();
  await produceShort(ctx, shortId);
  const short = shortRow(db, shortId);
  assert.equal(short.status, 'awaiting_approval');
  assert.equal(short.approved_at, null, 'it is not approved automatically');
  assert.deepEqual([calls.fetches, calls.cuts, calls.renders], [3, 3, 1]);
  assert.ok(fs.existsSync(short.output_path));
  assert.ok(short.output_sha256);
  const metadata = JSON.parse(short.metadata_json);
  assert.equal(metadata.title, 'He promised he would not lose');
  assert.match(metadata.description, /Clips from Test Streamer on YouTube\.\nFull video: https:\/\/www\.youtube\.com\/watch\?v=vid00000001/);
  assert.deepEqual(metadata.tags, ['gaming', 'TestStreamer', 'shorts']);
  const compliance = JSON.parse(short.compliance_json);
  assert.equal(compliance.passed, true);
  assert.equal(compliance.clips.length, 3);
  assert.ok(compliance.clips.every((clip) => clip.seconds === 18 && clip.text.length > 0), 'metadata and compliance use the real clip captions');
  assert.deepEqual(fs.readdirSync(dirs.sections), [], 'fetched source footage is deleted after the render');
});

test('without permission nothing is fetched or rendered, and the reason is recorded', async () => {
  const {db, ctx, shortId, calls} = setup({authorized: false});
  await produceShort(ctx, shortId);
  const short = shortRow(db, shortId);
  assert.equal(short.status, 'compliance_rejected');
  assert.match(short.fail_reason, /permission/);
  assert.deepEqual([calls.fetches, calls.renders], [0, 0]);
});

test('a render that fails verification is never offered for approval', async () => {
  const {db, ctx, shortId} = setup({verifyOk: false});
  await produceShort(ctx, shortId);
  const short = shortRow(db, shortId);
  assert.equal(short.status, 'verify_failed');
  assert.match(short.fail_reason, /resolution/);
  assert.equal(short.output_sha256, null);
});

test('content the review flags is rejected before any rendering', async () => {
  const {db, ctx, shortId, calls} = setup();
  ctx.llm.json = async () => ({slurs: true, sexual_content: false, graphic_violence: false, dangerous_acts: false, harassment: false, notes: ''});
  await produceShort(ctx, shortId);
  assert.equal(shortRow(db, shortId).status, 'compliance_rejected');
  assert.equal(calls.renders, 0);
});

test('if the content review cannot run, the Short fails closed', async () => {
  const {db, ctx, shortId, calls} = setup();
  ctx.llm.json = async () => {
    throw new Error('Could not reach Ollama');
  };
  await produceShort(ctx, shortId);
  const short = shortRow(db, shortId);
  assert.equal(short.status, 'compliance_rejected');
  assert.match(short.fail_reason, /review/);
  assert.equal(calls.renders, 0);
});

test('a restart after rendering redoes only the metadata, and a finished Short is left alone', async () => {
  const {db, ctx, shortId, calls} = setup();
  let failMetadata = true;
  const real = ctx.llm.json;
  ctx.llm.json = async (request) => {
    if (request.schema.required.includes('title') && failMetadata) {
      throw new Error('model unavailable');
    }
    return real(request);
  };
  await assert.rejects(produceShort(ctx, shortId), /model unavailable/);
  assert.equal(shortRow(db, shortId).status, 'rendered', 'the render is kept; no title was invented');
  failMetadata = false;
  await produceShort(ctx, shortId);
  assert.equal(shortRow(db, shortId).status, 'awaiting_approval');
  await produceShort(ctx, shortId);
  assert.equal(calls.renders, 1, 'rendered exactly once across all three runs');
});

test('with approval switched off, a clean Short is approved on its own', async () => {
  const {db, ctx, shortId} = setup();
  setSetting(db, 'requireApproval', false);
  await produceShort(ctx, shortId);
  const short = shortRow(db, shortId);
  assert.equal(short.status, 'approved');
  assert.ok(short.approved_at);
});
