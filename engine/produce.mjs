import fs from 'node:fs';
import path from 'node:path';
import {hashFile} from '../scripts/youtube/youtube.mjs';
import {buildCaptions} from './clipping/captions.mjs';
import {findPeak, snapToGrid, trimSilence} from './clipping/clip.mjs';
import {evaluate, reviewContent} from './compliance/gate.mjs';
import {FPS, dirs} from './config.mjs';
import {getCreator} from './db/creators.mjs';
import {logEvent, now} from './db/db.mjs';
import {getSettings} from './db/settings.mjs';
import {PermanentError} from './jobs/queue.mjs';
import {buildMetadata} from './metadata/metadata.mjs';
import {usedMomentIds} from './publish/uploader.mjs';
import {styleFor} from './render/styles.mjs';
import {checkAccess} from './sources/access.mjs';
import {providerFor} from './sources/providers.mjs';

const SECTION_PAD = 2;
const TRIM_ALLOWANCE = 3;

export const loadWords = (videoId) => JSON.parse(fs.readFileSync(path.join(dirs.transcripts, `${videoId}.words.json`), 'utf8'));

const setStatus = (db, shortId, status, failReason = null) =>
  db.run('UPDATE shorts SET status = ?, fail_reason = ?, updated_at = ? WHERE id = ?', status, failReason, now(), shortId);

/** Fetch, cut and caption every clip in the plan. Returns Remotion segments plus per-clip facts for compliance. */
const buildClips = async (ctx, {short, source, creator, plan, workDir}) => {
  const words = loadWords(source.video_id);
  const fixes = creator.caption_fixes ? JSON.parse(creator.caption_fixes) : {};
  const risksById = new Map(ctx.db.all('SELECT id, risks_json FROM moments WHERE source_id = ?', source.video_id).map((row) => [row.id, JSON.parse(row.risks_json ?? '[]')]));
  const provider = providerFor(source, ctx.providers);
  const publicDir = path.join(workDir, 'public');
  fs.mkdirSync(publicDir, {recursive: true});

  const segments = [];
  const clips = [];
  const sections = [];
  for (const [i, clip] of plan.clips.entries()) {
    const from = Math.max(0, Math.floor(clip.start - SECTION_PAD));
    const to = Math.ceil(clip.end + SECTION_PAD);
    const section = path.join(dirs.sections, `${source.video_id}_${from}_${to}.mp4`);
    if (!fs.existsSync(section)) {
      await provider.fetchSection(creator, source, from, to, section);
    }
    sections.push(section);
    const prepared = await ctx.clip.prepareSection(section, path.join(workDir, `prep_${i}.mp4`));
    const levels = await ctx.clip.measureLevels(prepared);
    const trimmed = trimSilence(levels, clip.start - from, clip.end - from, {maxTrim: TRIM_ALLOWANCE});
    const localStart = Math.max(0, snapToGrid(trimmed.start));
    const frames = Math.round((trimmed.end - localStart) * FPS);
    const file = `clip_${i}.mp4`;
    await ctx.clip.cutWithSkill(prepared, localStart, frames, path.join(publicDir, file));

    const start = from + localStart;
    const seconds = frames / FPS;
    const captions = buildCaptions(words, start, start + seconds, fixes);
    const peak = findPeak(levels, localStart, localStart + seconds);
    segments.push({file, frames, round: i + 1, label: clip.label, hit: null, hitLabel: null, chunks: captions.chunks, mutes: captions.mutes, zooms: peak === null ? [] : [Number(peak.toFixed(2))]});
    clips.push({momentId: clip.momentId, start, end: start + seconds, seconds, label: clip.label, censored: captions.censored, musicTags: captions.musicTags, wordCount: captions.wordCount, risks: risksById.get(clip.momentId) ?? [], text: captions.text});
  }
  return {segments, clips, sections};
};

/**
 * Turn a planned Short into a verified, described video file waiting for approval.
 * Re-running after a crash is safe: a Short that already rendered goes straight to metadata.
 *
 * ctx: {db, log, llm, providers, clip, renderShort, verifyRender}
 */
