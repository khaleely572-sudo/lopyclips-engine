import * as youtube from '../../scripts/youtube/youtube.mjs';
import {evaluate} from '../compliance/gate.mjs';
import {logEvent, now} from '../db/db.mjs';
import {VISIBILITIES, getSettings} from '../db/settings.mjs';
import {PermanentError} from '../jobs/queue.mjs';
import {clearUploadHold, getUploadHold, isUploadLimit, startUploadHold} from './hold.mjs';
import {quotaUsed, recordQuota} from './quota.mjs';
import {localClock} from './scheduler.mjs';

/** Moments already committed to another Short that is approved, on its way up, or published. */
export const usedMomentIds = (db, exceptShortId) =>
  new Set(
    db
      .all("SELECT sm.moment_id FROM short_moments sm JOIN shorts s ON s.id = sm.short_id WHERE s.id != ? AND s.status IN ('approved','uploading','uploaded')", exceptShortId)
      .map((row) => row.moment_id),
  );

/** Re-run the compliance decision with today's permission and settings, using the stored content review. */
export const recheckCompliance = (db, short, settings = getSettings(db)) => {
  const stored = JSON.parse(short.compliance_json ?? 'null');
  const creator = db.get('SELECT c.* FROM creators c JOIN sources s ON s.creator_id = c.id WHERE s.video_id = ?', short.source_id);
  return evaluate({creator, clips: stored?.clips ?? [], review: stored?.review ?? null, usedMomentIds: usedMomentIds(db, short.id), settings});
};

const hasConfirmedPrivateUpload = (db) => Boolean(db.get("SELECT 1 FROM uploads WHERE state = 'confirmed' AND visibility = 'private' LIMIT 1"));

/** Whether the current settings permit a non-private upload, and if not, why. */
export const visibilityAllowed = (db, settings) => {
  const visibility = settings['upload.visibility'];
  if (!VISIBILITIES.includes(visibility)) {
    return {ok: false, reason: `Unknown visibility "${visibility}".`};
  }
  if (visibility === 'private') {
    return {ok: true};
  }
  if (!settings['upload.allowNonPrivate']) {
    return {ok: false, reason: `Visibility is set to ${visibility}, but non-private uploads have not been switched on.`};
  }
  if (!hasConfirmedPrivateUpload(db)) {
    return {ok: false, reason: `A ${visibility} upload needs at least one confirmed private upload from this engine first.`};
  }
  return {ok: true};
};

/**
 * Upload one approved Short. Safe to call again after a crash or a timeout: a confirmed
 * upload is never repeated, an open session is resumed, and if the session has gone the
 * channel's recent uploads are checked before anything is sent a second time.
 *
 * ctx: {db, getVerifiedClient, log, youtube?}  (`youtube` replaces the API calls in tests)
 */
