import {getAuthorizedClient} from './auth.mjs';
import {getPaths} from './config.mjs';
import {NotConnectedError, readJson} from './storage.mjs';
import {describeApiError, getMyChannel} from './youtube.mjs';

export const WRONG_ACCOUNT_HELP =
  'To connect the right channel:\n' +
  '  1. Run: npm run auth:youtube\n' +
  '  2. On the Google page, pick the Google account that owns the channel.\n' +
  '  3. If that account manages several channels, Google shows a second "Choose a channel" step; pick the one LopyClips should upload to.';

/** A signed-in client whose live channel matches the one the owner confirmed at sign-in. */
export const getVerifiedClient = async (paths = getPaths()) => {
  const client = await getAuthorizedClient(paths);
  const confirmed = await readJson(paths.channel);
  let channel;
  try {
    channel = await getMyChannel(client);
  } catch (err) {
    throw describeApiError(err);
  }
  if (!confirmed?.channelId) {
    throw new NotConnectedError('The channel has not been confirmed. Run "npm run auth:youtube:logout" then "npm run auth:youtube".');
  }
  if (!channel || channel.id !== confirmed.channelId) {
    throw new NotConnectedError(`The signed-in account no longer matches the confirmed channel (${confirmed.title}). Nothing was uploaded.\n${WRONG_ACCOUNT_HELP}`);
  }
  return {client, channel};
};
