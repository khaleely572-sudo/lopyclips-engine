import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);

/**
 * Check a rendered Short really is what it should be. Returns every check with its
 * result; `ok` is true only when all mandatory ones pass.
 */
export const verifyRender = async (file, {minSeconds, maxSeconds, captionWords}) => {
  const checks = [];
  const add = (name, ok, detail, mandatory = true) => checks.push({name, ok, detail, mandatory});

  let probe = null;
  try {
    const {stdout} = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
    probe = JSON.parse(stdout);
  } catch (err) {
    add('file readable', false, `ffprobe could not read it: ${String(err.message).slice(0, 200)}`);
    return {ok: false, checks};
  }
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration);

  add('file readable', true, `${(Number(probe.format?.size) / 1048576).toFixed(1)} MB`);
  add('duration', duration >= minSeconds - 1 && duration <= maxSeconds + 1, `${duration.toFixed(1)}s (allowed ${minSeconds}-${maxSeconds}s)`);
  add('resolution', video?.width === 1080 && video?.height === 1920, video ? `${video.width}x${video.height}` : 'no video stream');
  add('audio', Boolean(audio), audio ? `${audio.codec_name}, ${audio.sample_rate} Hz` : 'no audio stream');
  add('captions', captionWords > 0, `${captionWords} caption words in the edit`);

  try {
    const {stderr} = await exec('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {maxBuffer: 16 * 1024 * 1024});
    add('decodes cleanly', stderr.trim().length === 0, stderr.trim() ? stderr.trim().slice(0, 200) : 'no decode errors');
  } catch (err) {
    add('decodes cleanly', false, String(err.stderr || err.message).slice(0, 200));
  }

  try {
    const {stderr} = await exec('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], {maxBuffer: 64 * 1024 * 1024});
    const match = [...stderr.matchAll(/I:\s+(-?\d+(?:\.\d+)?) LUFS/g)].at(-1);
    const loudness = match ? Number(match[1]) : null;
    add('loudness', loudness !== null && loudness >= -19 && loudness <= -10, loudness === null ? 'could not measure' : `${loudness} LUFS (target -14)`, false);
  } catch {
    add('loudness', false, 'could not measure', false);
  }

  return {ok: checks.every((check) => check.ok || !check.mandatory), checks, durationSeconds: duration};
};
