import path from 'node:path';
import readline from 'node:readline/promises';
import {authorizeInteractive, describeAuthError, disconnect} from './auth.mjs';
import {getPaths} from './config.mjs';
import {NotConnectedError, SetupError, ensurePrivateDir, loadClientConfig, readJson, writePrivateJson} from './storage.mjs';
import {WRONG_ACCOUNT_HELP, getVerifiedClient} from './verified.mjs';
import {UploadError, buildTestMetadata, describeApiError, getMyChannel, getPrivacyStatus, hashFile, uploadPrivateVideo, validateVideoFile} from './youtube.mjs';

const paths = getPaths();
const [command, ...args] = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const fetchChannel = async (client) => {
  try {
    return await getMyChannel(client);
  } catch (err) {
    throw describeApiError(err);
  }
};

const auth = async () => {
  await loadClientConfig(paths.credentials);
  console.log('OAuth client file: found, Desktop-app structure OK.');
  await ensurePrivateDir(paths.secretsDir);

  const existing = await readJson(paths.token);
  if (existing?.refresh_token) {
    console.log('An account is already connected. Run "npm run auth:youtube:status" to see it,\nor "npm run auth:youtube:logout" first to connect a different one.');
    return;
  }

  let client;
  try {
    client = await authorizeInteractive(paths);
  } catch (err) {
    throw describeAuthError(err);
  }
  const channel = await fetchChannel(client);
  if (!channel) {
    await disconnect(paths);
    throw new SetupError(`The account you signed in with has no YouTube channel. The sign-in was removed.\n${WRONG_ACCOUNT_HELP}`);
  }
  console.log(`\nSigned in. Google returned this channel:\n  Channel name: ${channel.title}\n  Channel ID:   ${channel.id}`);

  const expected = flag('expect-channel') ?? process.env.YOUTUBE_EXPECTED_CHANNEL_ID;
  let confirmed;
  if (expected) {
    confirmed = expected === channel.id;
    if (!confirmed) {
      console.log(`This is not the expected channel (${expected}).`);
    }
  } else if (process.stdin.isTTY) {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    const answer = await rl.question('Is this the channel LopyClips should upload to? (y/N) ');
    rl.close();
    confirmed = /^y(es)?$/i.test(answer.trim());
  } else {
    confirmed = false;
    console.log('Cannot ask for confirmation here. Re-run with --expect-channel=<channel ID> to confirm it.');
  }
  if (!confirmed) {
    await disconnect(paths);
    throw new SetupError(`Channel not confirmed, so the sign-in was removed and nothing can be uploaded.\n${WRONG_ACCOUNT_HELP}`);
  }
  await writePrivateJson(paths.channel, paths.tokenDir, {channelId: channel.id, title: channel.title, confirmedAt: new Date().toISOString()});
  console.log('Connected: yes. This channel is now the only one uploads are allowed to go to.');
};

const verifiedClient = () => getVerifiedClient(paths);

const status = async () => {
  try {
    await loadClientConfig(paths.credentials);
    console.log('OAuth client file: found, Desktop-app structure OK.');
  } catch (err) {
    console.log(`OAuth client file: problem\n${err.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    const {channel} = await verifiedClient();
    console.log(`Connected: yes\n  Channel name: ${channel.title}\n  Channel ID:   ${channel.id}`);
  } catch (err) {
    if (!(err instanceof NotConnectedError)) {
      throw err;
    }
    console.log(`Connected: no\n${err.message}`);
    process.exitCode = 1;
  }
};

const logout = async () => {
  const {hadToken, revoked} = await disconnect(paths);
  if (!hadToken) {
    console.log('No stored sign-in was found. Nothing to remove.');
    return;
  }
  console.log(`Local tokens removed.${revoked ? ' Access was also revoked at Google.' : ' Could not revoke at Google; you can remove access at https://myaccount.google.com/permissions'}`);
};

const testUpload = async () => {
  const input = args.find((a) => !a.startsWith('--'));
  const video = await validateVideoFile(input);
  const {client, channel} = await verifiedClient();
  console.log(`Channel verified: ${channel.title} (${channel.id})`);

  const hash = await hashFile(video.file);
  const log = (await readJson(paths.uploadLog)) || {};
  if (log[hash] && !args.includes('--force')) {
    throw new UploadError(
      `This exact file was already uploaded as https://www.youtube.com/watch?v=${log[hash].videoId} on ${log[hash].uploadedAt}.\n  Add --force to upload it again.`,
    );
  }

  const metadata = buildTestMetadata(video.file);
  console.log(`Uploading ${path.basename(video.file)} (${(video.size / 1048576).toFixed(1)} MB) as PRIVATE...`);
  let lastShown = -1;
  const videoId = await uploadPrivateVideo(client, video, metadata, (sent, total) => {
    const percent = Math.floor((sent / total) * 100);
    if (percent >= lastShown + 10 || percent === 100) {
      lastShown = percent;
      console.log(`  ${percent}%`);
    }
  });
  log[hash] = {videoId, file: video.file, channelId: channel.id, uploadedAt: new Date().toISOString()};
  await writePrivateJson(paths.uploadLog, paths.tokenDir, log);

  console.log(`\nUpload confirmed by YouTube.\n  Video ID: ${videoId}\n  Link:     https://www.youtube.com/watch?v=${videoId}`);
  try {
    const privacy = await getPrivacyStatus(client, videoId);
    console.log(`  Visibility reported by YouTube: ${privacy ?? 'not available yet'}`);
    if (privacy && privacy !== metadata.status.privacyStatus) {
      console.log('  WARNING: this is not private. Change it in YouTube Studio now.');
      process.exitCode = 1;
    }
  } catch {
    console.log('  Could not read the visibility back; check it in YouTube Studio.');
  }
};

const commands = {auth, status, logout, 'test-upload': testUpload};

try {
  if (!commands[command]) {
    console.log('Usage: node scripts/youtube/cli.mjs <auth|status|logout|test-upload> [file] [--force] [--expect-channel=ID]');
    process.exitCode = 1;
  } else {
    await commands[command]();
  }
} catch (err) {
  const expected = err instanceof SetupError || err instanceof NotConnectedError || err instanceof UploadError;
  console.error(`\n${expected ? err.message : describeAuthError(err).message}`);
  process.exitCode = 1;
}
