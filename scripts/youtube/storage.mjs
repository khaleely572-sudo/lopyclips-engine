import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import {promisify} from 'node:util';

const run = promisify(execFile);

export class SetupError extends Error {}
export class NotConnectedError extends Error {}

const windowsAccount = () => {
  const user = process.env.USERNAME || os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
};

/** Limit a file or directory to the current user. Returns false when it could not be applied. */
export const restrictToCurrentUser = async (target, isDirectory) => {
  try {
    if (process.platform === 'win32') {
      const grant = `${windowsAccount()}:${isDirectory ? '(OI)(CI)F' : 'F'}`;
      await run('icacls', [target, '/inheritance:r', '/grant:r', grant]);
    } else {
      await fs.chmod(target, isDirectory ? 0o700 : 0o600);
    }
    return true;
  } catch {
    return false;
  }
};

export const ensurePrivateDir = async (dir) => {
  await fs.mkdir(dir, {recursive: true});
  return restrictToCurrentUser(dir, true);
};

export const writePrivateJson = async (file, dir, value) => {
  await ensurePrivateDir(dir);
  await fs.writeFile(file, JSON.stringify(value, null, 2), {encoding: 'utf8', mode: 0o600});
  await restrictToCurrentUser(file, false);
};

export const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

export const removeFile = async (file) => {
  try {
    await fs.unlink(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
};

/**
 * Read the Desktop-app OAuth client file and check its shape.
 * Error messages name the problem but never include values from the file.
 */
export const loadClientConfig = async (file) => {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new SetupError(
        `OAuth client file not found.\n  Expected at: ${file}\n` +
          '  Move the JSON you downloaded for the "LopyClips Local Client" Desktop app\n' +
          '  (Google Cloud Console > APIs & Services > Credentials) to that exact path.',
      );
    }
    throw err;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new SetupError(`The OAuth client file is not valid JSON: ${file}`);
  }
  if (json && json.web) {
    throw new SetupError(
      'The OAuth client file is for a "Web application" client. Create an OAuth client of type ' +
        '"Desktop app" in Google Cloud and download that JSON instead.',
    );
  }
  const client = json && json.installed;
  if (!client || typeof client !== 'object') {
    throw new SetupError('The OAuth client file does not have the Desktop-app ("installed") structure.');
  }
  for (const key of ['client_id', 'client_secret', 'auth_uri', 'token_uri']) {
    if (typeof client[key] !== 'string' || client[key].length === 0) {
      throw new SetupError(`The OAuth client file is missing the "${key}" field.`);
    }
  }
  if (!client.client_id.endsWith('.apps.googleusercontent.com')) {
    throw new SetupError('The "client_id" in the OAuth client file is not a Google OAuth client ID.');
  }
  if (new URL(client.auth_uri).hostname !== 'accounts.google.com') {
    throw new SetupError('The "auth_uri" in the OAuth client file does not point at accounts.google.com.');
  }
  if (client.token_uri !== 'https://oauth2.googleapis.com/token') {
    throw new SetupError('The "token_uri" in the OAuth client file does not point at oauth2.googleapis.com.');
  }
  const redirects = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  if (!redirects.some((uri) => typeof uri === 'string' && uri.startsWith('http://localhost'))) {
    throw new SetupError('The OAuth client file has no http://localhost redirect, so it is not a Desktop-app client.');
  }
  return {clientId: client.client_id, clientSecret: client.client_secret};
};
