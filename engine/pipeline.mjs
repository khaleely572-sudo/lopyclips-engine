import fs from 'node:fs';
import path from 'node:path';
import {buildCalibration, feedbackByMoment, rankingEffect} from './analysis/feedback.mjs';
import {judgeSource} from './analysis/moments.mjs';
import {sectionFor, watchMoments} from './analysis/watch.mjs';
import {arrangeShort, selectMoments} from './analysis/planner.mjs';
import {dirs} from './config.mjs';
import {getCreator} from './db/creators.mjs';
import {logEvent, now} from './db/db.mjs';
import {getSettings} from './db/settings.mjs';
import {discoverCreator} from './discovery/discover.mjs';
import {PermanentError, enqueue} from './jobs/queue.mjs';
import {loadWords, produceShort} from './produce.mjs';
import {recordQuota} from './publish/quota.mjs';
import {localClock} from './publish/scheduler.mjs';
import {uploadShort} from './publish/uploader.mjs';
import {checkAccess} from './sources/access.mjs';
import {providerFor} from './sources/providers.mjs';
import {buildLines, parseJson3} from './sources/transcript.mjs';

const MIN_CAPTION_WORDS = 200;
// YouTube makes the automatic captions of a stream some hours after it goes up. Until a video is this old,
// "no captions" means "not yet", so it is checked again later instead of being given up on.
const CAPTION_WAIT_MS = 72 * 60 * 60 * 1000;
const CAPTION_RECHECK_MS = 3 * 60 * 60 * 1000;

/**
 * Job handlers, one per pipeline step. Each checks the source's current status first,
 * so a job that runs twice (after a crash or a retry) does nothing the second time.
 *
 * ctx: {db, log, llm, providers, clip, renderShort, verifyRender, getVerifiedClient, createYouTubeData}
 */