export const uploadShort = async (ctx, shortId, {slotKey = null} = {}) => {
  const {db} = ctx;
  const {SessionExpiredError, getPrivacyStatus, hashFile, listMyRecentUploads, uploadVideoResumable, validateVideoFile} = {...youtube, ...ctx.youtube};
  const settings = getSettings(db);
  const short = db.get('SELECT * FROM shorts WHERE id = ?', shortId);
  if (!short) {
    throw new PermanentError(`Short ${shortId} does not exist.`);
  }
  const existing = db.get('SELECT * FROM uploads WHERE short_id = ?', shortId);
  if (existing?.state === 'confirmed') {
    return {status: 'already-uploaded', videoId: existing.video_id};
  }
  if (settings['automation.emergencyStop']) {
    throw new PermanentError('The emergency stop is on. Nothing is uploaded until it is cleared.');
  }
  if (!['approved', 'uploading'].includes(short.status)) {
    throw new PermanentError(`Short ${shortId} is "${short.status}", not approved, so it will not be uploaded.`);
  }
  const compliance = recheckCompliance(db, short, settings);
  if (!compliance.passed) {
    db.run("UPDATE shorts SET status = 'compliance_rejected', fail_reason = ?, updated_at = ? WHERE id = ?", compliance.failures.map((f) => `${f.check}: ${f.detail}`).join('; '), now(), shortId);
    throw new PermanentError(`Short ${shortId} no longer passes compliance: ${compliance.failures.map((f) => f.check).join(', ')}.`);
  }
  const allowed = visibilityAllowed(db, settings);
  if (!allowed.ok) {
    throw new PermanentError(allowed.reason);
  }
  const visibility = settings['upload.visibility'];
  if (settings.dryRun) {
    logEvent(db, 'info', `Dry run: Short ${shortId} would have been uploaded as ${visibility}.`, {entity: 'short', id: shortId});
    return {status: 'dry-run'};
  }
  // While YouTube is refusing uploads for this channel, a scheduled video waits its turn without asking again.
  // One the owner sends by hand is still tried, because they asked for it.
  const waiting = getUploadHold(db);
  if (waiting && slotKey !== 'manual') {
    return {status: 'held', until: waiting.until};
  }
  if (!existing?.session_uri && quotaUsed(db, 'insert') >= settings['quota.insertPerDay']) {
    throw new Error(`Today's upload quota (${settings['quota.insertPerDay']}) is used up. It resets at midnight Pacific time.`);
  }

  const video = await validateVideoFile(short.output_path);
  if (short.output_sha256 && (await hashFile(video.file)) !== short.output_sha256) {
    throw new PermanentError(`The rendered file for Short ${shortId} has changed since it was verified. Rerender it.`);
  }
  const metadata = JSON.parse(short.metadata_json ?? 'null');
  if (!metadata?.title || !metadata?.description) {
    throw new PermanentError(`Short ${shortId} has no title and description.`);
  }
  const {client, channel} = await ctx.getVerifiedClient();

  if (!existing) {
    db.run("INSERT INTO uploads (short_id, state, visibility, slot_key, created_at) VALUES (?, 'pending', ?, ?, ?)", shortId, visibility, slotKey, now());
  }
  db.run("UPDATE shorts SET status = 'uploading', updated_at = ? WHERE id = ?", now(), shortId);
  db.run('UPDATE uploads SET attempts = attempts + 1, started_at = COALESCE(started_at, ?) WHERE short_id = ?', now(), shortId);
  const upload = db.get('SELECT * FROM uploads WHERE short_id = ?', shortId);

  // Always stated explicitly: YouTube treats a missing privacyStatus as public.
  const body = {
    snippet: {title: metadata.title, description: metadata.description, tags: metadata.tags ?? [], categoryId: metadata.categoryId ?? settings['upload.categoryId']},
    status: {privacyStatus: upload.visibility, selfDeclaredMadeForKids: false},
  };
  const send = (resumeSession) =>
    uploadVideoResumable(client, video, body, {
      resumeSession,
      shouldAbort: () => getSettings(db)['automation.emergencyStop'],
      onSession: (uri) => {
        recordQuota(db, 'insert');
        db.run("UPDATE uploads SET session_uri = ?, state = 'uploading' WHERE short_id = ?", uri, shortId);
      },
    });

  let videoId;
  try {
    try {
      videoId = await send(upload.session_uri);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) {
        throw err;
      }
      // The session is gone. It may have finished before we lost track of it, so look before sending again.
      const since = Date.parse(upload.started_at) - 5 * 60 * 1000;
      const match = (await listMyRecentUploads(client)).find((item) => item.title === body.snippet.title && Date.parse(item.publishedAt) >= since);
      if (match?.videoId) {
        ctx.log('warn', `Short ${shortId}: found the finished upload on the channel after a lost session; adopting it.`, {entity: 'short', id: shortId});
        videoId = match.videoId;
      } else {
        db.run('UPDATE uploads SET session_uri = NULL WHERE short_id = ?', shortId);
        videoId = await send(null);
      }
    }
  } catch (err) {
    db.run('UPDATE uploads SET last_error = ? WHERE short_id = ?', String(err.message).slice(0, 1000), shortId);
    if (!isUploadLimit(err)) {
      throw err;
    }
    // YouTube's own daily cap for the channel. Trying again in a few minutes cannot help, so the Short keeps its
    // place at the front of the line and scheduled posting pauses until room should have opened up.
    const hold = startUploadHold(db);
    db.run("UPDATE shorts SET status = 'approved', updated_at = ? WHERE id = ?", now(), shortId);
    logEvent(
      db,
      'warn',
      `YouTube has capped this channel's uploads for now. That is YouTube's own limit, reached after ${hold.uploadsLast24h} upload(s) in the last 24 hours; nothing is wrong with the video. Short ${shortId} stays first in line, and scheduled posting is on hold until ${localClock(hold.until, settings['schedule.timezone'])}, when one video is tried again.`,
      {entity: 'schedule', id: 'upload-hold', data: hold},
    );
    return {status: 'held', until: hold.until};
  }

  let reported = null;
  try {
    reported = await getPrivacyStatus(client, videoId);
  } catch {
    reported = null;
  }
  db.tx(() => {
    db.run("UPDATE uploads SET state = 'confirmed', video_id = ?, reported_privacy = ?, confirmed_at = ?, last_error = NULL, session_uri = NULL WHERE short_id = ?", videoId, reported, now(), shortId);
    db.run("UPDATE shorts SET status = 'uploaded', updated_at = ? WHERE id = ?", now(), shortId);
    db.run("UPDATE moments SET status = 'used' WHERE id IN (SELECT moment_id FROM short_moments WHERE short_id = ?)", shortId);
  });
  clearUploadHold(db);
  const mismatch = reported && reported !== upload.visibility;
  logEvent(db, mismatch ? 'error' : 'info', `Short ${shortId} uploaded to ${channel.title} as ${upload.visibility}${mismatch ? `, but YouTube reports it as ${reported}` : ''}.`, {
    entity: 'short',
    id: shortId,
    data: {videoId, reported},
  });
  return {status: 'uploaded', videoId, reportedPrivacy: reported};
};
