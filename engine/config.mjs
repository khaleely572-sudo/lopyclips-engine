import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PROJECT_ROOT} from '../scripts/youtube/config.mjs';

export {PROJECT_ROOT};

const envFile = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const DATA_DIR = process.env.LOPYCLIPS_DATA_DIR || path.join(PROJECT_ROOT, 'data');
export const dirs = {
  data: DATA_DIR,
  transcripts: path.join(DATA_DIR, 'transcripts'),
  sections: path.join(DATA_DIR, 'sections'),
  work: path.join(DATA_DIR, 'work'),
  renders: path.join(DATA_DIR, 'renders'),
  logs: path.join(DATA_DIR, 'logs'),
};
export const DB_PATH = path.join(DATA_DIR, 'lopyclips.db');
export const CREATORS_SEED = path.join(PROJECT_ROOT, 'config', 'creators.json');
export const SKILL_CLIP_SCRIPT = process.env.LOPYCLIPS_CLIPPER_SCRIPT || path.join(os.homedir(), '.claude', 'skills', 'Youtube-clipper-skill', 'scripts', 'clip_video.py');
export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const NIM_URL = process.env.NVIDIA_NIM_URL || 'https://integrate.api.nvidia.com/v1';
/** For "openai:" models: any OpenAI-compatible chat API. */
export const OPENAI_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
export const DASHBOARD_PORT = Number(process.env.LOPYCLIPS_PORT || 4317);
export const PYTHON = process.platform === 'win32' ? 'py' : 'python3';
export const FPS = 30;

export const ensureDirs = () => {
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, {recursive: true});
  }
};

/** A process started from an app can carry a stale PATH; pick up tools installed since. */
export const refreshPath = () => {
  if (process.platform !== 'win32') {
    return;
  }
  try {
    const fresh = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      {encoding: 'utf8'},
    ).trim();
    process.env.PATH = `${fresh};${process.env.PATH ?? ''}`;
  } catch {
    // Keep the inherited PATH.
  }
};
