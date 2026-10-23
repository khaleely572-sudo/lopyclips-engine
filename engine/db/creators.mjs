import fs from 'node:fs';
import {enqueue} from '../jobs/queue.mjs';
import {PERMISSION_BLOCK_PREFIX, PERMISSION_STATUSES, checkAccess} from '../sources/access.mjs';
import {logEvent, now} from './db.mjs';

const cleanHandle = (handle) => {
  const value = String(handle ?? '').trim();
  if (!/^@?[\w.-]{3,60}$/.test(value)) {
    throw new Error('A handle looks like @ChannelName.');
  }
  return value.startsWith('@') ? value : `@${value}`;
};

export const listCreators = (db) => db.all('SELECT * FROM creators ORDER BY name COLLATE NOCASE');
export const getCreator = (db, id) => db.get('SELECT * FROM creators WHERE id = ?', id);

export const addCreator = (db, {name, handle}) => {
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.length > 80) {
    throw new Error('A creator needs a name (up to 80 characters).');
  }
  const id = db.run('INSERT INTO creators (name, handle, created_at) VALUES (?,?,?)', cleanName, cleanHandle(handle), now()).lastInsertRowid;
  logEvent(db, 'info', `Creator added: ${cleanName}`, {entity: 'creator', id});
  return getCreator(db, Number(id));
};

/** Load the seed list the first time the engine runs. Seeded creators always start with no permission. */
export const importSeed = (db, seedPath) => {
  if (db.get('SELECT COUNT(*) AS n FROM creators').n > 0 || !fs.existsSync(seedPath)) {
    return 0;
  }
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  for (const entry of seed) {
    addCreator(db, entry);
  }
  return seed.length;
};

/** Re-apply the permission rule to a creator's sources after their permission changes. */
export const reevaluateSources = (db, creatorId) => {
  const creator = getCreator(db, creatorId);
  const access = checkAccess(creator);
  if (access.allowed) {
    const blocked = db.all("SELECT video_id FROM sources WHERE creator_id = ? AND status = 'blocked' AND blocked_reason LIKE ?", creatorId, `${PERMISSION_BLOCK_PREFIX}%`);
    for (const {video_id: videoId} of blocked) {
      db.run("UPDATE sources SET status = 'discovered', blocked_reason = NULL, updated_at = ? WHERE video_id = ?", now(), videoId);
      enqueue(db, 'transcript', {videoId}, {key: `transcript:${videoId}`});
    }
    return blocked.length;
  }
  return db.run(
    "UPDATE sources SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE creator_id = ? AND status IN ('discovered','transcript_ready','analyzed')",
    access.reason,
    now(),
    creatorId,
  ).changes;
};

export const setPermission = (db, id, status, basis) => {
  if (!PERMISSION_STATUSES.includes(status)) {
    throw new Error('Permission must be unknown, authorized or denied.');
  }
  const text = String(basis ?? '').trim();
  if (status === 'authorized' && text.length < 10) {
    throw new Error('To authorize a creator, write down the basis (who gave permission, where, when) in at least a sentence.');
  }
  db.run('UPDATE creators SET permission_status = ?, permission_basis = ?, permission_recorded_at = ? WHERE id = ?', status, text || null, now(), id);
  logEvent(db, 'warn', `Permission for creator set to "${status}"`, {entity: 'creator', id, data: {basis: text || null}});
  return reevaluateSources(db, id);
};

export const updateCreator = (db, id, patch) => {
  const creator = getCreator(db, id);
  if (!creator) {
    throw new Error('Creator not found.');
  }
  if ('enabled' in patch) {
    db.run('UPDATE creators SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, id);
  }
  if ('handle' in patch) {
    db.run('UPDATE creators SET handle = ?, channel_id = NULL, uploads_playlist_id = NULL WHERE id = ?', cleanHandle(patch.handle), id);
  }
  if ('notes' in patch) {
    db.run('UPDATE creators SET notes = ? WHERE id = ?', String(patch.notes ?? '').slice(0, 1000) || null, id);
  }
  if ('facecamRect' in patch) {
    const r = patch.facecamRect;
    const valid = r === null || (r && [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n) && n >= 0) && r.w > 0 && r.h > 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080);
    if (!valid) {
      throw new Error('The facecam rectangle must fit inside a 1920x1080 frame.');
    }
    db.run('UPDATE creators SET facecam_rect = ? WHERE id = ?', r === null ? null : JSON.stringify(r), id);
  }
  if ('permissionStatus' in patch) {
    setPermission(db, id, patch.permissionStatus, patch.permissionBasis);
  }
  return getCreator(db, id);
};

/** Delete a creator with no history; one that already has sources is disabled instead so the audit trail stays intact. */
export const removeCreator = (db, id) => {
  if (db.get('SELECT COUNT(*) AS n FROM sources WHERE creator_id = ?', id).n > 0) {
    db.run('UPDATE creators SET enabled = 0 WHERE id = ?', id);
    return 'disabled';
  }
  db.run('DELETE FROM creators WHERE id = ?', id);
  return 'deleted';
};
