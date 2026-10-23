/** Google resets API quota at midnight Pacific time, so usage is counted per Pacific day. */
export const quotaDay = (at = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles'}).format(at);

export const quotaUsed = (db, bucket, at = new Date()) => db.get('SELECT used FROM quota_ledger WHERE day = ? AND bucket = ?', quotaDay(at), bucket)?.used ?? 0;

export const recordQuota = (db, bucket, units = 1, at = new Date()) =>
  db.run('INSERT INTO quota_ledger (day, bucket, used) VALUES (?,?,?) ON CONFLICT(day, bucket) DO UPDATE SET used = used + excluded.used', quotaDay(at), bucket, units);

/** Buckets as Google documents them: uploads are counted separately from everything else. */
export const quotaStatus = (db, settings, at = new Date()) => ({
  day: quotaDay(at),
  uploads: {used: quotaUsed(db, 'insert', at), limit: settings['quota.insertPerDay']},
  general: {used: quotaUsed(db, 'general', at), limit: 10000},
});
