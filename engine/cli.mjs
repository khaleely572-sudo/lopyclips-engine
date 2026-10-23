import {NIM_URL} from './config.mjs';
import {createContext, enqueueDiscovery, runHealthChecks} from './context.mjs';
import {getSettings} from './db/settings.mjs';
import {askHidden, looksLikeNimKey, readNimKey, saveNimKey} from './nimKey.mjs';
import {recoverStale} from './jobs/queue.mjs';
import {createWorker} from './jobs/worker.mjs';
import {createHandlers} from './pipeline.mjs';
import {nextSlots} from './publish/scheduler.mjs';

const command = process.argv[2];
const ctx = createContext();
const {db} = ctx;

const count = (table) => Object.fromEntries(db.all(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`).map((row) => [row.status, row.n]));

const drain = async () => {
  if (getSettings(db)['automation.emergencyStop']) {
    console.log('The emergency stop is on. Clear it in the dashboard first.');
    process.exitCode = 1;
    return;
  }
  recoverStale(db);
  await createWorker({db, handlers: createHandlers(ctx), log: ctx.log}).drain();
};

const commands = {
  /** Check every tool and service the engine depends on. */
  async doctor() {
    const health = await runHealthChecks(ctx);
    for (const [name, check] of Object.entries(health.checks)) {
      console.log(`${check.ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(28)} ${check.detail}`);
    }
    console.log(health.ok ? '\nEverything the engine needs is in place.' : '\nSome checks failed; see above.');
    process.exitCode = health.ok ? 0 : 1;
  },

  /** Look for new videos from every enabled creator, then run whatever that queues. */
  async discover() {
    console.log(`Queued discovery for ${enqueueDiscovery(db)} creator(s).`);
    await drain();
    await commands.status();
  },

  /** Run every job that is ready, once, then exit. */
  async once() {
    await drain();
    await commands.status();
  },

  /** Store an NVIDIA API key. It is typed or pasted here, hidden, and never shown again. */
  async 'nim-key'() {
    if (!process.stdin.isTTY) {
      console.log('Run this in your own terminal window so you can paste the key there.');
      process.exitCode = 1;
      return;
    }
    const key = await askHidden('Paste your NVIDIA API key and press Enter (it will not be shown): ');
    if (!looksLikeNimKey(key)) {
      console.log('That does not look like an NVIDIA API key (they start with "nvapi-"). Nothing was saved.');
      process.exitCode = 1;
      return;
    }
    await saveNimKey(key);
    console.log('Key saved in the secrets folder, readable only by your Windows account.\nIt is checked the first time a "nim:" model is used; "npm run engine:doctor" will show the result.');
  },

  /** List the models NVIDIA NIM offers, optionally only those whose name contains a word. */
  async 'nim-models'() {
    const filter = (process.argv[3] ?? '').toLowerCase();
    const key = readNimKey();
    const res = await fetch(`${NIM_URL}/models`, {headers: key ? {Authorization: `Bearer ${key}`} : {}, signal: AbortSignal.timeout(30_000)});
    if (!res.ok) {
      throw new Error(`NVIDIA answered HTTP ${res.status} when asked for its model list.`);
    }
    const ids = ((await res.json()).data ?? []).map((model) => model.id).filter((id) => id.toLowerCase().includes(filter)).sort();
    console.log(ids.length ? ids.join('\n') : 'No models match.');
    console.log(`\n${ids.length} model(s). To use one, set analysis.model or analysis.secondModel to "nim:<name>" in the dashboard Settings.`);
  },

  async status() {
    const settings = getSettings(db);
    console.log('\nSources:', count('sources'));
    console.log('Shorts: ', count('shorts'));
    console.log('Jobs:   ', count('jobs'));
    console.log(`Automation paused: ${settings['automation.paused']} | dry run: ${settings.dryRun} | approval required: ${settings.requireApproval} | visibility: ${settings['upload.visibility']}`);
    console.log('Next slots:', nextSlots(new Date(), settings, 3).map((slot) => `${slot.key}${slot.quiet ? ' (quiet)' : ''}`).join(', '));
  },
};

if (!commands[command]) {
  console.log('Usage: node engine/cli.mjs <doctor|discover|once|status|nim-key|nim-models [word]>');
  process.exitCode = 1;
} else {
  try {
    await commands[command]();
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
}
db.close();
