import {logEvent, now} from '../db/db.mjs';
import {PermanentError, enqueue} from '../jobs/queue.mjs';
import {checkAccess} from '../sources/access.mjs';

/**
 * Find a creator's new long videos through the official API and store them.
 * Only metadata is read here; nothing is fetched from the video itself.
 */
export const discoverCreator = async (db, yt, creator, settings, at = new Date()) => {
  let current = creator;
  if (!current.uploads_playlist_id) {
    const channel = await yt.resolveChannel({handle: current.handle, channelId: current.channel_id});
    if (!channel?.uploadsPlaylistId) {
      throw new PermanentError(`No YouTube channel found for "${current.name}" (${current.handle ?? current.channel_id}). Fix the handle in the dashboard.`);
    }
    db.run('UPDATE creators SET channel_id = ?, uploads_playlist_id = ? WHERE id = ?', channel.channelId, channel.uploadsPlaylistId, current.id);
    current = {...current, channel_id: channel.channelId, uploads_playlist_id: channel.uploadsPlaylistId};
    logEvent(db, 'info', `Resolved ${current.handle} to channel "${channel.title}"`, {entity: 'creator', id: current.id});
  }

  const ids = await yt.recentUploadIds(current.uploads_playlist_id, settings['discovery.maxPerPoll']);
  if (ids === null) {
    throw new PermanentError(`"${current.name}" (${current.handle}) is a channel with no public uploads. It is probably the wrong handle; fix it in the dashboard.`);
  }
  if (ids.length === 0) {
    return [];
  }
  const known = new Set(db.all(`SELECT video_id FROM sources WHERE video_id IN (${ids.map(() => '?').join(',')})`, ...ids).map((row) => row.video_id));
  const details = await yt.videoDetails(ids.filter((id) => !known.has(id)));

  const access = checkAccess(current);
  const minSeconds = settings['discovery.minDurationMinutes'] * 60;
  const oldest = at.getTime() - settings['discovery.maxAgeDays'] * 86_400_000;
  const added = [];
  for (const video of details) {
    if (video.liveState !== 'none') {
      continue; // still live or upcoming: look again on a later poll
    }
    let status = 'discovered';
    let reason = null;
    if (video.durationS === null || video.durationS < minSeconds) {
      [status, reason] = ['skipped', `shorter than ${settings['discovery.minDurationMinutes']} minutes`];
    } else if (video.publishedAt && Date.parse(video.publishedAt) < oldest) {
      [status, reason] = ['skipped', `published more than ${settings['discovery.maxAgeDays']} days ago`];
    } else if (!access.allowed) {
      [status, reason] = ['blocked', access.reason];
    }
    const stamp = now();
    db.run(
      'INSERT OR IGNORE INTO sources (video_id, creator_id, title, url, published_at, duration_s, kind, status, blocked_reason, meta_json, discovered_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      video.videoId,
      current.id,
      video.title,
      `https://www.youtube.com/watch?v=${video.videoId}`,
      video.publishedAt,
      video.durationS,
      video.wasLive ? 'stream' : 'video',
      status,
      reason,
      JSON.stringify({channelTitle: video.channelTitle, language: video.language}),
      stamp,
      stamp,
    );
    if (status === 'discovered') {
      enqueue(db, 'transcript', {videoId: video.videoId}, {key: `transcript:${video.videoId}`});
    }
    added.push({videoId: video.videoId, status, reason});
  }
  return added;
};
