const KEY = 'state.uploadHold';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN_HOLD = HOUR;
const MAX_HOLD = 6 * HOUR;
const MARGIN = 5 * 60 * 1000;

/**
 * YouTube caps how many videos a channel may upload in a day and does not publish the number.
 * When it refuses an upload for that reason, the engine stops trying for a while instead of
 * knocking again every few minutes. This is the hold in force at `at`, or null.
 */
export const getUploadHold = (db, at = new Date()) => {
  const row = db.get('SELECT value_json FROM settings WHERE key = ?', KEY);
  const hold = row ? JSON.parse(row.value_json) : null;
  return hold && Date.parse(hold.until) > at.getTime() ? hold : null;
};

/**
 * Start (or extend) the hold. YouTube counts uploads over roughly the last 24 hours, so room
 * should open up a day after the oldest upload in that window. Wait until then, but never less
 * than an hour and never more than six, in case its counting differs from that guess.
 */
export const startUploadHold = (db, at = new Date()) => {
  const recent = db.all("SELECT confirmed_at FROM uploads WHERE state = 'confirmed' AND confirmed_at >= ? ORDER BY confirmed_at", new Date(at.getTime() - DAY).toISOString());
  const roomAt = recent.length > 0 ? Date.parse(recent[0].confirmed_at) + DAY + MARGIN : at.getTime() + MAX_HOLD;
  const until = new Date(Math.min(at.getTime() + MAX_HOLD, Math.max(at.getTime() + MIN_HOLD, roomAt))).toISOString();
  const hold = {until, since: at.toISOString(), uploadsLast24h: recent.length};
  db.run('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', KEY, JSON.stringify(hold));
  return hold;
};

export const clearUploadHold = (db) => db.run('DELETE FROM settings WHERE key = ?', KEY).changes > 0;

export const isUploadLimit = (err) => err?.reason === 'uploadLimitExceeded' || /\(uploadLimitExceeded\)/.test(String(err?.message ?? ''));
