import {execFile} from 'node:child_process';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {youtube as youtubeApi} from '@googleapis/youtube';
import {PRIVACY_STATUS} from './config.mjs';

const run = promisify(execFile);
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 6;
const MIME = {'.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska'};

export class UploadError extends Error {}
/** The resumable session no longer exists at YouTube; the upload may or may not have completed. */
export class SessionExpiredError extends UploadError {}

const header = (res, name) => (typeof res.headers?.get === 'function' ? res.headers.get(name) : res.headers?.[name]);

/** The channel that the signed-in account acts as, or null when the account has none. */
export const getMyChannel = async (auth) => {
  const res = await youtubeApi({version: 'v3', auth}).channels.list({part: ['snippet'], mine: true});
  const item = res.data.items?.[0];
  return item ? {id: item.id, title: item.snippet?.title ?? '(untitled channel)'} : null;
};

const looksLikeVideo = async (file) => {
  const handle = await fs.open(file, 'r');
  try {
    const {buffer} = await handle.read(Buffer.alloc(12), 0, 12, 0);
    const isMp4 = buffer.subarray(4, 8).toString('latin1') === 'ftyp';
    const isMatroska = buffer.readUInt32BE(0) === 0x1a45dfa3;
    return isMp4 || isMatroska;
  } finally {
    await handle.close();
  }
};

/** Confirm the path is an existing, readable video. Returns its absolute path, size and type. */
export const validateVideoFile = async (input) => {
  if (!input) {
    throw new UploadError('No video file given. Usage: npm run youtube:test-upload -- "path\\to\\video.mp4"');
  }
  const file = path.resolve(input);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new UploadError(`Video file not found: ${file}`);
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new UploadError(`Not a usable video file (empty or not a file): ${file}`);
  }
  const mimeType = MIME[path.extname(file).toLowerCase()];
  if (!mimeType || !(await looksLikeVideo(file))) {
    throw new UploadError(`This does not look like a video file (expected .mp4, .mov, .webm or .mkv): ${file}`);
  }
  try {
    const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]);
    if (!stdout.trim()) {
      throw new UploadError(`The file has no video stream: ${file}`);
    }
  } catch (err) {
    if (err instanceof UploadError) {
      throw err;
    }
    if (err.code !== 'ENOENT') {
      throw new UploadError(`ffprobe could not read this file as a video: ${file}`);
    }
    // ffprobe is not installed; the container check above is the best available.
  }
  return {file, size: stat.size, mimeType};
};