export const produceShort = async (ctx, shortId) => {
  const {db, log} = ctx;
  const settings = getSettings(db);
  let short = db.get('SELECT * FROM shorts WHERE id = ?', shortId);
  if (!short) {
    throw new PermanentError(`Short ${shortId} does not exist.`);
  }
  if (!['planned', 'clipping', 'rendering', 'rendered'].includes(short.status)) {
    return; // already produced, rejected or published
  }
  const source = db.get('SELECT * FROM sources WHERE video_id = ?', short.source_id);
  const creator = getCreator(db, source.creator_id);
  const access = checkAccess(creator);
  if (!access.allowed) {
    setStatus(db, shortId, 'compliance_rejected', access.reason);
    logEvent(db, 'warn', `Short ${shortId} stopped: ${access.reason}`, {entity: 'short', id: shortId});
    return;
  }
  const plan = JSON.parse(short.plan_json);
  const output = path.join(dirs.renders, `short_${shortId}.mp4`);

  if (short.status !== 'rendered') {
    const workDir = path.join(dirs.work, `short_${shortId}`);
    fs.rmSync(workDir, {recursive: true, force: true});
    fs.mkdirSync(workDir, {recursive: true});
    setStatus(db, shortId, 'clipping');
    const {segments, clips, sections} = await buildClips(ctx, {short, source, creator, plan, workDir});
    const seconds = clips.reduce((sum, clip) => sum + clip.seconds, 0);

    let review = null;
    try {
      review = await reviewContent(ctx.llm, settings['analysis.model'], clips.map((clip) => clip.text).join('\n'));
    } catch (err) {
      log('warn', `Content review unavailable for Short ${shortId}: ${err.message}`, {entity: 'short', id: shortId});
    }
    const compliance = evaluate({creator, clips, review, usedMomentIds: usedMomentIds(db, shortId), settings});
    if (seconds < settings['short.minSeconds'] - TRIM_ALLOWANCE) {
      compliance.passed = false;
      compliance.failures.push({check: 'length', detail: `only ${seconds.toFixed(1)}s of usable footage after trimming dead air`});
    }
    db.run('UPDATE shorts SET compliance_json = ? WHERE id = ?', JSON.stringify({...compliance, review, clips}), shortId);
    if (!compliance.passed) {
      const reason = compliance.failures.map((failure) => `${failure.check}: ${failure.detail}`).join('; ');
      setStatus(db, shortId, 'compliance_rejected', reason);
      logEvent(db, 'warn', `Short ${shortId} failed compliance — ${reason}`, {entity: 'short', id: shortId});
      fs.rmSync(workDir, {recursive: true, force: true});
      return;
    }

    setStatus(db, shortId, 'rendering');
    const {name: styleName, style} = styleFor(shortId, creator, short.style);
    const props = {video: {title: plan.header, doneStart: 0, pips: segments.length, segments}, credit: `Clips from ${creator.name} on YouTube`, style};
    let lastSaved = 0;
    await ctx.renderShort({
      workDir,
      props,
      output,
      concurrency: settings['render.concurrency'],
      onProgress: (progress) => {
        if (progress - lastSaved >= 0.02 || progress === 1) {
          lastSaved = progress;
          db.run('UPDATE shorts SET progress = ? WHERE id = ?', progress, shortId);
        }
      },
    });
    const verify = await ctx.verifyRender(output, {
      minSeconds: settings['short.minSeconds'] - TRIM_ALLOWANCE,
      maxSeconds: settings['short.maxSeconds'],
      captionWords: clips.reduce((sum, clip) => sum + clip.wordCount, 0),
    });
    db.run('UPDATE shorts SET verify_json = ?, style = ?, output_path = ?, output_sha256 = ?, progress = 1 WHERE id = ?', JSON.stringify(verify), styleName, output, verify.ok ? await hashFile(output) : null, shortId);
    // Source footage is only kept as long as it takes to make the Short.
    fs.rmSync(workDir, {recursive: true, force: true});
    for (const section of sections) {
      fs.rmSync(section, {force: true});
    }
    if (!verify.ok) {
      const reason = verify.checks.filter((check) => !check.ok && check.mandatory).map((check) => `${check.name}: ${check.detail}`).join('; ');
      setStatus(db, shortId, 'verify_failed', reason);
      logEvent(db, 'error', `Short ${shortId} failed verification — ${reason}`, {entity: 'short', id: shortId});
      return;
    }
    setStatus(db, shortId, 'rendered');
    short = db.get('SELECT * FROM shorts WHERE id = ?', shortId);
  }

  const clips = JSON.parse(short.compliance_json).clips;
  const metadata = await buildMetadata({
    llm: ctx.llm,
    model: settings['analysis.model'],
    creatorName: creator.name,
    sourceTitle: source.title,
    sourceUrl: source.url,
    clips,
    existingTitles: db.all('SELECT metadata_json FROM shorts WHERE id != ? AND metadata_json IS NOT NULL', shortId).map((row) => JSON.parse(row.metadata_json).title),
    categoryId: settings['upload.categoryId'],
  });
  const approved = !settings.requireApproval;
  db.run('UPDATE shorts SET metadata_json = ?, status = ?, approved_at = ?, fail_reason = NULL, updated_at = ? WHERE id = ?', JSON.stringify(metadata), approved ? 'approved' : 'awaiting_approval', approved ? now() : null, now(), shortId);
  logEvent(db, 'info', `Short ${shortId} is ready: "${metadata.title}"${approved ? '' : ' — waiting for approval'}.`, {entity: 'short', id: shortId});
};
