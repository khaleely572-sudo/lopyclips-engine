import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import {CodeChallengeMethod, OAuth2Client} from 'google-auth-library';
import {SCOPES, UPLOAD_SCOPE, getPaths} from './config.mjs';
import {NotConnectedError, SetupError, loadClientConfig, readJson, removeFile, writePrivateJson} from './storage.mjs';

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>LopyClips</title>` +
  `<body style="font-family:system-ui;margin:3rem"><h2>${title}</h2><p>${body}</p></body>`;

const sameState = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * Listen on a loopback port for Google's redirect. Resolves with the authorization code
 * only when the returned state matches; anything else is rejected.
 */
export const startCallbackServer = async (state, timeoutMs = AUTH_TIMEOUT_MS) => {
  let settle;
  const result = new Promise((resolve, reject) => {
    settle = {resolve, reject};
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const finish = (status, title, body, outcome) => {
      res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(page(title, body));
      outcome();
    };
    const returnedState = url.searchParams.get('state');
    if (!returnedState || !sameState(returnedState, state)) {
      finish(400, 'Sign-in rejected', 'The response did not match this sign-in attempt. Start again from the terminal.', () =>
        settle.reject(new SetupError('The sign-in response failed the state check and was rejected. Run the command again.')),
      );
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const cancelled = error === 'access_denied';
      finish(200, cancelled ? 'Sign-in cancelled' : 'Sign-in failed', 'You can close this tab and return to the terminal.', () =>
        settle.reject(
          new SetupError(cancelled ? 'Sign-in was cancelled in the browser. Nothing was saved.' : `Google returned an OAuth error: ${error}`),
        ),
      );
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      finish(400, 'Sign-in failed', 'No authorization code was returned.', () =>
        settle.reject(new SetupError('Google did not return an authorization code.')),
      );
      return;
    }
    finish(200, 'LopyClips is connected', 'You can close this tab and return to the terminal.', () => settle.resolve(code));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const timer = setTimeout(
    () => settle.reject(new SetupError('Timed out waiting for the Google sign-in to finish. Run the command again.')),
    timeoutMs,
  );
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  result.then(close, close);
  return {port: server.address().port, result};
};

const openBrowser = (url) => {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args, {detached: true, stdio: 'ignore'});
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
};

const persistTokens = async (paths, tokens) => {
  const previous = (await readJson(paths.token)) || {};
  // Google only sends the refresh token on first consent, so keep the stored one.
  await writePrivateJson(paths.token, paths.tokenDir, {...previous, ...tokens});
};

/** Run the browser sign-in and store the resulting tokens. Returns an authorized client. */
export const authorizeInteractive = async (paths = getPaths(), log = console.log) => {
  const {clientId, clientSecret} = await loadClientConfig(paths.credentials);
  const state = crypto.randomBytes(32).toString('base64url');
  const {port, result} = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new OAuth2Client({clientId, clientSecret, redirectUri});
  const {codeVerifier, codeChallenge} = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state,
    prompt: 'consent select_account',
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });
  log('Opening your browser for Google sign-in. Choose the account that owns your YouTube channel.');
  if (!(await openBrowser(authUrl))) {
    log('Could not open a browser automatically. Open this address yourself:\n' + authUrl);
  }
  const code = await result;
  const {tokens} = await client.getToken({code, codeVerifier, redirect_uri: redirectUri});
  const granted = String(tokens.scope || '').split(' ');
  if (!granted.includes(UPLOAD_SCOPE)) {
    throw new SetupError(
      'Google did not grant the upload permission. Run the command again and leave every permission box ticked on the consent screen.',
    );
  }
  if (!tokens.refresh_token) {
    throw new SetupError('Google did not return a refresh token. Run "npm run auth:youtube:logout" and then sign in again.');
  }
  await persistTokens(paths, tokens);
  client.setCredentials(tokens);
  client.on('tokens', (fresh) => void persistTokens(paths, fresh));
  return client;
};

/** Build a client from stored tokens, refreshing the access token when needed. */
export const getAuthorizedClient = async (paths = getPaths()) => {
  const {clientId, clientSecret} = await loadClientConfig(paths.credentials);
  const tokens = await readJson(paths.token);
  if (!tokens || typeof tokens.refresh_token !== 'string') {
    throw new NotConnectedError('No YouTube account is connected. Run "npm run auth:youtube" first.');
  }
  const client = new OAuth2Client({clientId, clientSecret});
  client.setCredentials(tokens);
  client.on('tokens', (fresh) => void persistTokens(paths, fresh));
  try {
    await client.getAccessToken();
  } catch (err) {
    throw describeAuthError(err);
  }
  return client;
};

/** Revoke the grant at Google where possible and delete everything stored locally. */
export const disconnect = async (paths = getPaths()) => {
  const tokens = await readJson(paths.token);
  let revoked = false;
  if (tokens && tokens.refresh_token) {
    try {
      const {clientId, clientSecret} = await loadClientConfig(paths.credentials);
      await new OAuth2Client({clientId, clientSecret}).revokeToken(tokens.refresh_token);
      revoked = true;
    } catch {
      revoked = false;
    }
  }
  const removedToken = await removeFile(paths.token);
  await removeFile(paths.channel);
  return {hadToken: removedToken, revoked};
};

export const describeAuthError = (err) => {
  const code = err?.response?.data?.error;
  if (code === 'invalid_grant') {
    return new NotConnectedError(
      'The stored sign-in has expired or was revoked. Run "npm run auth:youtube" to sign in again.\n' +
        '  (While the Google Cloud consent screen is in "Testing", sign-ins expire after 7 days.)',
    );
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new SetupError(
      'Google rejected the OAuth client. Download a fresh JSON for the Desktop-app client and replace secrets/youtube-oauth-client.json.',
    );
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err?.code)) {
    return new Error('Could not reach Google. Check your internet connection and try again.');
  }
  return err;
};
