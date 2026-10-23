import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Upload is the permission the tool exists for; readonly is needed to confirm which
// channel was authorized and to read back the privacy status of a finished upload.
export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];
export const UPLOAD_SCOPE = SCOPES[0];

// The only visibility this integration is allowed to send.
export const PRIVACY_STATUS = 'private';

export const getPaths = (root = PROJECT_ROOT) => {
  const tokenDir = path.join(root, 'tokens');
  return {
    root,
    secretsDir: path.join(root, 'secrets'),
    credentials: path.join(root, 'secrets', 'youtube-oauth-client.json'),
    tokenDir,
    token: path.join(tokenDir, 'youtube-token.json'),
    channel: path.join(tokenDir, 'youtube-channel.json'),
    uploadLog: path.join(tokenDir, 'youtube-upload-log.json'),
  };
};
