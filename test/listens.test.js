process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../src/app');
const { iso } = require('../src/lib/time');
const contentRepo = require('../src/modules/content/repo');
const { createListenService, MAX_AGE_MS, MAX_AHEAD_MS, COUNTS_AFTER_MS } = require('../src/modules/player/listens');
const { createPlayerRouter } = require('../src/modules/player/routes');
const Content = require('../models/Content');
const Listen = require('../models/Listen');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const clock = { t: Math.floor(Date.now() / 1000) * 1000, now: () => clock.t };
const marked = [];
const library = { markPlayed: async (auth, listens) => { marked.push({ auth, listens }); } };
const buildApp = (deps = {}) => createApp({
  trustProxy: 1,
  playerRouter: createPlayerRouter({ listens: createListenService({ now: clock.now, library, ...deps }) }),
});
const app = buildApp();

before(db.connect);
beforeEach(async () => {
  await db.clear();
  // Whole seconds, so an `endedAt` written without milliseconds is exactly where the test puts it.
  clock.t = Math.floor(Date.now() / 1000) * 1000;
  marked.length = 0;
});
after(db.disconnect);

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';

async function account() {
  return signIn(await makeUser({ password: HASH, emailVerified: true }));
}

async function guest() {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.user.id, headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

async function add(owner, fields = {}) {
  const doc = await Content.create({ ownerId: owner.user._id, type: 'song', title: 'Song', durationSec: 200, listens: 0, ...fields });
  return String(doc._id);
}
const listensOf = async (id) => (await Content.findById(id).lean()).listens;
/** An event that ended `secondsAgo` before the clock. */
const event = (songId, { secondsAgo = 60, ...fields } = {}) => ({
  songId, listenedMs: 187040, completed: true, endedAt: iso(clock.t - secondsAgo * 1000), ...fields,
});
const send = (who, events, { headers = {}, target = app } = {}) => request(target).post('/v1/me/listens')
  .set({ ...who.headers, ...headers }).send({ events });

function assertReceived(res) {
  assert.equal(res.status, 202, res.text);
  assert.equal(res.text, '');
  assert.ok(res.headers['x-request-id']);
}

test('a batch is received (202, no body); listens that count move the song\'s count, once each', async () => {
  const artist = await account();
  const me = await account();
  const [a, b, c, d] = [await add(artist), await add(artist), await add(artist), await add(artist, { listens: 913 })];
  const res = await send(me, [
    event(a, { listenedMs: COUNTS_AFTER_MS, completed: false, secondsAgo: 10 }),
    event(b, { listenedMs: COUNTS_AFTER_MS - 1, completed: false }),
    event(c, { listenedMs: 0, completed: true }),
    event(d, { listenedMs: 45000, completed: false, secondsAgo: 5 }),
    event(d, { listenedMs: 2000, completed: false, secondsAgo: 1 }),
  ]);
  assertReceived(res);
  assert.equal(COUNTS_AFTER_MS, 30000);
  assert.deepEqual([await listensOf(a), await listensOf(b), await listensOf(c), await listensOf(d)], [1, 0, 1, 914]);
  const stored = await Listen.find().sort({ endedAt: 1 }).lean();
  assert.equal(stored.length, 5, 'every event is kept, counted or not');
  assert.deepEqual(stored.map((l) => [String(l.songId), l.counted]).sort(),
    [[a, true], [b, false], [c, true], [d, false], [d, true]].sort());
  for (const l of stored) {
    assert.deepEqual([String(l.listenerId), l.listenerType, l.receivedAt.getTime(), l.source], [String(me.user._id), 'user', clock.t, null]);
  }
});

test('a resend, or the same event twice in a batch, is ignored and never counts twice', async () => {
  const artist = await account();
  const me = await account();
  const id = await add(artist);
  const batch = [event(id, { secondsAgo: 30 }), event(id, { secondsAgo: 30 }), event(id, { secondsAgo: 20 })];
  assertReceived(await send(me, batch));
  assert.equal(await listensOf(id), 2);
  assertReceived(await send(me, batch));
  assertReceived(await send(me, [{ ...batch[0], endedAt: batch[0].endedAt.replace('Z', '.000Z') }]));
  assert.equal(await listensOf(id), 2, 'the same listener, song and endedAt (in any spelling) count once');
  assert.equal(await Listen.countDocuments(), 2);
  assert.equal(marked.length, 3);
  assert.deepEqual(marked.map((m) => m.listens.length), [2, 0, 0], 'only new listens reach the library');

  const other = await account();
  assertReceived(await send(other, batch.slice(0, 1)));
  assert.equal(await listensOf(id), 3, 'another listener\'s listen at the same time counts');
});

test('the same batch sent twice at once (no Idempotency-Key) counts each listen once', async () => {
  const artist = await account();
  const me = await account();
  const ids = [await add(artist), await add(artist)];
  const batch = ids.flatMap((id) => [event(id, { secondsAgo: 40 }), event(id, { secondsAgo: 10 })]);
  const results = await Promise.all([send(me, batch), send(me, batch), send(me, batch)]);
  for (const res of results) assertReceived(res);
  assert.deepEqual([await listensOf(ids[0]), await listensOf(ids[1])], [2, 2]);
  assert.equal(await Listen.countDocuments(), 4);
});

test('Idempotency-Key: a retry gets the stored 202 again; the same key with another batch is IDEMPOTENCY_KEY_REUSED', async () => {
  const artist = await account();
  const me = await account();
  const id = await add(artist);
  const key = crypto.randomUUID();
  const first = await send(me, [event(id)], { headers: { 'Idempotency-Key': key } });
  assertReceived(first);
  const retry = await send(me, [event(id)], { headers: { 'Idempotency-Key': key } });
  assertReceived(retry);
  assert.equal(retry.headers['idempotent-replayed'], 'true');
  assert.equal(await listensOf(id), 1);
  assertProblem(await send(me, [event(id, { secondsAgo: 5 })], { headers: { 'Idempotency-Key': key } }), 422, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await listensOf(id), 1);
  assertProblem(await send(me, [event(id)], { headers: { 'Idempotency-Key': 'not-a-uuid' } }), 400, 'MALFORMED_REQUEST');
});

test('dropped without an error: unknown songs, other types, songs the listener may not play, too old or too far ahead', async () => {
  const artist = await account();
  const me = await account();
  const g = await guest();
  const kept = await add(artist);
  const restricted = await add(artist, { followersOnly: true });
  const membersAlbum = await add(artist, { type: 'album', title: 'Members', followersOnly: true });
  const onAlbum = await add(artist, { albumId: membersAlbum, trackNumber: 1 });
  const noAudio = await add(artist, { audio: { key: 'audio/x/y.mp3', status: 'processing', uploadedAt: new Date() } });
  const batch = [
    event(String(new mongoose.Types.ObjectId())),
    event(membersAlbum),
    event('not-an-id'),
    event(restricted),
    event(onAlbum),
    event(kept, { secondsAgo: MAX_AGE_MS / 1000 + 1 }),
    event(kept, { secondsAgo: -(MAX_AHEAD_MS / 1000 + 1) }),
    event(kept, { secondsAgo: MAX_AGE_MS / 1000 }),
    event(kept, { secondsAgo: -(MAX_AHEAD_MS / 1000) }),
    event(noAudio),
  ];
  for (const who of [me, g]) {
    assertReceived(await send(who, batch));
  }
  assert.equal(await listensOf(kept), 4, 'exactly 30 days old and exactly 5 minutes ahead are kept, for each listener');
  assert.equal(await listensOf(noAudio), 2, 'audio not ready now does not undo a listen');
  assert.deepEqual([await listensOf(restricted), await listensOf(onAlbum), await listensOf(membersAlbum)], [0, 0, 0]);
  assertReceived(await send(artist, [event(restricted), event(onAlbum)]));
  assert.deepEqual([await listensOf(restricted), await listensOf(onAlbum)], [1, 1], 'the artist may play them');
  assert.equal(await Listen.countDocuments(), 8);
});

test('guests can report listens: the listener is the guest', async () => {
  const artist = await account();
  const g = await guest();
  const id = await add(artist);
  assertReceived(await send(g, [event(id)]));
  const [stored] = await Listen.find().lean();
  assert.deepEqual([String(stored.listenerId), stored.listenerType], [g.id, 'guest']);
  assert.equal(await listensOf(id), 1);
  assert.equal(marked[0].auth.accountType, 'guest');
});

test('source: kept when usable; an album or playlist source without an id is dropped, and the listen still counts', async () => {
  const artist = await account();
  const me = await account();
  const id = await add(artist);
  const albumId = String(new mongoose.Types.ObjectId());
  const playlistId = String(new mongoose.Types.ObjectId()).toUpperCase();
  assertReceived(await send(me, [
    event(id, { secondsAgo: 1, source: { type: 'album', id: albumId } }),
    event(id, { secondsAgo: 2, source: { type: 'playlist', id: playlistId } }),
    event(id, { secondsAgo: 3, source: { type: 'liked_songs', id: albumId } }),
    event(id, { secondsAgo: 4, source: { type: 'song' } }),
    event(id, { secondsAgo: 5, source: { type: 'album' } }),
    event(id, { secondsAgo: 6, source: { type: 'playlist', id: 'not-an-id' } }),
  ]));
  const sources = (await Listen.find().sort({ endedAt: -1 }).lean()).map((l) => (l.source ? { ...l.source, ...(l.source.id ? { id: String(l.source.id) } : {}) } : null));
  assert.deepEqual(sources, [
    { type: 'album', id: albumId }, { type: 'playlist', id: playlistId.toLowerCase() }, { type: 'liked_songs' }, { type: 'song' }, null, null,
  ]);
  assert.equal(await listensOf(id), 6);
});

test('if the counts cannot be added, the batch is still received and its events stay stored', async () => {
  const artist = await account();
  const me = await account();
  const id = await add(artist);
  const failing = { ...contentRepo, addListens: async () => { throw new Error('database unavailable'); } };
  const errors = [];
  const logger = { error: (...args) => errors.push(args), warn() {}, info() {} };
  assertReceived(await send(me, [event(id)], { target: buildApp({ contents: failing, logger }) }));
  assert.equal(await Listen.countDocuments(), 1);
  assert.equal(await listensOf(id), 0);
  assert.equal(errors.length, 1);
});

test('the batch must have the spec\'s shape (validator); no token is 401', async () => {
  const me = await account();
  const id = String(new mongoose.Types.ObjectId());
  const ok = event(id);
  const bad = [
    [],
    Array.from({ length: 51 }, (_, i) => event(id, { secondsAgo: i })),
    [{ ...ok, songId: undefined }],
    [{ ...ok, listenedMs: -1 }],
    [{ ...ok, listenedMs: 86400001 }],
    [{ ...ok, listenedMs: 1.5 }],
    [{ ...ok, completed: 'yes' }],
    [{ ...ok, endedAt: 'yesterday' }],
    [{ ...ok, extra: 1 }],
    [{ ...ok, source: { type: 'radio' } }],
    [{ ...ok, source: { type: 'album', id, name: 'x' } }],
    [{ ...ok, songId: 'a'.repeat(65) }],
  ];
  for (const events of bad) {
    assertProblem(await send(me, events), 422, 'VALIDATION_FAILED');
  }
  assertProblem(await request(app).post('/v1/me/listens').set(me.headers).send({}), 422, 'VALIDATION_FAILED');
  assertProblem(await request(app).post('/v1/me/listens').set(me.headers).send({ events: [ok], more: 1 }), 422, 'VALIDATION_FAILED');
  assertReceived(await send(me, Array.from({ length: 50 }, (_, i) => event(id, { secondsAgo: i }))));
  assertProblem(await request(app).post('/v1/me/listens').set(CLIENT).send({ events: [ok] }), 401, 'UNAUTHENTICATED');
  assertProblem(await request(app).post('/v1/me/listens').set(me.headers).set('Content-Type', 'text/plain').send('x'), 415,
    'UNSUPPORTED_MEDIA_TYPE');
});

test('listens are limited to 60 a minute per account', async () => {
  const target = buildApp();
  const me = await account();
  const other = await account();
  const id = String(new mongoose.Types.ObjectId());
  for (let i = 0; i < 60; i += 1) assertReceived(await send(me, [event(id, { secondsAgo: i })], { target }));
  const limited = await send(me, [event(id)], { target });
  assertProblem(limited, 429, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assertReceived(await send(other, [event(id)], { target }));
});

test('the listens collection keeps one event per listener, song and endedAt (unique index)', async () => {
  const keys = Object.fromEntries((await Listen.collection.indexes()).map((ix) => [ix.name, ix]));
  assert.deepEqual([keys.listener_song_end.key, keys.listener_song_end.unique], [{ listenerId: 1, songId: 1, endedAt: 1 }, true]);
  assert.equal(Object.values(keys).some((ix) => ix.expireAfterSeconds !== undefined), false, 'no retention is decided yet');
});
