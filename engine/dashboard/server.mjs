import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FEEDBACK_LABELS, feedbackByMoment, setFeedback} from '../analysis/feedback.mjs';
import {addCreator, listCreators, removeCreator, updateCreator} from '../db/creators.mjs';
import {logEvent, now} from '../db/db.mjs';
import {SETTINGS, getSettings, setSetting} from '../db/settings.mjs';
import {enqueue, retryJob} from '../jobs/queue.mjs';
import {getUploadHold} from '../publish/hold.mjs';
import {quotaStatus} from '../publish/quota.mjs';
import {localClock, nextSlots, projectQueue, uploadsOnDay, zonedParts} from '../publish/scheduler.mjs';
import {recheckCompliance, visibilityAllowed} from '../publish/uploader.mjs';
import {STYLE_PRESETS} from '../render/styles.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 100_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new HttpError(413, 'Request too large.');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request body must be JSON.');
  }
};

const grouped = (db, table) => Object.fromEntries(db.all(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`).map((row) => [row.status, row.n]));

const SHORT_LIST_SQL = `
  SELECT s.id, s.status, s.title, s.style, s.progress, s.fail_reason, s.created_at, s.updated_at, s.approved_at, s.metadata_json,
         s.output_path IS NOT NULL AS has_video, src.title AS source_title, src.url AS source_url, c.name AS creator,
         u.video_id, u.state AS upload_state, u.visibility, u.reported_privacy, u.confirmed_at, u.last_error AS upload_error
  FROM shorts s JOIN sources src ON src.video_id = s.source_id JOIN creators c ON c.id = src.creator_id
  LEFT JOIN uploads u ON u.short_id = s.id`;

const presentShort = (row) => {
  const {metadata_json: metadata, ...rest} = row;
  return {...rest, has_video: Boolean(row.has_video), video_title: metadata ? JSON.parse(metadata).title : null};
};

/** Moment rows as the page shows them: with the model review unpacked and the owner's ratings attached. */
const presentMoments = (db, rows) => {
  const ratings = feedbackByMoment(db, rows.map((row) => row.id));
  return rows.map(({review_json: review, ...row}) => ({...row, review: review ? JSON.parse(review) : null, feedback: ratings.get(row.id)}));
};

const overview = (ctx, getHealth) => {
  const {db} = ctx;
  const settings = getSettings(db);
  const at = new Date();
  const today = zonedParts(at, settings['schedule.timezone']).day;
  const health = getHealth();
  const counts = {sources: grouped(db, 'sources'), shorts: grouped(db, 'shorts'), jobs: grouped(db, 'jobs')};
  const quota = quotaStatus(db, settings, at);
  const warnings = [];
  if (settings['automation.emergencyStop']) {
    warnings.push({level: 'error', text: 'Emergency stop is on: nothing runs and nothing uploads.'});
  }
  for (const [name, check] of Object.entries(health?.checks ?? {})) {
    if (!check.ok) {
      warnings.push({level: 'error', text: `${name}: ${check.detail}`});
    }
  }
  if (counts.jobs.dead > 0) {
    warnings.push({level: 'warn', text: `${counts.jobs.dead} job(s) failed for good. See the Jobs tab.`});
  }
  if (quota.uploads.used >= quota.uploads.limit * 0.9) {
    warnings.push({level: 'warn', text: `Upload quota nearly used: ${quota.uploads.used} of ${quota.uploads.limit} today.`});
  }
  const hold = getUploadHold(db, at);
  if (hold) {
    warnings.push({
      level: 'warn',
      text: `YouTube has capped this channel's uploads for now (its own daily limit, reached after ${hold.uploadsLast24h} upload(s) in 24 hours). Posting resumes by itself: the next try is after ${localClock(hold.until, settings['schedule.timezone'])}. To raise the limit, see YouTube Studio > Settings > Channel > Feature eligibility.`,
    });
  }
  const visibility = visibilityAllowed(db, settings);
  if (!visibility.ok) {
    warnings.push({level: 'warn', text: visibility.reason});
  }
  return {
    now: at.toISOString(),
    settings,
    health,
    counts,
    quota,
    warnings,
    today: {
      day: today,
      uploaded: uploadsOnDay(db, settings, at),
      produced: db.all('SELECT created_at FROM shorts').filter((row) => zonedParts(new Date(row.created_at), settings['schedule.timezone']).day === today).length,
    },
    schedule: {next: nextSlots(at, settings, 6), queue: projectQueue(db, settings, at)},
    styles: Object.keys(STYLE_PRESETS),
    feedbackLabels: FEEDBACK_LABELS,
  };
};

