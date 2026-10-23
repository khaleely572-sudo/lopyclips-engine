import {PermanentError, claim, complete, fail} from './queue.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lanes that run side by side, each one job at a time. Reading a long stream with the models can
 * take over an hour; it must never hold up a scheduled upload or the rendering of a planned Short.
 *   - uploads and channel discovery: everything that talks to the YouTube API;
 *   - producing Shorts and fetching captions: everything that fetches footage or renders;
 *   - every other job (analysis and planning) runs in a third lane of its own.
 */
export const LANES = [
  ['upload', 'discover'],
  ['produce', 'transcript'],
];

/**
 * Runs queued jobs. `canRun` is consulted before every claim, so pausing or an emergency stop
 * takes effect at the next job boundary. Without `lanes` there is a single lane for everything.
 */
export const createWorker = ({db, handlers, canRun = () => true, log = () => {}, idleMs = 2000, lanes = []}) => {
  let stopped = false;

  const runOne = async (filter = {}) => {
    if (!canRun()) {
      return false;
    }
    const job = claim(db, new Date(), filter);
    if (!job) {
      return false;
    }
    try {
      const handler = handlers[job.type];
      if (!handler) {
        throw new PermanentError(`No handler for job type "${job.type}".`);
      }
      await handler(job.payload, job);
      complete(db, job.id);
      log('info', `Job ${job.type} finished`, {entity: 'job', id: job.id});
    } catch (err) {
      const outcome = fail(db, job, err);
      log(outcome === 'dead' ? 'error' : 'warn', `Job ${job.type} ${outcome === 'dead' ? 'failed for good' : 'failed and will retry'}: ${err.message}`, {
        entity: 'job',
        id: job.id,
      });
    }
    return true;
  };

  return {
    runOne,
    /** Run until the queue has nothing ready. */
    async drain() {
      while (await runOne()) {
        // keep going
      }
    },
    start() {
      stopped = false;
      const loop = async (filter) => {
        while (!stopped) {
          let ran = false;
          try {
            ran = await runOne(filter);
          } catch (err) {
            // The queue itself failed (a locked database, say). Never let that end a lane.
            log('error', `Worker lane hit an error and will carry on: ${err.message}`);
          }
          if (!ran) {
            await sleep(idleMs);
          }
        }
      };
      for (const only of lanes) {
        loop({only});
      }
      loop({except: lanes.flat()});
    },
    stop() {
      stopped = true;
    },
  };
};
