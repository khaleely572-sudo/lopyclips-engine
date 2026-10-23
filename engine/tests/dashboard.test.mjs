import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {startDashboard} from '../dashboard/server.mjs';
import {setPermission} from '../db/creators.mjs';
import {getSettings} from '../db/settings.mjs';
import {BASIS, makeCreator, makeDb, makeShort, makeSource, silentLog} from './helpers.mjs';

const start = async () => {
  const db = makeDb();
  const server = startDashboard({db, log: silentLog}, {port: 0});
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {'X-LopyClips-Token': server.token}) => {
    const res = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body ? JSON.stringify(body) : undefined});
    return {status: res.status, body: await res.json().catch(() => null)};
  };
  return {db, server, base, call};
};

test('the dashboard serves state, and its page carries the session token', async (t) => {
  const {server, base, call} = await start();
  t.after(() => server.close());
  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.settings['automation.paused'], true);
  assert.equal(state.body.settings.dryRun, true);
  assert.equal(state.body.settings.requireApproval, true);
  assert.equal(state.body.settings['upload.visibility'], 'private');
  const page = await (await fetch(base)).text();
  assert.ok(page.includes(server.token) && !page.includes('__TOKEN__'));
});

test('changes are refused without the token, from another origin, or with a foreign Host', async (t) => {
  const {db, server, call} = await start();
  t.after(() => server.close());
  assert.equal((await call('POST', '/api/control', {action: 'resume'}, {})).status, 403);
  assert.equal((await call('POST', '/api/control', {action: 'resume'}, {'X-LopyClips-Token': 'wrong'})).status, 403);
  assert.equal((await call('POST', '/api/control', {action: 'resume'}, {'X-LopyClips-Token': server.token, Origin: 'https://evil.example'})).status, 403);
  assert.equal(getSettings(db)['automation.paused'], true, 'nothing changed');
  const foreignHost = await new Promise((resolve) => {
    http.get({host: '127.0.0.1', port: server.address().port, path: '/api/state', headers: {Host: 'evil.example'}}, (res) => resolve(res.statusCode));
  });
  assert.equal(foreignHost, 403);
});

test('pause, resume and the emergency stop work from the dashboard', async (t) => {
  const {db, server, call} = await start();
  t.after(() => server.close());
  assert.equal((await call('POST', '/api/control', {action: 'resume'})).status, 200);
  assert.equal(getSettings(db)['automation.paused'], false);
  await call('POST', '/api/control', {action: 'emergency-stop'});
  assert.equal(getSettings(db)['automation.emergencyStop'], true);
  assert.equal((await call('GET', '/health')).body.ok, false);
  await call('POST', '/api/control', {action: 'clear-emergency'});
  assert.deepEqual([getSettings(db)['automation.emergencyStop'], getSettings(db)['automation.paused']], [false, true], 'clearing the stop leaves automation paused');
});

test('creators can be added and removed, and authorizing one needs a written basis', async (t) => {
  const {db, server, call} = await start();
  t.after(() => server.close());
  const added = await call('POST', '/api/creators', {name: 'New Streamer', handle: 'NewStreamer'});
  assert.equal(added.body.handle, '@NewStreamer');
  assert.equal(added.body.permission_status, 'unknown');
  const refused = await call('PATCH', `/api/creators/${added.body.id}`, {permissionStatus: 'authorized', permissionBasis: 'ok'});
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /basis/);
  const saved = await call('PATCH', `/api/creators/${added.body.id}`, {permissionStatus: 'authorized', permissionBasis: BASIS});
  assert.equal(saved.body.permission_status, 'authorized');
  assert.match(db.get("SELECT message FROM events WHERE entity = 'creator' ORDER BY id DESC").message, /authorized/);
  assert.equal((await call('DELETE', `/api/creators/${added.body.id}`)).body.result, 'deleted');
});

