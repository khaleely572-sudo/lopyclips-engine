import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {getVerifiedClient} from '../scripts/youtube/verified.mjs';
import {createLlm} from './analysis/llm.mjs';
import {cutWithSkill, measureLevels, prepareSection} from './clipping/clip.mjs';
import {CREATORS_SEED, DB_PATH, NIM_URL, OLLAMA_URL, OPENAI_URL, PYTHON, SKILL_CLIP_SCRIPT, dirs, ensureDirs, refreshPath} from './config.mjs';
import {readNimKey} from './nimKey.mjs';
import {importSeed, listCreators} from './db/creators.mjs';
import {logEvent, openDb} from './db/db.mjs';
import {getSettings} from './db/settings.mjs';
import {createYouTubeData} from './discovery/youtubeData.mjs';
import {enqueue} from './jobs/queue.mjs';
import {renderShort} from './render/render.mjs';
import {verifyRender} from './render/verify.mjs';
import {createLocalProvider, createYtdlpProvider} from './sources/providers.mjs';

const exec = promisify(execFile);

/** Everything the pipeline needs, wired to the real database, tools and services. Tests build their own with fakes. */
export const createContext = () => {
  refreshPath();
  ensureDirs();
  const db = openDb(DB_PATH);
  importSeed(db, CREATORS_SEED);
  const logFile = path.join(dirs.logs, 'engine.log');
  const log = (level, message, meta = {}) => {
    const ts = new Date().toISOString();
    logEvent(db, level, message, meta);
    console.log(`${ts} ${level.toUpperCase().padEnd(5)} ${message}`);
    fs.appendFile(logFile, `${JSON.stringify({ts, level, message, ...meta})}\n`, () => {});
  };
  return {
    db,
    log,
    // The models think before they answer; a careful review can take several minutes, and cutting it off wastes it.
    llm: createLlm({ollamaUrl: OLLAMA_URL, nimUrl: NIM_URL, getNimKey: readNimKey, openaiUrl: OPENAI_URL, getOpenAiKey: () => process.env.OPENAI_API_KEY?.trim() || null, timeoutMs: 480_000}),
    providers: {ytdlp: createYtdlpProvider(), local: createLocalProvider()},
    clip: {prepareSection, cutWithSkill, measureLevels},
    renderShort,
    verifyRender,
    getVerifiedClient: () => getVerifiedClient(),
    createYouTubeData,
  };
};

/** Queue one discovery job per enabled creator. The hourly key stops a restart from queuing them twice. */
export const enqueueDiscovery = (db, at = new Date()) => {
  const bucket = at.toISOString().slice(0, 13);
  return listCreators(db).filter((creator) => creator.enabled && enqueue(db, 'discover', {creatorId: creator.id}, {key: `discover:${creator.id}:${bucket}`, maxAttempts: 3})).length;
};

const toolVersion = async (command, args) => {
  try {
    const {stdout, stderr} = await exec(command, args, {timeout: 20_000});
    return {ok: true, detail: (stdout || stderr).split(/\r?\n/)[0].trim().slice(0, 80)};
  } catch (err) {
    return {ok: false, detail: err.code === 'ENOENT' ? 'not found on PATH' : String(err.message).slice(0, 120)};
  }
};

/** Check every outside dependency once. Used by `doctor` and the dashboard's health panel. */
export const runHealthChecks = async (ctx) => {
  const settings = getSettings(ctx.db);
  const checks = {
    ffmpeg: await toolVersion('ffmpeg', ['-version']),
    ffprobe: await toolVersion('ffprobe', ['-version']),
    'yt-dlp': await toolVersion('yt-dlp', ['--version']),
    python: await toolVersion(PYTHON, ['--version']),
    'clipper skill': fs.existsSync(SKILL_CLIP_SCRIPT) ? {ok: true, detail: 'clip_video.py found'} : {ok: false, detail: `missing: ${SKILL_CLIP_SCRIPT}`},
    database: {ok: true, detail: `${ctx.db.get('SELECT COUNT(*) AS n FROM sources').n} sources stored`},
  };
  for (const key of ['analysis.model', 'analysis.secondModel']) {
    try {
      await ctx.llm.ping(settings[key]);
      checks[`model ${settings[key]}`] = {ok: true, detail: 'answered'};
    } catch (err) {
      checks[`model ${settings[key]}`] = {ok: false, detail: err.message.slice(0, 160)};
    }
  }
  try {
    const {channel} = await ctx.getVerifiedClient();
    checks.youtube = {ok: true, detail: `connected to ${channel.title} (${channel.id})`};
  } catch (err) {
    checks.youtube = {ok: false, detail: err.message.split('\n')[0].slice(0, 200)};
  }
  return {ok: Object.values(checks).every((check) => check.ok), checkedAt: new Date().toISOString(), checks};
};
