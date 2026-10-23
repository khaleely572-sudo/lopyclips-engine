import {logEvent} from '../db/db.mjs';
import {getSettings} from '../db/settings.mjs';
import {enqueue} from '../jobs/queue.mjs';
import {getUploadHold} from './hold.mjs';
import {quotaUsed} from './quota.mjs';

const SLOT_WINDOW_MINUTES = 15;
const STATE_LAST_SLOT = 'state.lastSlot';

/** Calendar day and wall-clock time of an instant in a given time zone. */
export const zonedParts = (date, timeZone) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute)};
};

/** The publishing slot an instant falls in (e.g. "2026-10-13T14"), or null when it is not slot time. */
export const slotKeyAt = (date, settings) => {
  const local = zonedParts(date, settings['schedule.timezone']);
  if (local.hour % settings['schedule.intervalHours'] !== 0 || local.minute >= SLOT_WINDOW_MINUTES) {
    return null;
  }
  return `${local.day}T${String(local.hour).padStart(2, '0')}`;
};

/** A moment as wall-clock time in the schedule's time zone, e.g. "17:05". */
export const localClock = (date, timeZone) => {
  const {hour, minute} = zonedParts(new Date(date), timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

export const inQuietHours = ({hour, minute}, quiet) => {
  if (!quiet) {
    return false;
  }
  const minutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const [at, start, end] = [hour * 60 + minute, minutes(quiet.start), minutes(quiet.end)];
  return start <= end ? at >= start && at < end : at >= start || at < end;
};

/** The next publishing slots after `from`, each marked if it falls in quiet hours. */
export const nextSlots = (from, settings, count = 6) => {
  const slots = [];
  const step = 15 * 60 * 1000;
  let at = new Date(Math.ceil((from.getTime() + 1) / step) * step);
  for (let i = 0; i < 4 * 24 * 14 && slots.length < count; i += 1, at = new Date(at.getTime() + step)) {
    const local = zonedParts(at, settings['schedule.timezone']);
    if (local.minute === 0 && local.hour % settings['schedule.intervalHours'] === 0) {
      slots.push({at: at.toISOString(), key: `${local.day}T${String(local.hour).padStart(2, '0')}`, quiet: inQuietHours(local, settings['schedule.quietHours'])});
    }
  }
  return slots;
};

export const uploadsOnDay = (db, settings, at) => {
  const today = zonedParts(at, settings['schedule.timezone']).day;
  const since = new Date(at.getTime() - 36 * 3600 * 1000).toISOString();
  return db
    .all("SELECT confirmed_at FROM uploads WHERE state = 'confirmed' AND confirmed_at >= ?", since)
    .filter((row) => zonedParts(new Date(row.confirmed_at), settings['schedule.timezone']).day === today).length;
};

/**
 * Approved Shorts in the order they go out. One whose upload is already queued is left out, so a
 * slot is never spent on a video that an earlier slot is still about to send.
 */
const approvedQueue = (db) =>
  db.all(
    `SELECT id, title, approved_at FROM shorts WHERE status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'upload' AND j.status IN ('queued','running') AND json_extract(j.payload_json, '$.shortId') = shorts.id)
     ORDER BY approved_at, id`,
  );

/** Which approved Shorts, if any, go out in the slot at `at`, and the reason when none do. */
export const pickForSlot = (db, settings, at) => {
  if (inQuietHours(zonedParts(at, settings['schedule.timezone']), settings['schedule.quietHours'])) {
    return {shortIds: [], reason: 'quiet hours'};
  }
  const hold = getUploadHold(db, at);
  if (hold) {
    return {shortIds: [], reason: `YouTube has capped this channel's uploads for now; the next try is after ${localClock(hold.until, settings['schedule.timezone'])}`};
  }
  // One slot, one batch: if an earlier slot's video has still not gone out, this slot adds nothing,
  // so a delay can never end with two slots' videos landing on the channel together.
  const pending = db.get("SELECT COUNT(*) AS n FROM jobs WHERE type = 'upload' AND status IN ('queued','running') AND json_extract(payload_json, '$.slotKey') != 'manual'").n;
  if (pending > 0) {
    return {shortIds: [], reason: "an earlier slot's video has not gone out yet, and it counts as this slot's video"};
  }
  const dailyLeft = settings['schedule.dailyLimit'] - uploadsOnDay(db, settings, at);
  if (dailyLeft <= 0) {
    return {shortIds: [], reason: `daily limit of ${settings['schedule.dailyLimit']} reached`};
  }
  const quotaLeft = settings['quota.insertPerDay'] - quotaUsed(db, 'insert', at);
  if (quotaLeft <= 0) {
    return {shortIds: [], reason: "today's YouTube upload quota is used up"};
  }
  const shortIds = approvedQueue(db)
    .slice(0, Math.min(settings['schedule.maxPerSlot'], dailyLeft, quotaLeft))
    .map((short) => short.id);
  return {shortIds, reason: shortIds.length === 0 ? 'no approved video is waiting' : null};
};

/** Approved Shorts laid onto the coming slots, for display. A projection, not a promise. */
export const projectQueue = (db, settings, from) => {
  const waiting = approvedQueue(db);
  const plan = [];
  for (const slot of nextSlots(from, settings, 24)) {
    if (waiting.length === 0) {
      break;
    }
    if (!slot.quiet) {
      plan.push({...slot, shorts: waiting.splice(0, settings['schedule.maxPerSlot'])});
    }
  }
  return plan;
};

const getState = (db, key) => {
  const row = db.get('SELECT value_json FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value_json) : null;
};
const setState = (db, key, value) =>
  db.run('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', key, JSON.stringify(value));

/** A Short left "uploading" with no upload job behind it (a job that gave up) goes back to the approved queue. */
export const releaseStuckUploads = (db) =>
  db.run(
    `UPDATE shorts SET status = 'approved' WHERE status = 'uploading'
       AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.short_id = shorts.id AND u.state = 'confirmed')
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'upload' AND j.status IN ('queued','running') AND json_extract(j.payload_json, '$.shortId') = shorts.id)`,
  ).changes;

/**
 * Called every minute. At slot time, and only once per slot, it queues the uploads for
 * that slot. A slot missed while the engine was off is skipped, never made up later.
 */
export const tick = (db, at = new Date()) => {
  const settings = getSettings(db);
  if (settings['automation.emergencyStop'] || settings['automation.paused']) {
    return {acted: false, reason: 'automation is paused'};
  }
  releaseStuckUploads(db);
  const key = slotKeyAt(at, settings);
  if (!key) {
    return {acted: false, reason: 'not slot time'};
  }
  if (getState(db, STATE_LAST_SLOT) === key) {
    return {acted: false, reason: 'slot already handled'};
  }
  setState(db, STATE_LAST_SLOT, key);
  const pick = pickForSlot(db, settings, at);
  if (pick.shortIds.length === 0) {
    logEvent(db, 'info', `Slot ${key} skipped: ${pick.reason}.`, {entity: 'schedule', id: key});
    return {acted: true, slot: key, queued: [], reason: pick.reason};
  }
  for (const shortId of pick.shortIds) {
    enqueue(db, 'upload', {shortId, slotKey: key}, {key: `upload:${shortId}:${key}`, maxAttempts: 5});
  }
  logEvent(db, 'info', `Slot ${key}: queued Short(s) ${pick.shortIds.join(', ')} for upload${settings.dryRun ? ' (dry run)' : ''}.`, {entity: 'schedule', id: key});
  return {acted: true, slot: key, queued: pick.shortIds};
};