test('public uploads cannot be switched on before a private upload has succeeded', async (t) => {
  const {db, server, call} = await start();
  t.after(() => server.close());
  const noConfirm = await call('POST', '/api/settings', {settings: {'upload.allowNonPrivate': true}});
  assert.equal(noConfirm.status, 409);
  const noPrivateYet = await call('POST', '/api/settings', {settings: {'upload.allowNonPrivate': true, 'upload.visibility': 'public'}, confirmNonPrivate: true});
  assert.equal(noPrivateYet.status, 409);
  assert.match(noPrivateYet.body.error, /private upload/);
  assert.equal(getSettings(db)['upload.visibility'], 'private');
  assert.equal((await call('POST', '/api/settings', {settings: {'schedule.dailyLimit': 6}})).status, 200);
  assert.equal(getSettings(db)['schedule.dailyLimit'], 6);
  assert.equal((await call('POST', '/api/settings', {settings: {'schedule.maxPerSlot': 5}})).status, 400, 'more than two per slot is refused');
});

test('with public uploads on, other settings and switching back to private save without confirmation', async (t) => {
  const {db, server, call} = await start();
  t.after(() => server.close());
  const creator = makeCreator(db, {authorized: true});
  const id = makeShort(db, makeSource(db, creator.id).video_id, {status: 'uploaded'});
  db.run("INSERT INTO uploads (short_id, state, visibility, video_id, confirmed_at, created_at) VALUES (?, 'confirmed', 'private', 'vid', ?, ?)", id, new Date().toISOString(), new Date().toISOString());
  const open = {'upload.allowNonPrivate': true, 'upload.visibility': 'public'};
  assert.equal((await call('POST', '/api/settings', {settings: open, confirmNonPrivate: true})).status, 200);

  assert.equal((await call('POST', '/api/settings', {settings: {'schedule.maxPerSlot': 1}})).status, 200);
  // A page that sends the unchanged upload switches along with another change is not blocked either.
  assert.equal((await call('POST', '/api/settings', {settings: {...open, 'schedule.dailyLimit': 6}})).status, 200);
  assert.equal((await call('POST', '/api/settings', {settings: {'upload.visibility': 'private'}})).status, 200, 'tightening needs no confirmation');
  assert.equal((await call('POST', '/api/settings', {settings: {'upload.allowNonPrivate': false}})).status, 200);
  assert.deepEqual([getSettings(db)['upload.visibility'], getSettings(db)['upload.allowNonPrivate']], ['private', false]);
  assert.equal((await call('POST', '/api/settings', {settings: open})).status, 409, 'opening it up again still needs confirmation');
});

test('approval is manual, checked against compliance, and shown accurately', async (t) => {
  const {db, server, call} = await start();
  t.after(() => server.close());
  const creator = makeCreator(db, {authorized: true});
  const source = makeSource(db, creator.id);
  const waiting = makeShort(db, source.video_id, {status: 'awaiting_approval'});
  const failed = makeShort(db, source.video_id, {status: 'verify_failed'});

  assert.equal((await call('POST', `/api/shorts/${failed}/approve`)).status, 409, 'a failed render cannot be approved');
  assert.equal((await call('POST', `/api/shorts/${waiting}/approve`)).status, 200);
  const listed = (await call('GET', '/api/shorts')).body;
  assert.deepEqual(listed.map((short) => [short.id, short.status]), [[failed, 'verify_failed'], [waiting, 'approved']]);
  assert.equal((await call('GET', '/api/state')).body.schedule.queue[0].shorts[0].id, waiting);

  const second = makeShort(db, source.video_id, {status: 'awaiting_approval'});
  setPermission(db, creator.id, 'denied', 'creator asked to stop');
  const blocked = await call('POST', `/api/shorts/${second}/approve`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /permission/);
});

test('upload sessions are never exposed through the API', async (t) => {
  const {db, server, call} = await start();
  t.after(() => server.close());
  const creator = makeCreator(db, {authorized: true});
  const id = makeShort(db, makeSource(db, creator.id).video_id);
  db.run("INSERT INTO uploads (short_id, state, visibility, session_uri, created_at) VALUES (?, 'uploading', 'private', 'https://upload.example/secret-session', ?)", id, new Date().toISOString());
  const uploads = await call('GET', '/api/uploads');
  assert.equal(uploads.body.length, 1);
  assert.ok(!JSON.stringify(uploads.body).includes('secret-session'));
});
