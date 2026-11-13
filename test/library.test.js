process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const request = require('supertest');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { createApp } = require('../src/app');
const { config } = require('../src/config');
const { iso } = require('../src/lib/time');
const { createLocalStorage } = require('../src/providers/storage/local');
const { createPlayerService } = require('../src/modules/player/service');
const { createPlayerRouter } = require('../src/modules/player/routes');
const { createListenService } = require('../src/modules/player/listens');
const { createLibraryService, CURSOR_TTL_MS, LOCK_LEASE_MS, LOCK_WAIT_MS } = require('../src/modules/player/library');
const { createLibraryRouter, LIMITS } = require('../src/modules/player/libraryRoutes');
const itemsRepo = require('../src/modules/player/repo');
const contentRepo = require('../src/modules/content/repo');
const libraryRepo = require('../src/modules/player/libraryRepo');
const Content = require('../models/Content');
const PlaylistItem = require('../models/PlaylistItem');
const SongLike = require('../models/SongLike');
const LibraryEntry = require('../models/LibraryEntry');
const LibraryLock = require('../models/LibraryLock');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bondfire-library-'));
const storage = createLocalStorage({ dir, publicUrl: config.media.publicUrl });
// Whole seconds, so times written without milliseconds are exactly where the test puts them.
const clock = { t: Math.floor(Date.now() / 1000) * 1000, now: () => clock.t };
const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const player = createPlayerService({ storage, now: clock.now });
const libraryWith = (deps = {}) => createLibraryService({ player, now: clock.now, sleep: realSleep, ...deps });
const buildApp = (deps = {}) => {
  const library = libraryWith(deps);
  return createApp({
    trustProxy: 1,
    storage,
    playerRouter: createPlayerRouter({ player, listens: createListenService({ now: clock.now, library }) }),
    libraryRouter: createLibraryRouter({ library }),
  });
};
const app = buildApp();

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
const ajv = new Ajv2020({ strict: false, logger: false });
const assertMatchesSpec = (name, value) => assert.equal(
  ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value),
  true,
  `${name}: ${JSON.stringify(ajv.errors)}`,
);

