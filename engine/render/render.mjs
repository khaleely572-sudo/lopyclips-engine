import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {PROJECT_ROOT} from '../config.mjs';

const exec = promisify(execFile);
const COMPOSITION = 'LopyShort';

/**
 * Render one Short with Remotion from its own public folder of clips, then even out
 * the loudness. Resolves with the final file path only once that file exists.
 */
export const renderShort = async ({workDir, props, output, concurrency, onProgress = () => {}}) => {
  const {bundle} = await import('@remotion/bundler');
  const {renderMedia, selectComposition} = await import('@remotion/renderer');
  const serveUrl = await bundle({
    entryPoint: path.join(PROJECT_ROOT, 'src', 'index.ts'),
    publicDir: path.join(workDir, 'public'),
    outDir: path.join(workDir, 'bundle'),
  });
  const composition = await selectComposition({serveUrl, id: COMPOSITION, inputProps: props, logLevel: 'error'});
  const raw = path.join(workDir, 'render-raw.mp4');
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    crf: 18,
    outputLocation: raw,
    inputProps: props,
    concurrency,
    logLevel: 'error',
    onProgress: ({progress}) => onProgress(progress * 0.95),
  });
  fs.mkdirSync(path.dirname(output), {recursive: true});
  await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-movflags', '+faststart', output]);
  if (!fs.existsSync(output)) {
    throw new Error('Rendering finished but the output file is missing.');
  }
  onProgress(1);
  return output;
};