const applySettings = (db, patch) => {
  const entries = Object.entries(patch.settings ?? {});
  if (entries.length === 0) {
    throw new HttpError(400, 'No settings given.');
  }
  for (const [key] of entries) {
    if (!SETTINGS[key]) {
      throw new HttpError(400, `Unknown setting "${key}".`);
    }
  }
  const current = getSettings(db);
  const next = {...current, ...Object.fromEntries(entries)};
  if (!(next['short.minSeconds'] <= next['short.targetSeconds'] && next['short.targetSeconds'] <= next['short.maxSeconds'])) {
    throw new HttpError(400, 'Short length must satisfy minimum <= target <= maximum.');
  }
  // Only a change that opens uploads up needs confirmation; switching back towards private never does.
  const switchesOn = next['upload.allowNonPrivate'] === true && current['upload.allowNonPrivate'] !== true;
  const widensVisibility = next['upload.visibility'] !== 'private' && next['upload.visibility'] !== current['upload.visibility'];
  if (switchesOn || widensVisibility) {
    if (patch.confirmNonPrivate !== true) {
      throw new HttpError(409, 'Allowing unlisted or public uploads needs explicit confirmation.');
    }
    const check = visibilityAllowed(db, {...next, 'upload.allowNonPrivate': true});
    if (!check.ok) {
      throw new HttpError(409, check.reason);
    }
    if (next['upload.visibility'] !== 'private' && next['upload.allowNonPrivate'] !== true) {
      throw new HttpError(409, 'Switch on non-private uploads before choosing unlisted or public.');
    }
  }
  db.tx(() => {
    for (const [key, value] of entries) {
      try {
        setSetting(db, key, value);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
  });
  logEvent(db, 'warn', `Settings changed: ${entries.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')}`, {entity: 'settings'});
};

const shortOr404 = (db, id) => {
  const short = db.get('SELECT * FROM shorts WHERE id = ?', id);
  if (!short) {
    throw new HttpError(404, 'Short not found.');
  }
  return short;
};

const shortActions = {
  approve(db, short) {
    if (short.status !== 'awaiting_approval') {
      throw new HttpError(409, `Only a Short awaiting approval can be approved (this one is "${short.status}").`);
    }
    const compliance = recheckCompliance(db, short);
    if (!compliance.passed) {
      throw new HttpError(409, `It no longer passes compliance: ${compliance.failures.map((failure) => `${failure.check} — ${failure.detail}`).join('; ')}`);
    }
    db.run("UPDATE shorts SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?", now(), now(), short.id);
    logEvent(db, 'info', `Short ${short.id} approved by the owner.`, {entity: 'short', id: short.id});
  },
  reject(db, short) {
    if (!['awaiting_approval', 'approved'].includes(short.status)) {
      throw new HttpError(409, `A Short that is "${short.status}" cannot be rejected.`);
    }
    db.run("UPDATE shorts SET status = 'rejected', updated_at = ? WHERE id = ?", now(), short.id);
    logEvent(db, 'info', `Short ${short.id} rejected by the owner.`, {entity: 'short', id: short.id});
  },
  rerender(db, short, body) {
    if (['uploading', 'uploaded', 'planned', 'clipping', 'rendering'].includes(short.status)) {
      throw new HttpError(409, `A Short that is "${short.status}" cannot be rerendered.`);
    }
    if (body.style != null && !STYLE_PRESETS[body.style]) {
      throw new HttpError(400, 'Unknown style.');
    }
    const count = short.render_count + 1;
    db.run(
      "UPDATE shorts SET status = 'planned', render_count = ?, style = ?, progress = 0, fail_reason = NULL, output_path = NULL, output_sha256 = NULL, verify_json = NULL, metadata_json = NULL, approved_at = NULL, updated_at = ? WHERE id = ?",
      count,
      body.style ?? null,
      now(),
      short.id,
    );
    enqueue(db, 'produce', {shortId: short.id}, {key: `produce:${short.id}:${count}`, maxAttempts: 3});
    logEvent(db, 'info', `Short ${short.id} queued for rerender${body.style ? ` in the ${body.style} style` : ''}.`, {entity: 'short', id: short.id});
  },
  'upload-now'(db, short) {
    if (short.status !== 'approved') {
      throw new HttpError(409, 'Only an approved Short can be uploaded.');
    }
    enqueue(db, 'upload', {shortId: short.id, slotKey: 'manual'}, {key: `upload:${short.id}:manual:${Date.now()}`, maxAttempts: 3});
    logEvent(db, 'info', `Short ${short.id}: upload requested by the owner.`, {entity: 'short', id: short.id});
  },
  metadata(db, short, body) {
    if (!['awaiting_approval', 'approved'].includes(short.status) || !short.metadata_json) {
      throw new HttpError(409, 'The title and description can only be edited before upload.');
    }
    const title = String(body.title ?? '').replace(/[<>]/g, '').trim();
    const description = String(body.description ?? '').replace(/[<>]/g, '').trim();
    if (title.length < 3 || title.length > 100 || description.length > 4900) {
      throw new HttpError(400, 'The title must be 3-100 characters and the description under 4,900.');
    }
    db.run('UPDATE shorts SET metadata_json = ?, updated_at = ? WHERE id = ?', JSON.stringify({...JSON.parse(short.metadata_json), title, description, editedByOwner: true}), now(), short.id);
  },
};

const serveVideo = (req, res, file) => {
  if (!file || !fs.existsSync(file)) {
    throw new HttpError(404, 'No video file for this Short.');
  }
  const {size} = fs.statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!range) {
    res.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes'});
    fs.createReadStream(file).pipe(res);
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.writeHead(416, {'Content-Range': `bytes */${size}`}).end();
    return;
  }
  res.writeHead(206, {'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes'});
  fs.createReadStream(file, {start, end}).pipe(res);
};

/**
 * Local dashboard. Bound to loopback only; every request must carry the right Host, and
 * anything that changes state must carry the per-launch token the page was served with,
 * so another website open in the browser cannot drive the engine.
 */
export const startDashboard = (ctx, {port, getHealth = () => null, refreshHealth = async () => {}}) => {
  const {db} = ctx;
  const token = crypto.randomBytes(24).toString('base64url');

  const api = [
    ['GET', /^\/health$/, () => ({ok: !getSettings(db)['automation.emergencyStop'] && (getHealth()?.ok ?? false), health: getHealth(), jobs: grouped(db, 'jobs')})],
    ['GET', /^\/api\/state$/, () => overview(ctx, getHealth)],
    ['GET', /^\/api\/creators$/, () => listCreators(db).map((creator) => ({...creator, sources: db.get('SELECT COUNT(*) AS n FROM sources WHERE creator_id = ?', creator.id).n}))],
    ['POST', /^\/api\/creators$/, (m, body) => addCreator(db, body)],
    ['PATCH', /^\/api\/creators\/(\d+)$/, (m, body) => updateCreator(db, Number(m[1]), body)],
    ['DELETE', /^\/api\/creators\/(\d+)$/, (m) => ({result: removeCreator(db, Number(m[1]))})],
    ['GET', /^\/api\/sources$/, () => db.all('SELECT s.*, c.name AS creator FROM sources s JOIN creators c ON c.id = s.creator_id ORDER BY s.discovered_at DESC LIMIT 200')],
    ['GET', /^\/api\/sources\/([\w-]{5,20})\/moments$/, (m) => presentMoments(db, db.all('SELECT * FROM moments WHERE source_id = ? ORDER BY score DESC', m[1]))],
    [
      // A rating is a note about one moment. It changes no Short, no approval and no upload setting.
      'POST',
      /^\/api\/moments\/(\d+)\/feedback$/,
      (m, body) => {
        if (typeof body.on !== 'boolean') {
          throw new HttpError(400, 'Say whether the rating is on or off.');
        }
        return {feedback: setFeedback(db, Number(m[1]), body.label, body.on)};
      },
    ],
    ['GET', /^\/api\/shorts$/, () => db.all(`${SHORT_LIST_SQL} ORDER BY s.id DESC LIMIT 200`).map(presentShort)],
    [
      'GET',
      /^\/api\/shorts\/(\d+)$/,
      (m) => {
        const row = db.get(`${SHORT_LIST_SQL} WHERE s.id = ?`, Number(m[1]));
        if (!row) {
          throw new HttpError(404, 'Short not found.');
        }
        const full = db.get('SELECT plan_json, compliance_json, verify_json, metadata_json, output_path FROM shorts WHERE id = ?', row.id);
        return {
          ...presentShort(row),
          output_path: full.output_path,
          plan: JSON.parse(full.plan_json),
          compliance: JSON.parse(full.compliance_json ?? 'null'),
          verify: JSON.parse(full.verify_json ?? 'null'),
          metadata: JSON.parse(full.metadata_json ?? 'null'),
          moments: presentMoments(db, db.all('SELECT m.* FROM moments m JOIN short_moments sm ON sm.moment_id = m.id WHERE sm.short_id = ? ORDER BY sm.position', row.id)),
        };
      },
    ],
    [
      'POST',
      /^\/api\/shorts\/(\d+)\/(approve|reject|rerender|upload-now|metadata)$/,
      (m, body) => {
        shortActions[m[2]](db, shortOr404(db, Number(m[1])), body);
        return {ok: true};
      },
    ],
    ['GET', /^\/api\/uploads$/, () => db.all('SELECT u.*, s.title FROM uploads u JOIN shorts s ON s.id = u.short_id ORDER BY u.id DESC LIMIT 200').map(({session_uri: _hidden, ...row}) => row)],
    ['GET', /^\/api\/jobs$/, () => db.all("SELECT id, type, payload_json, status, attempts, max_attempts, run_after, last_error, created_at, finished_at FROM jobs WHERE status != 'succeeded' ORDER BY id DESC LIMIT 200")],
    [
      'POST',
      /^\/api\/jobs\/(\d+)\/retry$/,
      (m) => {
        if (!retryJob(db, Number(m[1]))) {
          throw new HttpError(409, 'Only a job that failed for good can be retried.');
        }
        return {ok: true};
      },
    ],
    ['GET', /^\/api\/events$/, () => db.all('SELECT * FROM events ORDER BY id DESC LIMIT 200')],
    [
      'POST',
      /^\/api\/settings$/,
      (m, body) => {
        applySettings(db, body);
        return getSettings(db);
      },
    ],
    [
      'POST',
      /^\/api\/control$/,
      async (m, body) => {
        const set = (key, value, message) => {
          setSetting(db, key, value);
          logEvent(db, 'warn', message, {entity: 'control'});
        };
        const actions = {
          pause: () => set('automation.paused', true, 'Automation paused by the owner.'),
          resume: () => set('automation.paused', false, 'Automation resumed by the owner.'),
          'emergency-stop': () => set('automation.emergencyStop', true, 'EMERGENCY STOP switched on by the owner.'),
          'clear-emergency': () => {
            set('automation.emergencyStop', false, 'Emergency stop cleared by the owner.');
            set('automation.paused', true, 'Automation left paused after the emergency stop.');
          },
          'discover-now': () => {
            for (const creator of listCreators(db).filter((entry) => entry.enabled)) {
              enqueue(db, 'discover', {creatorId: creator.id}, {key: `discover:${creator.id}:manual:${Date.now()}`, maxAttempts: 3});
            }
          },
          'refresh-health': () => refreshHealth(),
        };
        if (!actions[body.action]) {
          throw new HttpError(400, 'Unknown action.');
        }
        await actions[body.action]();
        return {ok: true};
      },
    ],
  ];

  const handle = async (req, res) => {
    const listening = server.address().port;
    const allowedHosts = [`127.0.0.1:${listening}`, `localhost:${listening}`];
    if (!allowedHosts.includes(req.headers.host)) {
      throw new HttpError(403, 'Unexpected Host header.');
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const body = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
      res.end(file === 'index.html' ? body.replace('__TOKEN__', token) : body);
      return;
    }
    const media = /^\/media\/short\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && media) {
      serveVideo(req, res, db.get('SELECT output_path FROM shorts WHERE id = ?', Number(media[1]))?.output_path);
      return;
    }
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (req.headers['x-lopyclips-token'] !== token || (origin && !allowedHosts.includes(new URL(origin).host))) {
        throw new HttpError(403, 'This request did not come from the dashboard page.');
      }
    }
    for (const [method, pattern, handler] of api) {
      const match = method === req.method ? pattern.exec(url.pathname) : null;
      if (match) {
        let result;
        try {
          result = await handler(match, method === 'GET' ? {} : await readBody(req));
        } catch (err) {
          throw err instanceof HttpError ? err : new HttpError(400, err.message);
        }
        sendJson(res, 200, result ?? {ok: true});
        return;
      }
    }
    throw new HttpError(404, 'Not found.');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, err.status ?? 500, {error: err.message});
      } else {
        res.end();
      }
    });
  });
  server.listen(port, '127.0.0.1');
  server.token = token;
  return server;
};
