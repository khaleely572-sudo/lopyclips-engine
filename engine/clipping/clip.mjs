import {execFile} from 'node:child_process';
import fs from 'node:fs';
import {promisify} from 'node:util';
import {FPS, PYTHON, SKILL_CLIP_SCRIPT} from '../config.mjs';

const exec = promisify(execFile);
const GOP = 6;
const GRID = GOP / FPS; // the skill cuts by stream copy, so cuts must land on these keyframes
const RMS_STEP = 0.25;
const RMS_RATE = 8000;
const QUIET = 500;

export const snapToGrid = (seconds) => Math.round(seconds / GRID) * GRID;

/** Re-encode a fetched section to 1080p30 with a keyframe every 0.2 s, ready for exact stream-copy cuts. */
export const prepareSection = async (input, output) => {
  await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', input,
    '-vf', `fps=${FPS},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0',
    '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', output,
  ]);
  return output;
};

/** Cut with the installed YouTube clipper skill's clip_video.py. */
export const cutWithSkill = async (prepared, localStart, frames, output) => {
  if (!fs.existsSync(SKILL_CLIP_SCRIPT)) {
    throw new Error(`The YouTube clipper skill is not installed at ${SKILL_CLIP_SCRIPT}.`);
  }
  try {
    await exec(PYTHON, [SKILL_CLIP_SCRIPT, prepared, localStart.toFixed(3), (localStart + frames / FPS).toFixed(4), output], {
      env: {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'},
    });
  } catch (err) {
    throw new Error(`The clipper skill failed: ${String(err.stderr || err.stdout || err.message).slice(-400)}`);
  }
  if (!fs.existsSync(output)) {
    throw new Error('The clipper skill reported success but wrote no file.');
  }
  return output;
};

/** Loudness of a file in quarter-second steps: [{t, level}]. */
export const measureLevels = async (file) => {
  const {stdout} = await exec('ffmpeg', ['-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RMS_RATE), '-f', 's16le', '-'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  const size = RMS_RATE * RMS_STEP;
  const levels = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j += 1) {
      sum += samples[j] * samples[j];
    }
    levels.push({t: i / RMS_RATE, level: Math.sqrt(sum / size)});
  }
  return levels;
};

/** Pull a clip's edges in past dead air, by at most `maxTrim` seconds each side. */
export const trimSilence = (levels, start, end, {maxTrim = 3} = {}) => {
  const loud = levels.filter((entry) => entry.t >= start && entry.t < end && entry.level > QUIET);
  if (loud.length === 0) {
    return {start, end};
  }
  const firstLoud = loud[0].t;
  const lastLoud = loud.at(-1).t + RMS_STEP;
  return {
    start: firstLoud - start > 0.6 ? Math.min(firstLoud - 0.2, start + maxTrim) : start,
    end: end - lastLoud > 0.8 ? Math.max(lastLoud + 0.35, end - maxTrim) : end,
  };
};

/** The single loudest instant in a clip, if it clearly stands out: used for one punch-in zoom. */
export const findPeak = (levels, start, end) => {
  const inside = levels.filter((entry) => entry.t >= start + 0.6 && entry.t < end - 0.6);
  if (inside.length < 8) {
    return null;
  }
  const sorted = inside.map((entry) => entry.level).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const peak = inside.reduce((best, entry) => (entry.level > best.level ? entry : best));
  return peak.level > 6000 && peak.level > 2.2 * median ? peak.t - start : null;
};
