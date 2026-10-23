// Offline checks. Nothing here contacts Google or reads the real credentials' values.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {getAuthorizedClient, startCallbackServer} from './auth.mjs';
import {PRIVACY_STATUS, PROJECT_ROOT, SCOPES, getPaths} from './config.mjs';
import {NotConnectedError, SetupError, loadClientConfig} from './storage.mjs';
import {UploadError, buildTestMetadata, uploadPrivateVideo, validateVideoFile} from './youtube.mjs';

const FAKE_SECRET = 'fixture-secret-value';
const fixture = (overrides = {}, type = 'installed') => ({
  [type]: {
    client_id: 'fixture.apps.googleusercontent.com',
    client_secret: FAKE_SECRET,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: ['http://localhost'],
    ...overrides,
  },
});

const tempRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lopyclips-test-'));
  await fs.mkdir(path.join(root, 'secrets'));
  return root;
};
const writeClient = (root, value) => fs.writeFile(path.join(root, 'secrets', 'youtube-oauth-client.json'), JSON.stringify(value));

test('missing credentials give a useful error', async () => {
  const root = await tempRoot();
  await assert.rejects(loadClientConfig(getPaths(root).credentials), (err) => err instanceof SetupError && /not found/.test(err.message) && err.message.includes('secrets'));
});

test('a Desktop-app client file is accepted', async () => {
  const root = await tempRoot();
  await writeClient(root, fixture());
  const config = await loadClientConfig(getPaths(root).credentials);
  assert.equal(config.clientId, 'fixture.apps.googleusercontent.com');
});

test('wrong client types and endpoints are rejected without leaking values', async () => {
  const cases = [fixture({}, 'web'), fixture({token_uri: 'https://example.com/token'}), fixture({client_secret: ''}), fixture({redirect_uris: []}), {}];
  for (const value of cases) {
    const root = await tempRoot();
    await writeClient(root, value);
    await assert.rejects(loadClientConfig(getPaths(root).credentials), (err) => err instanceof SetupError && !err.message.includes(FAKE_SECRET));
  }
});

test('the OAuth callback rejects a wrong state and accepts the right one', async () => {
  const bad = await startCallbackServer('expected-state', 5000);
  const badOutcome = assert.rejects(bad.result, /state check/);
  const badResponse = await fetch(`http://127.0.0.1:${bad.port}/?state=forged&code=abc`);
  assert.equal(badResponse.status, 400);
  await badOutcome;

  const good = await startCallbackServer('expected-state', 5000);
  const goodResponse = await fetch(`http://127.0.0.1:${good.port}/?state=expected-state&code=abc`);
  assert.equal(goodResponse.status, 200);
  assert.equal(await good.result, 'abc');
});

test('cancelling in the browser is reported as a cancellation', async () => {
  const server = await startCallbackServer('s', 5000);
  const outcome = assert.rejects(server.result, /cancelled/);
  await fetch(`http://127.0.0.1:${server.port}/?state=s&error=access_denied`);
  await outcome;
});

test('missing or corrupt tokens mean "not connected"', async () => {
  const root = await tempRoot();
  await writeClient(root, fixture());
  await assert.rejects(getAuthorizedClient(getPaths(root)), NotConnectedError);
  await fs.mkdir(path.join(root, 'tokens'));
  await fs.writeFile(getPaths(root).token, '{not json');
  await assert.rejects(getAuthorizedClient(getPaths(root)), NotConnectedError);
});

test('the upload command rejects missing and non-video files', async () => {
  await assert.rejects(validateVideoFile(path.join(os.tmpdir(), 'does-not-exist.mp4')), /not found/);
  await assert.rejects(validateVideoFile(undefined), UploadError);
  const root = await tempRoot();
  const fake = path.join(root, 'notes.mp4');
  await fs.writeFile(fake, 'this is text, not a video');
  await assert.rejects(validateVideoFile(fake), /does not look like a video/);
});

test('uploads are private and cannot be switched', async () => {
  assert.equal(PRIVACY_STATUS, 'private');
  const metadata = buildTestMetadata('C:/x/clip.mp4');
  assert.equal(metadata.status.privacyStatus, 'private');
  assert.throws(() => {
    metadata.status.privacyStatus = 'something-else';
  });
  const altered = {snippet: metadata.snippet, status: {privacyStatus: 'something-else'}};
  const neverCalled = {request: () => assert.fail('no request should be sent')};
  await assert.rejects(uploadPrivateVideo(neverCalled, {file: 'x', size: 1, mimeType: 'video/mp4'}, altered), /only private/);
});

test('only upload and read-only scopes are requested', () => {
  assert.deepEqual(SCOPES, ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']);
});

test('no other visibility, scheduler or publishing code exists', async () => {
  const dir = path.join(PROJECT_ROOT, 'scripts', 'youtube');
  for (const name of await fs.readdir(dir)) {
    if (name === 'selftest.mjs') {
      continue;
    }
    const source = await fs.readFile(path.join(dir, name), 'utf8');
    assert.doesNotMatch(source, /['"`](public|unlisted)['"`]/, `${name} mentions another visibility`);
    assert.doesNotMatch(source, /setInterval|node-cron|publishAt|schedule/i, `${name} contains scheduling code`);
  }
});

test('.gitignore protects credentials and tokens', async () => {
  const lines = (await fs.readFile(path.join(PROJECT_ROOT, '.gitignore'), 'utf8')).split(/\r?\n/);
  for (const entry of ['/secrets/', '/token.json', '/tokens/', '/.env', '/.env.*']) {
    assert.ok(lines.includes(entry), `${entry} missing from .gitignore`);
  }
});
