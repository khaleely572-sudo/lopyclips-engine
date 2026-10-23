import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {getPaths} from '../scripts/youtube/config.mjs';
import {ensurePrivateDir, restrictToCurrentUser} from '../scripts/youtube/storage.mjs';

const {secretsDir} = getPaths();
const KEY_FILE = path.join(secretsDir, 'nvidia-api-key.txt');

/** The stored NVIDIA API key, or null. Callers must never log or display it. */
export const readNimKey = () => {
  const fromEnv = process.env.NVIDIA_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

export const looksLikeNimKey = (key) => /^nvapi-[\w-]{20,}$/.test(key);

/** Store the key in the secrets folder, readable only by the current Windows user. */
export const saveNimKey = async (key) => {
  await ensurePrivateDir(secretsDir);
  await fs.promises.writeFile(KEY_FILE, key, {encoding: 'utf8', mode: 0o600});
  await restrictToCurrentUser(KEY_FILE, false);
};

/** Ask for a line of input without showing what is typed or pasted. */
export const askHidden = (prompt) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    // The prompt goes on its own line: readline clears the line it waits on, which would erase it.
    process.stdout.write(`${prompt}\n`);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