export const hashFile = (file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

export const buildTestMetadata = (file, now = new Date()) =>
  Object.freeze({
    snippet: Object.freeze({
      title: `LopyClips private upload test - ${path.basename(file)}`.slice(0, 100),
      description: `Private test upload sent by the LopyClips local tool on ${now.toISOString()}. Not for publication.`,
    }),
    status: Object.freeze({privacyStatus: PRIVACY_STATUS, selfDeclaredMadeForKids: false}),
  });

/** The machine-readable reason YouTube gave for an error, e.g. "quotaExceeded". */
export const apiErrorReason = (err) => {
  const body = err?.response?.data?.error;
  return body?.errors?.[0]?.reason ?? body?.status ?? err?.code ?? 'unknown';
};

export const describeApiError = (err) => {
  const body = err?.response?.data?.error;
  const reason = apiErrorReason(err);
  const message = typeof body === 'object' ? body?.message : undefined;
  const next = {
    quotaExceeded: 'The API project has used its daily quota. It resets at midnight Pacific time; try again after that.',
    uploadLimitExceeded: 'YouTube says this channel has reached its upload limit for now. Wait and try again later.',
    youtubeSignupRequired: 'This Google account has no YouTube channel. Create one, or sign in with the right account.',
    insufficientPermissions: 'The upload permission was not granted. Run "npm run auth:youtube:logout" then "npm run auth:youtube".',
    accessNotConfigured: 'YouTube Data API v3 is not enabled for the Google Cloud project. Enable it in the Cloud Console.',
    forbidden: 'YouTube refused the request for this account. Check the channel is in good standing and can upload.',
  }[reason];
  const described = new UploadError(`YouTube API error (${reason}): ${message ?? err?.message ?? 'no detail returned'}${next ? `\n  Next step: ${next}` : ''}`);
  described.reason = reason;
  return described;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const accept = (status) => status === 308 || (status >= 200 && status < 300);

const nextOffset = (res) => {
  const range = header(res, 'range');
  return range ? Number(range.split('-')[1]) + 1 : 0;
};

const askProgress = (auth, session, size) =>
  auth.request({url: session, method: 'PUT', headers: {'Content-Length': '0', 'Content-Range': `bytes */${size}`}, validateStatus: accept, retry: false});

const videoIdFrom = (res) => {
  const id = res.data?.id;
  if (!id) {
    throw new UploadError('YouTube finished the request without returning a video ID, so the upload is not confirmed.');
  }
  return id;
};

/**
 * Upload a video with the resumable protocol and resolve with the new video ID only
 * after YouTube returns it. The visibility is whatever `metadata.status` says, so callers
 * are responsible for it; this module's own command only ever passes private.
 *
 * hooks.onSession(uri)  called once when a new session is opened, so it can be stored
 * hooks.resumeSession   a stored session URI to continue instead of opening a new one
 * hooks.shouldAbort()   checked before every chunk; returning true stops the upload
 */
export const uploadVideoResumable = async (auth, {file, size, mimeType}, metadata, hooks = {}) => {
  const {onProgress = () => {}, onSession = () => {}, resumeSession = null, shouldAbort = () => false} = hooks;
  let session = resumeSession;
  let offset = 0;

  if (session) {
    let res;
    try {
      res = await askProgress(auth, session, size);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404 || status === 410) {
        throw new SessionExpiredError('The stored upload session no longer exists at YouTube.');
      }
      throw describeApiError(err);
    }
    if (res.status !== 308) {
      return videoIdFrom(res);
    }
    offset = nextOffset(res);
  } else {
    try {
      const start = await auth.request({
        url: UPLOAD_URL,
        method: 'POST',
        params: {uploadType: 'resumable', part: 'snippet,status'},
        headers: {'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size)},
        data: metadata,
        retry: false,
      });
      session = header(start, 'location');
    } catch (err) {
      throw describeApiError(err);
    }
    if (!session) {
      throw new UploadError('YouTube did not open an upload session.');
    }
    await onSession(session);
  }

  const handle = await fs.open(file, 'r');
  try {
    let attempts = 0;
    while (true) {
      if (shouldAbort()) {
        throw new UploadError('The upload was stopped before it finished. Nothing was published; it can be resumed.');
      }
      const length = Math.min(CHUNK_BYTES, size - offset);
      const {buffer} = await handle.read(Buffer.alloc(length), 0, length, offset);
      let res;
      try {
        res = await auth.request({
          url: session,
          method: 'PUT',
          headers: {'Content-Type': mimeType, 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`},
          body: buffer,
          validateStatus: accept,
          retry: false,
        });
        attempts = 0;
      } catch (err) {
        const status = err?.response?.status;
        if (status === 404 || status === 410) {
          throw new SessionExpiredError('The upload session expired before the file finished.');
        }
        if (status && status < 500 && status !== 408 && status !== 429) {
          throw describeApiError(err);
        }
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) {
          throw new UploadError(`The upload was interrupted and could not be resumed after ${MAX_ATTEMPTS} attempts. No video was confirmed.`);
        }
        await wait(1000 * 2 ** attempts);
        try {
          // Ask YouTube how much it has, then carry on from there.
          res = await askProgress(auth, session, size);
        } catch {
          continue;
        }
      }
      if (res.status === 308) {
        offset = nextOffset(res);
        onProgress(offset, size);
        continue;
      }
      const id = videoIdFrom(res);
      onProgress(size, size);
      return id;
    }
  } finally {
    await handle.close();
  }
};

/** The test command's upload: refuses anything that is not private. */
export const uploadPrivateVideo = async (auth, video, metadata, onProgress = () => {}) => {
  if (metadata.status.privacyStatus !== PRIVACY_STATUS) {
    throw new UploadError('Refusing to upload: only private uploads are allowed.');
  }
  return uploadVideoResumable(auth, video, metadata, {onProgress});
};

/** Read back the visibility YouTube recorded for a video. */
export const getPrivacyStatus = async (auth, videoId) => {
  const res = await youtubeApi({version: 'v3', auth}).videos.list({part: ['status'], id: [videoId]});
  return res.data.items?.[0]?.status?.privacyStatus ?? null;
};

/**
 * The signed-in channel's most recent uploads, newest first. Used after a crash to see
 * whether an interrupted upload actually completed before retrying it.
 */
export const listMyRecentUploads = async (auth, max = 10) => {
  const api = youtubeApi({version: 'v3', auth});
  const channel = await api.channels.list({part: ['contentDetails'], mine: true});
  const playlistId = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) {
    return [];
  }
  const res = await api.playlistItems.list({part: ['snippet', 'contentDetails'], playlistId, maxResults: max});
  return (res.data.items ?? []).map((item) => ({videoId: item.contentDetails?.videoId, title: item.snippet?.title ?? '', publishedAt: item.snippet?.publishedAt ?? null}));
};
