import {DASHBOARD_PORT} from './config.mjs';
import {createContext, enqueueDiscovery, runHealthChecks} from './context.mjs';
import {startDashboard} from './dashboard/server.mjs';
import {getSettings} from './db/settings.mjs';
import {recoverStale} from './jobs/queue.mjs';
import {LANES, createWorker} from './jobs/worker.mjs';
import {createHandlers} from './pipeline.mjs';
import {tick} from './publish/scheduler.mjs';

const MINUTE = 60_000;
const HEALTH_EVERY = 10 * MINUTE;

const ctx = createContext();
const {db, log} = ctx;

const recovered = recoverStale(db);
if (recovered > 0) {
  log('warn', `Recovered ${recovered} job(s) that were running when the engine last stopped.`);
}

// Pausing stops the automatic triggers (discovery and publishing slots); work already
// queued, or asked for from the dashboard, still runs. The emergency stop halts everything.
// Uploads and rendering each have a lane of their own, so a long stream analysis never delays a scheduled post.
const worker = createWorker({db, handlers: createHandlers(ctx), log, canRun: () => !getSettings(db)['automation.emergencyStop'], lanes: LANES});
worker.start();

const state = {health: null, lastDiscovery: 0};
const refreshHealth = async () => {
  try {
    state.health = await runHealthChecks(ctx);
  } catch (err) {
    log('error', `Health check failed: ${err.message}`);
  }
};

const everyMinute = () => {
  try {
    const settings = getSettings(db);
    const idle = settings['automation.paused'] || settings['automation.emergencyStop'];
    if (!idle && Date.now() - state.lastDiscovery >= settings['discovery.pollMinutes'] * MINUTE) {
      state.lastDiscovery = Date.now();
      enqueueDiscovery(db);
    }
    tick(db);
  } catch (err) {
    log('error', `Scheduler tick failed: ${err.message}`);
  }
};

const server = startDashboard(ctx, {port: DASHBOARD_PORT, getHealth: () => state.health, refreshHealth});
const timers = [setInterval(everyMinute, MINUTE / 2), setInterval(refreshHealth, HEALTH_EVERY)];
refreshHealth();

const settings = getSettings(db);
log('info', `LopyClips engine started. Dashboard: http://127.0.0.1:${DASHBOARD_PORT}  (paused: ${settings['automation.paused']}, dry run: ${settings.dryRun}, approval required: ${settings.requireApproval})`);

const shutdown = () => {
  log('info', 'Engine stopping.');
  timers.forEach(clearInterval);
  worker.stop();
  server.close();
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