before(db.connect);
beforeEach(async () => {
  await db.clear();
  clock.t = Math.floor(Date.now() / 1000) * 1000;
});
after(async () => {
  await db.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
const ART = Object.freeze({
  url: 'https://cdn.example.com/p/quiet-hours/512.jpg', width: 512, height: 512,
  palette: { version: 1, seed: '#2F6FB0', accent: '#2F6FB0', neutral: false }, blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
});
const oid = () => String(new mongoose.Types.ObjectId());
const ago = (minutes) => new Date(clock.t - minutes * 60 * 1000);
let files = 0;
const audio = () => ({
  key: `audio/s${(files += 1)}/f${files}.mp3`, mimeType: 'audio/mpeg', sizeBytes: 4096, durationMs: 187040,
  status: 'ready', uploadedAt: new Date(),
});

async function account(extra = {}) {
  return signIn(await makeUser({ password: HASH, emailVerified: true, ...extra }));
}

async function guest() {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(res.status, 201, res.text);
  return { headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

/** One `contents` item of `owner`, made at `createdAt` (default: the clock). */
async function add(owner, { createdAt = new Date(clock.t), ...fields } = {}) {
  const doc = new Content({
    ownerId: owner.user._id, type: 'song', title: 'Untitled', durationSec: 200, ...fields, createdAt, updatedAt: createdAt,
  });
  await doc.save({ timestamps: false });
  return String(doc._id);
}
const song = (owner, fields = {}) => add(owner, { type: 'song', audio: audio(), ...fields });
const playlist = (owner, fields = {}) => add(owner, { type: 'playlist', songCount: 0, ...fields });

/** Put songs in a playlist at these positions, all added at `addedAt`. */
async function fill(playlistId, entries, addedAt = ago(60)) {
  await PlaylistItem.insertMany(entries.map(([songId, position]) => ({ playlistId, songId, position, addedAt })));
}
const save = (who, playlistId, savedAt, extra = {}) => LibraryEntry.create({
  userId: who.user._id, kind: 'playlist', playlistId, savedAt, ...extra,
});
const like = (who, songId, likedAt) => SongLike.create({ userId: who.user._id, songId, likedAt });
const setAccountCreated = (who, at) => User.collection.updateOne({ _id: who.user._id }, { $set: { createdAt: at } });

const call = (who, method, url, body, target = app) => {
  const req = request(target)[method](`/v1${url}`).set(who.headers);
  return body === undefined ? req : req.send(body);
};
const get = (who, url, target = app) => call(who, 'get', url, undefined, target);
const likeSong = (who, id, target = app) => call(who, 'put', `/me/liked-songs/${id}`, undefined, target);
const unlikeSong = (who, id) => call(who, 'delete', `/me/liked-songs/${id}`);
const setPlaylists = (who, songId, playlistIds, target = app) => call(who, 'put', `/me/library/songs/${songId}/playlists`,
  { playlistIds }, target);
const likedId = (who) => `liked_${String(who.user._id)}`;

function assertOk(res, schema) {
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec(schema, res.body);
  assert.equal(res.headers['cache-control'], 'private, no-cache');
}

function assertNoContent(res) {
  assert.equal(res.status, 204, res.text);
  assert.equal(res.text, '');
}

/** A playlist's items, in playlist order, as `[songId, position]`. */
async function itemsOf(playlistId) {
  const rows = await PlaylistItem.find({ playlistId }).sort({ position: 1, _id: 1 }).lean();
  return rows.map((row) => [String(row.songId), row.position]);
}

/** Every item there is, as `playlistId songId` strings, sorted (to compare whole states). */
async function allItems() {
  return (await PlaylistItem.find().lean()).map((row) => `${row.playlistId} ${row.songId} ${row.position}`).sort();
}

/** What Add to Playlist writes on playlists, for comparing states. */
async function playlistStats(ids) {
  const docs = await Content.find({ _id: { $in: ids } }, { songCount: 1, songsUpdatedAt: 1 }).sort({ _id: 1 }).lean();
  return docs.map((doc) => [String(doc._id), doc.songCount, doc.songsUpdatedAt ? doc.songsUpdatedAt.getTime() : null]);
}

// ---------------------------------------------------------------------------
// Accounts only
// ---------------------------------------------------------------------------

test('every Library operation is for accounts: a guest gets 403 GUEST_NOT_ALLOWED, no token 401', async () => {
  const g = await guest();
  const artist = await account();
  const id = await song(artist);
  const operations = [
    ['get', '/me/liked-songs'], ['put', `/me/liked-songs/${id}`], ['delete', `/me/liked-songs/${id}`],
    ['get', '/me/library/playlists'], ['get', `/me/library/songs/${id}`],
    ['put', `/me/library/songs/${id}/playlists`, { playlistIds: [] }],
  ];
  for (const [method, url, body] of operations) {
    assertProblem(await call(g, method, url, body), 403, 'GUEST_NOT_ALLOWED');
    const res = await call({ headers: CLIENT }, method, url, body);
    assertProblem(res, 401, 'UNAUTHENTICATED');
    assert.ok(res.headers['www-authenticate']);
  }
  assert.equal(await SongLike.countDocuments(), 0);
  assert.equal(await LibraryEntry.countDocuments(), 0);
});

// ---------------------------------------------------------------------------
// Likes: PUT / DELETE /me/liked-songs/{songId}
// ---------------------------------------------------------------------------

test('PUT /me/liked-songs/{id}: 204; the song is liked for this account only; liking again keeps likedAt', async () => {
  const artist = await account({ name: 'Mara Quillon' });
  const me = await account();
  const other = await account();
  const g = await guest();
  const id = await song(artist);
  const notLiked = await song(artist);

  assertNoContent(await likeSong(me, id));
  const [first] = await SongLike.find().lean();
  assert.deepEqual([String(first.userId), String(first.songId), first.likedAt.getTime()], [String(me.user._id), id, clock.t]);
  clock.t += 60 * 1000;
  assertNoContent(await likeSong(me, id.toUpperCase()));
  const rows = await SongLike.find().lean();
  assert.equal(rows.length, 1, 'liked once, in any case');
  assert.equal(rows[0].likedAt.getTime(), first.likedAt.getTime(), 'liking again keeps likedAt');

  assert.equal((await get(me, `/songs/${id}`)).body.liked, true);
  assert.equal((await get(other, `/songs/${id}`)).body.liked, false, 'another account has not liked it');
  assert.equal((await get(g, `/songs/${id}`)).body.liked, false, 'a guest never has');
  const list = await get(me, `/songs?ids=${notLiked},${id}`);
  assert.deepEqual(list.body.data.map((s) => [s.id, s.liked]), [[notLiked, false], [id, true]]);
});

test('PUT /me/liked-songs/{id}: 404 CONTENT_NOT_FOUND for an unknown id, an id in no known format, or an album or playlist', async () => {
  const me = await account();
  const albumId = await add(me, { type: 'album' });
  const playlistId = await playlist(me);
  for (const id of [oid(), 'nope', albumId, playlistId]) assertProblem(await likeSong(me, id), 404, 'CONTENT_NOT_FOUND');
  assertProblem(await likeSong(me, 'x'.repeat(65)), 422, 'VALIDATION_FAILED');
  assert.equal(await SongLike.countDocuments(), 0);
});

test('a followers-only song can be liked (the spec has no restriction there) and is listed with playable: false', async () => {
  const artist = await account();
  const me = await account();
  const albumId = await add(artist, { type: 'album', followersOnly: true });
  const restricted = await song(artist, { followersOnly: true });
  const onRestrictedAlbum = await song(artist, { albumId, trackNumber: 1 });
  assertNoContent(await likeSong(me, restricted));
  clock.t += 1000;
  assertNoContent(await likeSong(me, onRestrictedAlbum));
  const res = await get(me, '/me/liked-songs');
  assertOk(res, 'LikedSongPage');
  assert.deepEqual(res.body.data.map((s) => [s.id, s.liked, s.followersOnly, s.playable]),
    [[onRestrictedAlbum, true, true, false], [restricted, true, true, false]]);
});

test('DELETE /me/liked-songs/{id}: 204; idempotent, also for a song never liked, unknown or in no known format', async () => {
  const artist = await account();
  const me = await account();
  const other = await account();
  const id = await song(artist);
  await like(me, id, ago(10));
  await like(other, id, ago(10));
  assertNoContent(await unlikeSong(me, id.toUpperCase()));
  assert.deepEqual((await SongLike.find().lean()).map((row) => String(row.userId)), [String(other.user._id)],
    'only this account\'s like is gone');
  assert.equal((await get(me, `/songs/${id}`)).body.liked, false);
  assertNoContent(await unlikeSong(me, id));
  assertNoContent(await unlikeSong(me, oid()));
  assertNoContent(await unlikeSong(me, 'nope'));
  assert.equal(await SongLike.countDocuments(), 1);
  assert.equal(await LibraryEntry.countDocuments({ userId: other.user._id }), 0, 'nothing is noted for an account that unliked nothing');
});

test('liking moves the Liked songs entry\'s songCount and updatedAt; so does unliking (updatedAt), never back', async () => {
  const artist = await account();
  const me = await account();
  await setAccountCreated(me, ago(60 * 24));
  const [a, b] = [await song(artist), await song(artist)];
  const entry = async () => (await get(me, '/me/library/playlists')).body.data.find((e) => e.isLikedSongs);
  assert.deepEqual([(await entry()).songCount, (await entry()).updatedAt], [0, iso(ago(60 * 24))], 'empty: since the account was made');

  clock.t += 60 * 1000;
  assertNoContent(await likeSong(me, a));
  clock.t += 60 * 1000;
  assertNoContent(await likeSong(me, b));
  assert.deepEqual([(await entry()).songCount, (await entry()).updatedAt], [2, iso(clock.t)]);

  clock.t += 60 * 1000;
  assertNoContent(await unlikeSong(me, a));
  const unlikedAt = clock.t;
  assert.deepEqual([(await entry()).songCount, (await entry()).updatedAt], [1, iso(unlikedAt)]);
  assertNoContent(await unlikeSong(me, a));
  clock.t += 60 * 1000;
  assertNoContent(await unlikeSong(me, oid()));
  assert.equal((await entry()).updatedAt, iso(unlikedAt), 'unliking what is not liked changes nothing');
  await libraryRepo.markUnliked({ userId: String(me.user._id), at: ago(600) });
  assert.equal((await entry()).updatedAt, iso(unlikedAt), 'never moves back');
});

// ---------------------------------------------------------------------------
// GET /me/liked-songs
// ---------------------------------------------------------------------------

test('GET /me/liked-songs: newest like first with likedAt, paged by cursor; ties by the like; another account\'s likes are not listed', async () => {
  const artist = await account({ name: 'Theo Brannick' });
  const me = await account();
  const other = await account();
  const songs = [];
  for (let i = 0; i < 5; i += 1) songs.push(await song(artist, { title: `Song ${i}` }));
  await like(me, songs[0], ago(50));
  await like(me, songs[1], ago(40));
  await like(me, songs[2], ago(30));
  await like(me, songs[3], ago(30));
  await like(me, songs[4], ago(10));
  await like(other, songs[0], ago(1));
  const ties = (await SongLike.find({ userId: me.user._id, likedAt: ago(30) }).sort({ _id: -1 }).lean()).map((r) => String(r.songId));

  const expected = [songs[4], ...ties, songs[1], songs[0]];
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await get(me, `/me/liked-songs?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    assertOk(res, 'LikedSongPage');
    assert.equal(res.body.page.total, 5);
    seen.push(...res.body.data.map((s) => [s.id, s.likedAt, s.liked]));
    cursor = res.body.page.nextCursor;
    assert.equal(res.body.page.hasMore, cursor !== null);
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  const likedAt = { [songs[4]]: iso(ago(10)), [songs[2]]: iso(ago(30)), [songs[3]]: iso(ago(30)), [songs[1]]: iso(ago(40)), [songs[0]]: iso(ago(50)) };
  assert.deepEqual(seen, expected.map((id) => [id, likedAt[id], true]));

  const first = await get(me, '/me/liked-songs');
  assertOk(first, 'LikedSongPage');
  assert.deepEqual(first.body.page, { nextCursor: null, hasMore: false, total: 5 }, '20 by default');
  const song0 = (await get(me, `/songs/${songs[0]}`)).body;
  assert.deepEqual(first.body.data[4], { ...song0, likedAt: iso(ago(50)) }, 'each song as GET /songs/{id} gives it, plus likedAt');
  const theirs = await get(other, '/me/liked-songs');
  assert.deepEqual(theirs.body.data.map((s) => s.id), [songs[0]]);
});

test('GET /me/liked-songs: a song that no longer exists (or is no longer a song) is left out of its page but still counted', async () => {
  const artist = await account();
  const me = await account();
  const [a, b, c] = [await song(artist), await song(artist), await song(artist)];
  await like(me, a, ago(30));
  await like(me, b, ago(20));
  await like(me, c, ago(10));
  await Content.deleteOne({ _id: b });
  await Content.collection.updateOne({ _id: new mongoose.Types.ObjectId(c) }, { $set: { type: 'album' } });
  const res = await get(me, '/me/liked-songs?limit=2');
  assertOk(res, 'LikedSongPage');
  assert.deepEqual(res.body.data.map((s) => s.id), [], 'the first page\'s two likes are both gone');
  assert.deepEqual([res.body.page.hasMore, res.body.page.total], [true, 3]);
  const next = await get(me, `/me/liked-songs?limit=2&cursor=${res.body.page.nextCursor}`);
  assert.deepEqual(next.body.data.map((s) => s.id), [a]);
  assert.deepEqual([next.body.page.nextCursor, next.body.page.hasMore], [null, false]);
});

test('GET /me/liked-songs: a cursor works for its account only and for 24 hours; anything else is CURSOR_INVALID', async () => {
  const artist = await account();
  const me = await account();
  const other = await account();
  for (let i = 0; i < 3; i += 1) await like(me, await song(artist), ago(10 + i));
  const { nextCursor } = (await get(me, '/me/liked-songs?limit=1')).body.page;
  assert.ok(nextCursor);
  assertProblem(await get(other, `/me/liked-songs?cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  clock.t += CURSOR_TTL_MS + 1000;
  assertProblem(await get(me, `/me/liked-songs?cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  clock.t -= CURSOR_TTL_MS;
  assert.equal((await get(me, `/me/liked-songs?cursor=${nextCursor}`)).status, 200);

  const decoded = JSON.parse(Buffer.from(nextCursor, 'base64url').toString('utf8'));
  const forge = (change) => Buffer.from(JSON.stringify({ ...decoded, ...change })).toString('base64url');
  for (const cursor of ['not%20a%20cursor', 'bm90LWpzb24', forge({ i: 'nope' }), forge({ k: 'yesterday' }), forge({ k: null }),
    forge({ f: 'other' }), forge({ t: Math.floor((clock.t + 60 * 60 * 1000) / 1000) }), Buffer.from('null').toString('base64url')]) {
    assertProblem(await get(me, `/me/liked-songs?cursor=${cursor}`), 422, 'CURSOR_INVALID');
  }
  for (const query of ['limit=0', 'limit=51', 'limit=x', `cursor=${'a'.repeat(513)}`, 'other=1']) {
    assertProblem(await get(me, `/me/liked-songs?${query}`), 422, 'VALIDATION_FAILED');
  }
});

// ---------------------------------------------------------------------------
// GET /me/library/playlists
// ---------------------------------------------------------------------------

/**
 * A library with every kind of entry, made in this order (so ids ascend P1, P2, P3, S1, P4):
 * P1 own "Rainy Commute" (items, last added 10 min ago, played 5 min ago, artwork); P2 own "échoes" (hidden, empty,
 * never played); P3 own "Zebra" (followers-only; a song taken out 20 min ago; played 50 min ago); S1 "apple" saved
 * from Theo (items last added 10 min ago, saved 200 min ago); P4 own "Apple" (empty). Liked songs: 2 likes, the
 * newest 30 min ago, played 1 min ago. Not in it: Theo's playlist that is not saved, a saved row whose playlist is
 * gone, and a saved row naming a song.
 */
async function libraryFixture() {
  const me = await account();
  const theo = await account({ name: 'Theo Brannick' });
  await setAccountCreated(me, ago(1000));
  const [s1, s2, s3] = [await song(theo), await song(theo), await song(theo)];
  const P1 = await playlist(me, { title: 'Rainy Commute', image: ART, createdAt: ago(500) });
  const P2 = await playlist(me, { title: 'échoes', hidden: true, createdAt: ago(400) });
  const P3 = await playlist(me, { title: 'Zebra', followersOnly: true, createdAt: ago(300), songsUpdatedAt: ago(20) });
  const S1 = await playlist(theo, { title: 'apple', createdAt: ago(900) });
  const P4 = await playlist(me, { title: 'Apple', createdAt: ago(100) });
  const notSaved = await playlist(theo, { title: 'Not saved' });
  await fill(P1, [[s1, 1], [s2, 2]], ago(10));
  await fill(P3, [[s3, 1]], ago(90));
  await fill(S1, [[s1, 1], [s2, 2], [s3, 3]], ago(10));
  await fill(notSaved, [[s1, 1]], ago(1));
  await save(me, S1, ago(200));
  await save(me, oid(), ago(5));
  await save(me, s1, ago(5));
  await LibraryEntry.create({ userId: me.user._id, kind: 'playlist', playlistId: P1, savedAt: ago(500), playedAt: ago(5) });
  await LibraryEntry.create({ userId: me.user._id, kind: 'playlist', playlistId: P3, savedAt: ago(300), playedAt: ago(50) });
  await LibraryEntry.create({ userId: me.user._id, kind: 'liked_songs', playlistId: null, playedAt: ago(1) });
  await like(me, s1, ago(60));
  await like(me, s2, ago(30));
  const entry = (id, title, fields) => ({
    id, title, image: null, songCount: 0, playedAt: null, isLikedSongs: false, editable: true, ...fields,
  });
  const expected = {
    liked: entry(likedId(me), 'Liked songs', {
      songCount: 2, updatedAt: iso(ago(30)), savedAt: iso(ago(1000)), playedAt: iso(ago(1)), isLikedSongs: true, editable: false,
    }),
    P1: entry(P1, 'Rainy Commute', {
      image: { url: ART.url, width: 512, height: 512, status: 'ready', blurhash: ART.blurhash, palette: ART.palette },
      songCount: 2, updatedAt: iso(ago(10)), savedAt: iso(ago(500)), playedAt: iso(ago(5)),
    }),
    P2: entry(P2, 'échoes', { updatedAt: iso(ago(400)), savedAt: iso(ago(400)) }),
    P3: entry(P3, 'Zebra', { songCount: 1, updatedAt: iso(ago(20)), savedAt: iso(ago(300)), playedAt: iso(ago(50)) }),
    S1: entry(S1, 'apple', { songCount: 3, updatedAt: iso(ago(10)), savedAt: iso(ago(200)), editable: false }),
    P4: entry(P4, 'Apple', { updatedAt: iso(ago(100)), savedAt: iso(ago(100)) }),
  };
  return { me, theo, ids: { P1, P2, P3, S1, P4, notSaved }, songs: [s1, s2, s3], expected };
}

test('GET /me/library/playlists: own playlists (editable), saved ones, and exactly one Liked songs entry', async () => {
  const { me, expected } = await libraryFixture();
  const res = await get(me, '/me/library/playlists');
  assertOk(res, 'LibraryPlaylistPage');
  const { liked, P1, P2, P3, S1, P4 } = expected;
  assert.deepEqual(res.body, { data: [P1, S1, P3, liked, P4, P2], page: { nextCursor: null, hasMore: false, total: 6 } });
  assert.equal(res.body.data.filter((e) => e.isLikedSongs).length, 1);
});

test('GET /me/library/playlists: a new account has the Liked songs entry only, empty, since the account was made', async () => {
  const me = await account();
  const made = (await User.findById(me.user._id).lean()).createdAt;
  const res = await get(me, '/me/library/playlists');
  assertOk(res, 'LibraryPlaylistPage');
  assert.deepEqual(res.body, {
    data: [{
      id: likedId(me), title: 'Liked songs', image: null, songCount: 0, updatedAt: iso(made), savedAt: iso(made),
      playedAt: null, isLikedSongs: true, editable: false,
    }],
    page: { nextCursor: null, hasMore: false, total: 1 },
  });
});

test('GET /me/library/playlists: each sort as the spec says, ties by id, never played last, titles without case or accents', async () => {
  const { me, ids: { P1, P2, P3, S1, P4 } } = await libraryFixture();
  const L = likedId(me);
  const orders = {
    recently_updated: [P1, S1, P3, L, P4, P2],
    recently_played: [L, P1, P3, P2, S1, P4],
    recently_saved: [P4, S1, P3, P2, P1, L],
    title: [S1, P4, P2, L, P1, P3],
  };
  for (const [sort, order] of Object.entries(orders)) {
    const res = await get(me, `/me/library/playlists?sort=${sort}`);
    assertOk(res, 'LibraryPlaylistPage');
    assert.deepEqual(res.body.data.map((e) => e.id), order, sort);
  }
  assert.deepEqual((await get(me, '/me/library/playlists')).body.data.map((e) => e.id), orders.recently_updated, 'the default');
});

test('GET /me/library/playlists: pages follow the sort by cursor; a cursor works for its account and sort, for 24 hours', async () => {
  const { me, theo } = await libraryFixture();
  for (const sort of ['recently_updated', 'recently_played', 'recently_saved', 'title']) {
    const whole = (await get(me, `/me/library/playlists?sort=${sort}&limit=200`)).body.data.map((e) => e.id);
    const seen = [];
    let cursor = null;
    do {
      const res = await get(me, `/me/library/playlists?sort=${sort}&limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      assertOk(res, 'LibraryPlaylistPage');
      assert.equal(res.body.page.total, 6);
      seen.push(...res.body.data.map((e) => e.id));
      cursor = res.body.page.nextCursor;
      assert.equal(res.body.page.hasMore, cursor !== null);
    } while (cursor);
    assert.deepEqual(seen, whole, sort);
  }

  const { nextCursor } = (await get(me, '/me/library/playlists?sort=recently_played&limit=1')).body.page;
  assertProblem(await get(me, `/me/library/playlists?sort=title&cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  assertProblem(await get(me, `/me/library/playlists?cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  assertProblem(await get(theo, `/me/library/playlists?sort=recently_played&cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  clock.t += CURSOR_TTL_MS + 1000;
  assertProblem(await get(me, `/me/library/playlists?sort=recently_played&cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  clock.t -= CURSOR_TTL_MS + 1000;
  const second = await get(me, `/me/library/playlists?sort=recently_played&limit=1&cursor=${nextCursor}`);
  assertOk(second, 'LibraryPlaylistPage');
  const decoded = JSON.parse(Buffer.from(second.body.page.nextCursor, 'base64url').toString('utf8'));
  const forge = (change) => Buffer.from(JSON.stringify({ ...decoded, ...change })).toString('base64url');
  for (const cursor of ['bm90LWpzb24', forge({ i: 'nope' }), forge({ i: 'liked_x' }), forge({ k: 'soon' }), forge({ k: 1.5 }),
    forge({ f: 'other' }), forge({ t: null })]) {
    assertProblem(await get(me, `/me/library/playlists?sort=recently_played&cursor=${cursor}`), 422, 'CURSOR_INVALID');
  }
  const never = await get(me, `/me/library/playlists?sort=recently_played&limit=4&cursor=${forge({ k: null, i: '0'.repeat(24) })}`);
  assert.equal(never.body.data.length, 3, 'a cursor among the never played starts after it');
  for (const query of ['limit=0', 'limit=201', 'sort=newest', 'other=1']) {
    assertProblem(await get(me, `/me/library/playlists?${query}`), 422, 'VALIDATION_FAILED');
  }
});

// ---------------------------------------------------------------------------
// GET /me/library/songs/{songId}
// ---------------------------------------------------------------------------

test('GET /me/library/songs/{id}: liked, and the viewer\'s own playlists holding it (not saved ones, not Liked songs)', async () => {
  const { me, theo, ids: { P1, P3, S1, notSaved }, songs: [s1, s2, s3] } = await libraryFixture();
  const state = async (id, who = me) => {
    const res = await get(who, `/me/library/songs/${id}`);
    assertOk(res, 'SongLibraryState');
    return { ...res.body, playlistIds: [...res.body.playlistIds].sort() };
  };
  assert.deepEqual(await state(s1), { liked: true, playlistIds: [P1] });
  assert.deepEqual(await state(s2.toUpperCase()), { liked: true, playlistIds: [P1] });
  assert.deepEqual(await state(s3), { liked: false, playlistIds: [P3] });
  assert.deepEqual(await state(s1, theo), { liked: false, playlistIds: [S1, notSaved].sort() });
  const other = await account();
  assert.deepEqual(await state(s1, other), { liked: false, playlistIds: [] });
  for (const id of [oid(), 'nope', P1]) assertProblem(await get(me, `/me/library/songs/${id}`), 404, 'CONTENT_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// PUT /me/library/songs/{songId}/playlists
// ---------------------------------------------------------------------------

/** Four own playlists: A (s1, s2), B (s3 at 5), C (the song, then s4), D (empty), E (untouched); one song to move. */
async function addFixture() {
  const me = await account();
  const artist = await account();
  const [s1, s2, s3, s4, x] = [await song(artist), await song(artist), await song(artist), await song(artist), await song(artist)];
  const made = ago(500);
  const lists = {};
  for (const name of ['A', 'B', 'C', 'D', 'E']) lists[name] = await playlist(me, { title: name, createdAt: made });
  await fill(lists.A, [[s1, 1], [s2, 2]], ago(100));
  await fill(lists.B, [[s3, 5]], ago(100));
  await fill(lists.C, [[x, 1], [s4, 2]], ago(100));
  return { me, artist, made, lists, songs: { s1, s2, s3, s4, x } };
}

test('PUT .../playlists: the song goes at the end of the new playlists and out of the others, whose order stays; counts and times follow', async () => {
  const { me, made, lists: { A, B, C, D, E }, songs: { s1, s2, s3, s4, x } } = await addFixture();
  clock.t += 60 * 1000;
  const res = await setPlaylists(me, x, [A, B, D]);
  assertOk(res, 'SongPlaylists');
  assert.deepEqual(res.body, { playlistIds: [A, B, D] });
  assert.deepEqual(await itemsOf(A), [[s1, 1], [s2, 2], [x, 3]]);
  assert.deepEqual(await itemsOf(B), [[s3, 5], [x, 6]]);
  assert.deepEqual(await itemsOf(C), [[s4, 2]]);
  assert.deepEqual(await itemsOf(D), [[x, 1]]);
  assert.deepEqual(await itemsOf(E), []);
  const added = await PlaylistItem.find({ songId: x }).lean();
  assert.ok(added.every((item) => item.addedAt.getTime() === clock.t));

  assert.deepEqual(await playlistStats([A, B, C, D, E]), [
    [A, 3, clock.t], [B, 2, clock.t], [C, 1, clock.t], [D, 1, clock.t], [E, 0, null],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  for (const [id, songCount, updatedAt] of [[A, 3, clock.t], [C, 1, clock.t], [E, 0, made.getTime()]]) {
    const header = await get(me, `/playlists/${id}`);
    assert.deepEqual([header.body.songCount, header.body.updatedAt], [songCount, iso(updatedAt)], 'GET /playlists/{id}');
  }
  const library = (await get(me, '/me/library/playlists')).body.data;
  assert.deepEqual(library.filter((e) => [A, C].includes(e.id)).map((e) => [e.id, e.songCount, e.updatedAt]).sort(),
    [[A, 3, iso(clock.t)], [C, 1, iso(clock.t)]].sort());
  const contentList = (await get(me, '/me/content?type=playlist')).body.data;
  assert.equal(contentList.find((c) => c.id === A).songCount, 3, 'the Profile\'s count is kept in step');

  const state = await get(me, `/me/library/songs/${x}`);
  assert.deepEqual([...state.body.playlistIds].sort(), [A, B, D].sort());
  const songsOfA = await get(me, `/playlists/${A}/songs`);
  assert.deepEqual(songsOfA.body.data.map((s) => s.id), [s1, s2, x], 'last in the playlist');
});

test('PUT .../playlists: the same set again changes nothing; repeats and the Liked songs id are ignored; [] takes it out of all', async () => {
  const { me, lists: { A, B, C, D }, songs: { x } } = await addFixture();
  clock.t += 60 * 1000;
  assertOk(await setPlaylists(me, x, [A, C]), 'SongPlaylists');
  const firstState = [await allItems(), await playlistStats([A, B, C, D])];
  clock.t += 60 * 1000;
  const again = await setPlaylists(me, x, [C, A.toUpperCase(), A, likedId(me), likedId(me).toUpperCase()]);
  assertOk(again, 'SongPlaylists');
  assert.deepEqual(again.body, { playlistIds: [C, A] });
  assert.deepEqual([await allItems(), await playlistStats([A, B, C, D])], firstState, 'nothing written');

  const none = await setPlaylists(me, x, []);
  assertOk(none, 'SongPlaylists');
  assert.deepEqual(none.body, { playlistIds: [] });
  assert.equal(await PlaylistItem.countDocuments({ songId: x }), 0);
  assert.deepEqual((await playlistStats([A, C])).map(([, n, at]) => [n, at]), [[2, clock.t], [1, clock.t]]);
  assert.equal(await SongLike.countDocuments(), 0, 'the Liked songs id never likes the song');
});

test('PUT .../playlists: every id is checked first; unknown ids are 404 PLAYLIST_NOT_FOUND before saved ones are 403 PLAYLIST_NOT_EDITABLE', async () => {
  const { me, artist, lists: { A, B }, songs: { x, s1 } } = await addFixture();
  const other = await account();
  const saved = await playlist(artist, { title: 'Saved' });
  const notSaved = await playlist(artist, { title: 'Not saved' });
  await save(me, saved, ago(10));
  const gone = oid();
  await save(me, gone, ago(10));
  const before = [await allItems(), await playlistStats([A, B])];

  const notFound = await setPlaylists(me, x, [A, gone, notSaved, s1, 'nope', likedId(other), saved, gone.toUpperCase()]);
  assertProblem(notFound, 404, 'PLAYLIST_NOT_FOUND');
  assert.deepEqual(notFound.body.meta, { playlistIds: [gone, notSaved, s1, 'nope', likedId(other)] }, 'each once, as sent');
  const notEditable = await setPlaylists(me, x, [A, saved.toUpperCase(), B]);
  assertProblem(notEditable, 403, 'PLAYLIST_NOT_EDITABLE');
  assert.deepEqual(notEditable.body.meta, { playlistIds: [saved.toUpperCase()] });
  assertProblem(await setPlaylists(other, x, [A]), 404, 'PLAYLIST_NOT_FOUND');
  for (const id of [oid(), 'nope', A]) assertProblem(await setPlaylists(me, id, [A]), 404, 'CONTENT_NOT_FOUND');
  assert.deepEqual([await allItems(), await playlistStats([A, B])], before, 'nothing is saved when the request fails');

  for (const body of [{}, { playlistIds: 'x' }, { playlistIds: [A], other: 1 }, { playlistIds: Array.from({ length: 501 }, oid) },
    { playlistIds: [''] }]) {
    assertProblem(await call(me, 'put', `/me/library/songs/${x}/playlists`, body), 422, 'VALIDATION_FAILED');
  }
  const broken = await request(app).put(`/v1/me/library/songs/${x}/playlists`).set(me.headers)
    .set('Content-Type', 'application/json').send('{"playlistIds": [');
  assertProblem(broken, 400, 'MALFORMED_REQUEST');
  assert.deepEqual([await allItems(), await playlistStats([A, B])], before);
});

test('PUT .../playlists: sets sent at once end as one of them, never a mix, and never a duplicate item', async () => {
  const { me, lists: { A, B, C, D }, songs: { x } } = await addFixture();
  const sets = [[A], [B, C], [], [D, A], [C], [A, B, C, D]];
  for (let round = 0; round < 3; round += 1) {
    clock.t += 1000;
    const answers = await Promise.all(sets.map((set) => setPlaylists(me, x, set)));
    for (const res of answers) assert.equal(res.status, 200, res.text);
    const holding = (await PlaylistItem.find({ songId: x }).lean()).map((item) => String(item.playlistId)).sort();
    assert.ok(sets.some((set) => JSON.stringify([...set].sort()) === JSON.stringify(holding)), `a mix: ${holding}`);
    for (const id of [A, B, C, D]) {
      const count = await PlaylistItem.countDocuments({ playlistId: id });
      assert.equal((await Content.findById(id).lean()).songCount, count, 'the stored count matches the items');
    }
  }
  const same = await Promise.all([1, 2, 3].map(() => setPlaylists(me, x, [D])));
  for (const res of same) assert.equal(res.status, 200);
  assert.equal(await PlaylistItem.countDocuments({ playlistId: D, songId: x }), 1);
  assert.equal(await LibraryLock.countDocuments(), 0, 'every lock is given back');
});

test('PUT .../playlists: all or nothing: a write that fails part-way is undone, and the lock is given back', async () => {
  const { me, lists: { A, B, C, D }, songs: { x } } = await addFixture();
  const before = [await allItems(), await playlistStats([A, B, C, D])];
  const failingItems = {
    ...itemsRepo,
    changeItems: async ({ add, remove }) => {
      await itemsRepo.changeItems({ add: add.slice(0, 1), remove: remove.slice(0, 1) });
      throw new Error('the database went away');
    },
  };
  const failingStats = {
    ...contentRepo,
    setPlaylistStats: async (stats) => {
      if (stats.some((s) => s.songsUpdatedAt && s.songsUpdatedAt.getTime() === clock.t)) {
        await contentRepo.setPlaylistStats(stats.slice(0, 1));
        throw new Error('the database went away');
      }
      return contentRepo.setPlaylistStats(stats);
    },
  };
  clock.t += 60 * 1000;
  for (const deps of [{ items: failingItems }, { contents: failingStats }]) {
    const target = buildApp(deps);
    assertProblem(await setPlaylists(me, x, [A, B, D], target), 500, 'INTERNAL_ERROR');
    assert.deepEqual([await allItems(), await playlistStats([A, B, C, D])], before);
    assert.equal(await LibraryLock.countDocuments(), 0);
  }
  assertOk(await setPlaylists(me, x, [A, B, D]), 'SongPlaylists');
  assert.equal(await PlaylistItem.countDocuments({ songId: x }), 3);
});

test('PUT .../playlists: a lock left behind is taken over once it expires; a held one is waited for; others\' locks do not block', async () => {
  const { me, lists: { A, B }, songs: { x, s3 } } = await addFixture();
  const other = await account();
  const otherList = await playlist(other);
  const slept = [];
  const advancing = (ms) => { slept.push(ms); clock.t += ms; return new Promise((resolve) => { setImmediate(resolve); }); };
  const target = buildApp({ sleep: advancing });
  // The TTL monitor removes expired locks by the real clock: with this test's clock an hour ahead of it, it never
  // removes a lock the test is waiting on, however slowly the waiting runs on a busy machine.
  clock.t += 60 * 60 * 1000;

  await LibraryLock.create({ _id: me.user._id, owner: 'crashed', expiresAt: ago(1) });
  await LibraryLock.create({ _id: other.user._id, owner: 'busy', expiresAt: new Date(clock.t + 60 * 60 * 1000) });
  assertOk(await setPlaylists(me, x, [A], target), 'SongPlaylists');
  assert.deepEqual(slept, [], 'an expired lock is taken over at once');
  assert.deepEqual((await LibraryLock.find().lean()).map((l) => l.owner), ['busy']);

  const start = clock.t;
  await LibraryLock.create({ _id: me.user._id, owner: 'slow', expiresAt: new Date(clock.t + LOCK_LEASE_MS) });
  assertOk(await setPlaylists(me, x, [B], target), 'SongPlaylists');
  assert.ok(clock.t - start >= LOCK_LEASE_MS && clock.t - start < LOCK_WAIT_MS, `waited ${clock.t - start} ms`);
  assert.deepEqual(await itemsOf(B), [[s3, 5], [x, 6]]);
  assert.equal(await PlaylistItem.countDocuments({ playlistId: A, songId: x }), 0);

  const never = buildApp({ sleep: advancing, library: { ...libraryRepo, acquireLock: async () => false } });
  const waitedFrom = clock.t;
  assertProblem(await setPlaylists(me, x, [], never), 500, 'INTERNAL_ERROR');
  assert.ok(clock.t - waitedFrom >= LOCK_WAIT_MS, 'it gives up only after waiting longer than a lease');
  assert.deepEqual(await itemsOf(B), [[s3, 5], [x, 6]], 'nothing written without the lock');

  await LibraryLock.deleteOne({ _id: other.user._id });
  slept.length = 0;
  assertOk(await setPlaylists(other, x, [otherList], target), 'SongPlaylists');
  assert.deepEqual(slept, [], 'each account has its own lock');
});

// ---------------------------------------------------------------------------
// Listens move playedAt
// ---------------------------------------------------------------------------

test('POST /me/listens: a playlist or Liked songs source marks that library entry played (newest, never back); others not', async () => {
  const { me, theo, ids: { P2, S1, P4, notSaved }, songs: [s1] } = await libraryFixture();
  const albumId = await add(theo, { type: 'album' });
  const event = (source, secondsAgo) => ({
    songId: s1, listenedMs: 1000, completed: false, endedAt: iso(clock.t - secondsAgo * 1000), source,
  });
  const send = (who, events) => call(who, 'post', '/me/listens', { events });
  const played = async () => Object.fromEntries((await get(me, '/me/library/playlists?limit=200')).body.data.map((e) => [e.id, e.playedAt]));
  const was = await played();

  assert.equal((await send(me, [
    event({ type: 'playlist', id: P2 }, 30), event({ type: 'playlist', id: P2.toUpperCase() }, 20),
    event({ type: 'playlist', id: S1 }, 40), event({ type: 'liked_songs' }, 10), event({ type: 'playlist', id: notSaved }, 5),
    event({ type: 'album', id: albumId }, 5), event({ type: 'song' }, 5), event({ type: 'playlist', id: P4 }, -120),
  ])).status, 202);
  const now = await played();
  assert.deepEqual(now, {
    ...was,
    [P2]: iso(clock.t - 20000),
    [S1]: iso(clock.t - 40000),
    [likedId(me)]: iso(clock.t - 10000),
    [P4]: iso(clock.t),
  }, 'a time ahead of the clock counts as now');
  const p2Row = await LibraryEntry.findOne({ userId: me.user._id, playlistId: P2 }).lean();
  assert.deepEqual([p2Row.kind, p2Row.savedAt.getTime()], ['playlist', ago(400).getTime()], 'an own playlist gets a row on its first play');
  assert.equal(await LibraryEntry.countDocuments({ playlistId: notSaved }), 0, 'someone else\'s playlist that is not saved');
  assert.equal(await LibraryEntry.countDocuments({ playlistId: albumId }), 0);

  assert.equal((await send(me, [event({ type: 'playlist', id: P2 }, 3600), event({ type: 'liked_songs' }, 3600)])).status, 202);
  assert.deepEqual(await played(), now, 'an older play never moves it back');

  const g = await guest();
  assert.equal((await send(g, [event({ type: 'playlist', id: P2 }, 1), event({ type: 'liked_songs' }, 1)])).status, 202);
  assert.deepEqual(await played(), now, 'a guest has no library');
  assert.equal(await LibraryEntry.countDocuments({ userId: { $ne: me.user._id } }), 0);
});

test('a library that cannot be marked still answers 202 for listens, which are counted', async () => {
  const me = await account();
  const artist = await account();
  const id = await song(artist, { listens: 0 });
  const target = buildApp({ library: { ...libraryRepo, markPlayed: async () => { throw new Error('the database went away'); } } });
  const res = await call(me, 'post', '/me/listens', {
    events: [{ songId: id, listenedMs: 40000, completed: false, endedAt: iso(clock.t - 1000), source: { type: 'liked_songs' } }],
  }, target);
  assert.equal(res.status, 202, res.text);
  assert.equal((await Content.findById(id).lean()).listens, 1);
});

// ---------------------------------------------------------------------------
// Rate limits, the spec, indexes
// ---------------------------------------------------------------------------

test('likes are limited to 60 a minute per account, each operation on its own', async () => {
  const target = buildApp();
  const me = await account();
  const artist = await account();
  const id = await song(artist);
  for (let i = 0; i < 60; i += 1) assert.equal((await likeSong(me, id, target)).status, 204, `request ${i + 1}`);
  const limited = await likeSong(me, id, target);
  assertProblem(limited, 429, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await likeSong(artist, id, target)).status, 204, 'another account has its own count');
  assert.equal((await setPlaylists(me, id, [], target)).status, 200, 'another operation has its own count');
});

test('the spec: the Library operations, their rate limits, and the codes they use', () => {
  const operations = {
    listLikedSongs: ['/me/liked-songs', 'get'],
    likeSong: ['/me/liked-songs/{songId}', 'put'],
    unlikeSong: ['/me/liked-songs/{songId}', 'delete'],
    listLibraryPlaylists: ['/me/library/playlists', 'get'],
    getSongLibraryState: ['/me/library/songs/{songId}', 'get'],
    setSongPlaylists: ['/me/library/songs/{songId}/playlists', 'put'],
  };
  assert.deepEqual(Object.keys(LIMITS).sort(), Object.keys(operations).sort());
  for (const [operationId, [route, method]] of Object.entries(operations)) {
    const operation = spec.paths[route][method];
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.tags, ['Library']);
    const [rule] = operation['x-rate-limit'];
    assert.deepEqual([rule.key, rule.limit, rule.window], ['account', LIMITS[operationId].points, '1m'], operationId);
    assert.equal(LIMITS[operationId].durationSeconds, 60);
  }
  for (const code of ['GUEST_NOT_ALLOWED', 'CONTENT_NOT_FOUND', 'CURSOR_INVALID', 'PLAYLIST_NOT_FOUND', 'PLAYLIST_NOT_EDITABLE']) {
    assert.ok(spec.components.schemas.ErrorCode.enum.includes(code), code);
  }
});

test('the indexes: a song liked once per account, Liked songs pages on their index, one library row per playlist', async () => {
  const keysOf = async (Model) => Object.fromEntries((await Model.collection.indexes()).map((ix) => [ix.name, ix]));
  const likes = await keysOf(SongLike);
  assert.deepEqual([likes.user_song.key, likes.user_song.unique], [{ userId: 1, songId: 1 }, true]);
  assert.deepEqual(likes.user_liked.key, { userId: 1, likedAt: -1, _id: -1 });
  const entries = await keysOf(LibraryEntry);
  assert.deepEqual([entries.user_playlist.key, entries.user_playlist.unique], [{ userId: 1, playlistId: 1 }, true]);
  const locks = await keysOf(LibraryLock);
  assert.deepEqual([locks.expires.key, locks.expires.expireAfterSeconds], [{ expiresAt: 1 }, 0]);

  const me = await account();
  const artist = await account();
  const id = await song(artist);
  await like(me, id, ago(1));
  await assert.rejects(like(me, id, ago(0)), (err) => err.code === 11000);
  const plan = await SongLike.find({ userId: me.user._id }).sort({ likedAt: -1, _id: -1 }).limit(3).explain();
  assert.match(JSON.stringify(plan.queryPlanner.winningPlan), /user_liked/);
  await LibraryEntry.create({ userId: me.user._id, kind: 'liked_songs', playlistId: null });
  await assert.rejects(LibraryEntry.create({ userId: me.user._id, kind: 'liked_songs' }), (err) => err.code === 11000);
});