export const createHandlers = (ctx) => {
  const {db, log} = ctx;

  const load = (videoId) => {
    const source = db.get('SELECT * FROM sources WHERE video_id = ?', videoId);
    if (!source) {
      throw new PermanentError(`Source ${videoId} does not exist.`);
    }
    return {source, creator: getCreator(db, source.creator_id)};
  };
  const setSource = (videoId, status, reason = null) =>
    db.run('UPDATE sources SET status = ?, blocked_reason = ?, updated_at = ? WHERE video_id = ?', status, reason, now(), videoId);

  /** The caption text of a stored moment, or null when its transcript is no longer on disk. */
  const clipText = (moment) => {
    try {
      return loadWords(moment.source_id)
        .filter((word) => word.t >= moment.start_s && word.t < moment.end_s)
        .map((word) => word.w)
        .join(' ');
    } catch {
      return null;
    }
  };

  /** Returns true when the creator's footage may be used; otherwise marks the source blocked. */
  const permitted = (source, creator) => {
    const access = checkAccess(creator);
    if (!access.allowed) {
      setSource(source.video_id, 'blocked', access.reason);
    }
    return access.allowed;
  };

  return {
    async discover({creatorId}) {
      const creator = getCreator(db, creatorId);
      if (!creator || !creator.enabled) {
        return;
      }
      const {client} = await ctx.getVerifiedClient();
      const yt = ctx.createYouTubeData(client, (bucket, units) => recordQuota(db, bucket, units));
      const added = await discoverCreator(db, yt, creator, getSettings(db));
      if (added.length > 0) {
        const tally = added.reduce((counts, item) => ({...counts, [item.status]: (counts[item.status] ?? 0) + 1}), {});
        logEvent(db, 'info', `${creator.name}: ${added.length} new video(s) stored.`, {entity: 'creator', id: creatorId, data: tally});
      }
    },

    async transcript({videoId}) {
      const {source, creator} = load(videoId);
      if (source.status !== 'discovered' || !permitted(source, creator)) {
        return;
      }
      const file = await providerFor(source, ctx.providers).fetchCaptions(creator, source, dirs.transcripts);
      if (!file) {
        const published = Date.parse(source.published_at ?? source.discovered_at);
        if (Date.now() - published < CAPTION_WAIT_MS) {
          const next = new Date(Date.now() + CAPTION_RECHECK_MS);
          db.run('UPDATE sources SET blocked_reason = ?, updated_at = ? WHERE video_id = ?', `YouTube has not made captions for this video yet; checking again around ${localClock(next, getSettings(db)['schedule.timezone'])}`, now(), videoId);
          enqueue(db, 'transcript', {videoId}, {key: `transcript:${videoId}:${next.toISOString()}`, runAfter: next});
          return;
        }
        setSource(videoId, 'blocked', 'no English captions are available for this video, even three days after it was published');
        return;
      }
      const words = parseJson3(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (words.length < MIN_CAPTION_WORDS) {
        setSource(videoId, 'blocked', 'the captions are too sparse to analyse');
        return;
      }
      fs.writeFileSync(path.join(dirs.transcripts, `${videoId}.words.json`), JSON.stringify(words));
      setSource(videoId, 'transcript_ready');
      enqueue(db, 'analyze', {videoId}, {key: `analyze:${videoId}`});
    },

    async analyze({videoId}) {
      const {source, creator} = load(videoId);
      if (source.status !== 'transcript_ready' || !permitted(source, creator)) {
        return;
      }
      const settings = getSettings(db);
      const lines = buildLines(loadWords(videoId));
      // The first model's pass over a long stream is slow. It is kept on disk until the analysis has finished, so a retry does not repeat it.
      const draftFile = path.join(dirs.work, `discovery_${videoId}.json`);
      const draftKey = `${settings['analysis.model']}|${lines.length}`;
      let discovered = null;
      try {
        const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
        discovered = draft.key === draftKey ? draft.found : null;
      } catch {
        // no draft from an earlier attempt
      }
      const result = await judgeSource({
        llm: ctx.llm,
        lines,
        creatorName: creator.name,
        title: source.title,
        settings,
        calibration: buildCalibration(db, clipText),
        discovered,
        onDiscovered: (found) => fs.writeFileSync(draftFile, JSON.stringify({key: draftKey, found})),
        watch:
          settings['analysis.watch'] && settings['analysis.watchMax'] > 0
            ? (moments) => watchMoments({moments, lines, source, creator, provider: providerFor(source, ctx.providers), llm: ctx.llm, settings, sectionsDir: dirs.sections, workDir: dirs.work, frames: ctx.watchFrames, log})
            : null,
        log,
      });
      db.tx(() => {
        for (const moment of result.moments) {
          db.run(
            'INSERT INTO moments (source_id, start_s, end_s, score, confidence, reason, label, quote, risks_json, status, reject_reason, created_at, humor_type, review_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            videoId,
            moment.start,
            moment.end,
            Number(moment.score.toFixed(2)),
            Number(moment.confidence.toFixed(2)),
            moment.reason,
            moment.label,
            moment.quote,
            JSON.stringify(moment.risks),
            moment.status,
            moment.rejectReason,
            now(),
            moment.humorType,
            JSON.stringify(moment.details),
          );
        }
        setSource(videoId, 'analyzed');
      });
      fs.rmSync(draftFile, {force: true});
      const tally = (status) => result.moments.filter((moment) => moment.status === status).length;
      const seen = result.watched ? ` Watched ${result.watched.watched} of ${result.watched.shortlisted} shortlisted clip(s) before deciding${result.watched.stopped ? ' (stopped early: YouTube was limiting requests)' : ''}.` : '';
      logEvent(db, 'info', `Analysed "${source.title}": ${tally('candidate')} candidate(s) out of ${result.proposed} proposed; the second model rejected ${tally('rejected')} and left ${tally('uncertain')} uncertain; ${result.rejected.length} failed the evidence or duplicate check.${seen}`, {
        entity: 'source',
        id: videoId,
        data: {windows: result.windows, failedWindows: result.failedWindows, unreviewed: result.unreviewed, rejected: result.rejected.slice(0, 20)},
      });
      enqueue(db, 'plan', {videoId}, {key: `plan:${videoId}`});
    },

    async plan({videoId}) {
      const {source, creator} = load(videoId);
      if (source.status !== 'analyzed' || !permitted(source, creator)) {
        return;
      }
      const settings = getSettings(db);
      const limits = {targetSeconds: settings['short.targetSeconds'], minSeconds: settings['short.minSeconds'], maxSeconds: settings['short.maxSeconds']};
      const words = loadWords(videoId);
      const textOf = (moment) =>
        words
          .filter((word) => word.t >= moment.start && word.t < moment.end)
          .map((word) => word.w)
          .join(' ');
      let made = 0;
      const plannedClips = [];
      for (let i = 0; i < settings['short.maxPerSource']; i += 1) {
        const rows = db.all("SELECT * FROM moments WHERE source_id = ? AND status = 'candidate'", videoId);
        const ratings = feedbackByMoment(db, rows.map((row) => row.id));
        // The owner's ratings only reorder the pool: a disliked moment is passed over and a liked one goes first.
        const candidates = rows
          .map((row) => ({row, effect: rankingEffect(ratings.get(row.id))}))
          .filter(({effect}) => !effect.skip)
          .map(({row, effect}) => ({id: row.id, start: row.start_s, end: row.end_s, score: row.score + effect.boost, label: row.label}));
        const chosen = selectMoments(candidates, limits);
        if (!chosen) {
          break;
        }
        const arrangement = await arrangeShort({llm: ctx.llm, model: settings['analysis.model'], moments: chosen.map((moment) => ({...moment, text: textOf(moment)})), creatorName: creator.name, limits, log});
        const plan = {
          header: arrangement.header,
          arrangedBy: arrangement.arrangedBy,
          clips: arrangement.clips.map(({moment, label}) => ({momentId: moment.id, start: moment.start, end: moment.end, label})),
        };
        const shortId = db.tx(() => {
          const stamp = now();
          const id = Number(db.run("INSERT INTO shorts (source_id, status, title, plan_json, created_at, updated_at) VALUES (?, 'planned', ?, ?, ?, ?)", videoId, plan.header, JSON.stringify(plan), stamp, stamp).lastInsertRowid);
          plan.clips.forEach((clip, position) => db.run('INSERT INTO short_moments (short_id, moment_id, position) VALUES (?,?,?)', id, clip.momentId, position));
          // Every chosen moment is taken out of the pool, including any the arrangement left out, so it is not offered again.
          for (const moment of chosen) {
            db.run("UPDATE moments SET status = 'selected' WHERE id = ?", moment.id);
          }
          return id;
        });
        enqueue(db, 'produce', {shortId}, {key: `produce:${shortId}:0`, maxAttempts: 3});
        plannedClips.push(...plan.clips);
        made += 1;
      }
      // Sections fetched while watching are kept only for clips that are going into a Short; the editing step reuses those.
      const keep = new Set(plannedClips.map((clip) => path.basename(sectionFor(dirs.sections, videoId, clip).file)));
      for (const name of fs.existsSync(dirs.sections) ? fs.readdirSync(dirs.sections) : []) {
        if (name.startsWith(`${videoId}_`) && !keep.has(name)) {
          fs.rmSync(path.join(dirs.sections, name), {force: true});
        }
      }
      setSource(videoId, made > 0 ? 'planned' : 'exhausted', made > 0 ? null : 'not enough strong moments for a full Short');
      logEvent(db, 'info', made > 0 ? `Planned ${made} Short(s) from "${source.title}".` : `No Short planned from "${source.title}": not enough strong moments.`, {entity: 'source', id: videoId});
    },

    produce: ({shortId}) => produceShort(ctx, shortId),
    upload: ({shortId, slotKey}) => uploadShort(ctx, shortId, {slotKey}),
  };
};
