import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {PermanentError} from '../jobs/queue.mjs';
import {assertAccess} from './access.mjs';

const exec = promisify(execFile);
const HLS_FORMAT = 'bv*[protocol^=m3u8][height<=1080]+ba[protocol^=m3u8]/b[protocol^=m3u8][height<=1080]';

/** No single fetch may cover more than this, so a whole video can never be pulled. */
export const MAX_SECTION_SECONDS = 90;
const RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;

const videoUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
const defaultRun = (command, args) => exec(command, args, {maxBuffer: 16 * 1024 * 1024});

const checkSection = (from, to) => {
  if (!(to > from) || to - from > MAX_SECTION_SECONDS) {
    throw new PermanentError(`Refusing to fetch a ${Math.round(to - from)}s section; the limit is ${MAX_SECTION_SECONDS}s.`);
  }
};

/**
 * Fetches captions and short sections with yt-dlp. Every entry point re-checks the
 * creator's permission, so nothing reaches yt-dlp for a creator who is not authorized.
 */
export const createYtdlpProvider = ({run = defaultRun} = {}) => ({
  name: 'yt-dlp',
  /**
   * Returns the caption file, or null when the video has no English captions. One track is
   * asked for at a time, and a file already on disk is used without another request.
   */
  async fetchCaptions(creator, source, dir) {
    assertAccess(creator);
    for (const lang of ['en-orig', 'en']) {
      const file = path.join(dir, `${source.video_id}.${lang}.json3`);
      if (fs.existsSync(file)) {
        return file;
      }
      try {
        await run('yt-dlp', ['--skip-download', '--no-playlist', '--write-auto-subs', '--sub-langs', lang, '--sub-format', 'json3', '--sleep-subtitles', '1', '-o', path.join(dir, '%(id)s.%(ext)s'), videoUrl(source.video_id)]);
      } catch (err) {
        if (fs.existsSync(file)) {
          return file;
        }
        const detail = String(err.stderr || err.message);
        if (detail.includes('429')) {
          const limited = new Error('YouTube is rate-limiting caption requests (HTTP 429). This is retried later.');
          limited.retryAfterMs = RATE_LIMIT_WAIT_MS;
          throw limited;
        }
        throw new Error(`yt-dlp could not fetch captions: ${detail.trim().split(/\r?\n/).at(-1).slice(0, 300)}`);
      }
      if (fs.existsSync(file)) {
        return file;
      }
    }
    return null;
  },
  async fetchSection(creator, source, from, to, dest) {
    assertAccess(creator);
    checkSection(from, to);
    await run('yt-dlp', ['--no-playlist', '-f', HLS_FORMAT, '--merge-output-format', 'mp4', '--force-keyframes-at-cuts', '--download-sections', `*${from}-${to}`, '--no-progress', '-q', '-o', dest, videoUrl(source.video_id)]);
    if (!fs.existsSync(dest)) {
      throw new Error('yt-dlp produced no file for this section.');
    }
    return dest;
  },
});

/**
 * For a file the channel owner supplied (their own footage, or sent by a creator).
 * Expects captions next to it as <file>.json3. The same permission and length rules apply.
 */
export const createLocalProvider = ({run = defaultRun} = {}) => ({
  name: 'local file',
  async fetchCaptions(creator, source) {
    assertAccess(creator);
    const sidecar = `${JSON.parse(source.meta_json ?? '{}').localPath}.json3`;
    return fs.existsSync(sidecar) ? sidecar : null;
  },
  async fetchSection(creator, source, from, to, dest) {
    assertAccess(creator);
    checkSection(from, to);
    const input = JSON.parse(source.meta_json ?? '{}').localPath;
    if (!input || !fs.existsSync(input)) {
      throw new PermanentError('The local source file is missing.');
    }
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(from), '-i', input, '-t', String(to - from), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-c:a', 'aac', dest]);
    return dest;
  },
});

export const providerFor = (source, providers) => (source.kind === 'local' ? providers.local : providers.ytdlp);
