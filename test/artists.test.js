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
const { toImage } = require('../src/modules/users/service');
const { createArtistService, MAX_RELEASES } = require('../src/modules/player/artists');
const { createArtistRouter, LIMITS } = require('../src/modules/player/artistRoutes');
const Content = require('../models/Content');
const Follow = require('../models/Follow');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bondfire-artists-'));
const storage = createLocalStorage({ dir, publicUrl: config.media.publicUrl });
const urlFor = (key) => storage.publicUrl(key);
// Whole seconds, so times written without milliseconds are exactly where the test puts them.
const clock = { t: Math.floor(Date.now() / 1000) * 1000, now: () => clock.t };
const artists = createArtistService({ storage, now: clock.now });
const buildApp = () => createApp({ trustProxy: 1, storage, artistsRouter: createArtistRouter({ artists }) });
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
const AVATAR = Object.freeze({
  path: 'avatars/a1b2/c3d4', width: 512, height: 512, variants: [{ width: 128, height: 128 }, { width: 512, height: 512 }],
  updatedAt: new Date('2026-11-01T10:00:00Z'), blurhash: 'L*J3}y{@OGOHspn~a}a}fQfQfQfQ',
  palette: { version: 1, seed: '#B0522F', accent: '#A84E2D', neutral: false },
});
const BANNER = Object.freeze({
  path: 'banners/e5f6/a7b8', width: 1572, height: 1056, variants: [{ width: 786, height: 528 }, { width: 1572, height: 1056 }],
  updatedAt: new Date('2026-11-01T10:00:00Z'),
});
const ALBUM_ART = Object.freeze({
  url: 'https://cdn.example.com/c/tallow-bay/512.jpg', width: 512, height: 512,
  palette: { version: 1, seed: '#2F6FB0', accent: '#2F6FB0', neutral: false }, blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
});
const SONG_ART = Object.freeze({ url: 'https://cdn.example.com/c/single/512.jpg', width: 640, height: 640 });
const ago = (days) => new Date(clock.t - days * 24 * 60 * 60 * 1000);

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

/** One `contents` item of `owner` (an account, or a bare user id), made at `createdAt` (default: the clock). */
async function add(owner, { createdAt = new Date(clock.t), ...fields } = {}) {
  const ownerId = owner.user ? owner.user._id : owner;
  const doc = new Content({ ownerId, type: 'song', title: 'Untitled', durationSec: 200, ...fields, createdAt, updatedAt: createdAt });
  await doc.save({ timestamps: false });
  return String(doc._id);
}
const song = (owner, fields = {}) => add(owner, { type: 'song', ...fields });
const album = (owner, fields = {}) => add(owner, { type: 'album', ...fields });

const call = (who, method, url, target = app) => request(target)[method](`/v1${url}`).set(who.headers);
const getArtist = (who, id, target = app) => call(who, 'get', `/artists/${id}`, target);
const followArtist = (who, id, target = app) => call(who, 'put', `/me/following/artists/${id}`, target);
const unfollowArtist = (who, id, target = app) => call(who, 'delete', `/me/following/artists/${id}`, target);
const idOf = (who) => String(who.user._id);

function assertOk(res) {
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Artist', res.body);
  assert.equal(res.headers['cache-control'], 'private, no-cache');
}

function assertNoContent(res) {
  assert.equal(res.status, 204, res.text);
  assert.equal(res.text, '');
}

// ---------------------------------------------------------------------------
// GET /artists/{artistId}
// ---------------------------------------------------------------------------

test('the page: profile, pictures, counts, and every release with its plays, song count and artwork', async () => {
  const mara = await account({ name: 'Mara Quillon', avatar: AVATAR, banner: BANNER });
  const tallow = await album(mara, { title: 'Tallow Bay', image: ALBUM_ART, createdAt: ago(30), listens: 999 });
  const kites = await song(mara, { title: 'Kites', albumId: tallow, trackNumber: 1, listens: 4000, image: SONG_ART, createdAt: ago(29) });
  const harbour = await song(mara, { title: 'Harbour', albumId: tallow, trackNumber: 2, listens: 250, createdAt: ago(28) });
  // Hidden from the Profile, but still on the album: counted in its songs and plays, left out of the releases.
  await song(mara, { title: 'Outtake', albumId: tallow, trackNumber: 3, listens: 50, hidden: true, createdAt: ago(27) });
  const single = await song(mara, { title: 'Northbound', listens: 913, image: SONG_ART, createdAt: ago(2) });
  const restricted = await song(mara, { title: 'For Followers', listens: 7, followersOnly: true, createdAt: ago(1) });
  // Not releases: a playlist, a story, a hidden album, and someone else's song.
  await add(mara, { type: 'playlist', title: 'Late Picks', songCount: 3 });
  await add(mara, { type: 'story', title: 'Night Bus' });
  await album(mara, { title: 'Hidden Album', hidden: true });
  await song(await account(), { title: 'Not Hers' });

  const res = await getArtist(await account(), idOf(mara));
  assertOk(res);
  assert.deepEqual(res.body, {
    id: idOf(mara),
    name: 'Mara Quillon',
    avatar: toImage(AVATAR, urlFor),
    banner: toImage(BANNER, urlFor),
    genre: null,
    followerCount: 0,
    followingCount: 0,
    following: false,
    releases: [
      { id: restricted, kind: 'song', title: 'For Followers', releasedAt: iso(ago(1)), plays: 7, songCount: null, image: null },
      {
        id: single, kind: 'song', title: 'Northbound', releasedAt: iso(ago(2)), plays: 913, songCount: null,
        image: { url: SONG_ART.url, width: 640, height: 640, status: 'ready', blurhash: null, palette: null },
      },
      {
        id: harbour, kind: 'song', title: 'Harbour', releasedAt: iso(ago(28)), plays: 250, songCount: null,
        image: { url: ALBUM_ART.url, width: 512, height: 512, status: 'ready', blurhash: ALBUM_ART.blurhash, palette: ALBUM_ART.palette },
      },
      {
        id: kites, kind: 'song', title: 'Kites', releasedAt: iso(ago(29)), plays: 4000, songCount: null,
        image: { url: ALBUM_ART.url, width: 512, height: 512, status: 'ready', blurhash: ALBUM_ART.blurhash, palette: ALBUM_ART.palette },
      },
      {
        id: tallow, kind: 'album', title: 'Tallow Bay', releasedAt: iso(ago(30)), plays: 4300, songCount: 3,
        image: { url: ALBUM_ART.url, width: 512, height: 512, status: 'ready', blurhash: ALBUM_ART.blurhash, palette: ALBUM_ART.palette },
      },
    ],
  });
});

test('releases: newest first, the newer id first at the same time, an empty album, and at most 200', async () => {
  const mara = await account({ name: 'Mara' });
  const at = ago(3);
  const first = await song(mara, { title: 'A', createdAt: at });
  const second = await song(mara, { title: 'B', createdAt: at });
  const empty = await album(mara, { title: 'Coming Soon', createdAt: ago(5) });
  // Another artist's song pointing at her album is not one of its songs.
  await song(await account(), { title: 'Elsewhere', albumId: empty, listens: 10 });
  let res = await getArtist(await account(), idOf(mara));
  assertOk(res);
  assert.deepEqual(res.body.releases.map((r) => r.id), [second, first, empty]);
  assert.deepEqual([res.body.releases[2].songCount, res.body.releases[2].plays, res.body.releases[2].image], [0, 0, null]);

  await Content.deleteMany({});
  const docs = Array.from({ length: MAX_RELEASES + 5 }, (_, i) => ({
    ownerId: mara.user._id, type: 'song', title: `Song ${i}`, titleLower: `song ${i}`, createdAt: ago(1000 - i), updatedAt: ago(1000 - i),
  }));
  await Content.collection.insertMany(docs);
  res = await getArtist(await account(), idOf(mara));
  assertOk(res);
  assert.equal(MAX_RELEASES, 200);
  assert.equal(res.body.releases.length, MAX_RELEASES);
  assert.equal(res.body.releases[0].title, `Song ${MAX_RELEASES + 4}`, 'the newest ones are kept');
});

test('an account with no name reads as an empty name, with no pictures', async () => {
  const nameless = await account();
  await song(nameless);
  const res = await getArtist(await account(), idOf(nameless));
  assertOk(res);
  assert.deepEqual([res.body.name, res.body.avatar, res.body.banner], ['', null, null]);
});

test('404 NOT_FOUND: unknown id, id in no known format, an account with no song, a song whose account is gone', async () => {
  const me = await account();
  const listener = await account();
  await album(listener, { title: 'Only an album' });
  await add(listener, { type: 'playlist', title: 'Only a playlist' });
  const orphanOwner = new mongoose.Types.ObjectId();
  await song(orphanOwner, { title: 'Orphan' });
  for (const id of [String(new mongoose.Types.ObjectId()), 'not-an-id', idOf(listener), String(orphanOwner)]) {
    assertProblem(await getArtist(me, id), 404, 'NOT_FOUND');
  }
});

test('an artist whose only song is hidden is still an artist, with no releases', async () => {
  const mara = await account({ name: 'Mara' });
  await song(mara, { hidden: true });
  const res = await getArtist(await account(), idOf(mara));
  assertOk(res);
  assert.deepEqual(res.body.releases, []);
  assertNoContent(await followArtist(await account(), idOf(mara)));
});

test('guests can read a page (never following); no token is 401', async () => {
  const mara = await account({ name: 'Mara' });
  await song(mara);
  const fan = await account();
  assertNoContent(await followArtist(fan, idOf(mara)));
  const res = await getArtist(await guest(), idOf(mara));
  assertOk(res);
  assert.deepEqual([res.body.following, res.body.followerCount], [false, 1]);
  assertProblem(await request(app).get(`/v1/artists/${idOf(mara)}`).set(CLIENT), 401, 'UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// Following
// ---------------------------------------------------------------------------

test('follow and unfollow are idempotent, and the counts and the flag follow', async () => {
  const mara = await account({ name: 'Mara' });
  await song(mara);
  const juno = await account({ name: 'Juno' });
  await song(juno);
  const fan = await account();
  const other = await account();

  assertNoContent(await followArtist(fan, idOf(mara)));
  const first = await Follow.findOne({ followerId: fan.user._id }).lean();
  assert.equal(first.followedAt.getTime(), clock.t);
  clock.t += 60 * 1000;
  assertNoContent(await followArtist(fan, idOf(mara).toUpperCase()));
  assert.equal(await Follow.countDocuments({}), 1, 'following twice keeps one row');
  assert.equal((await Follow.findOne({ followerId: fan.user._id }).lean()).followedAt.getTime(), first.followedAt.getTime());

  let res = await getArtist(fan, idOf(mara));
  assertOk(res);
  assert.deepEqual([res.body.following, res.body.followerCount, res.body.followingCount], [true, 1, 0]);
  res = await getArtist(other, idOf(mara));
  assert.deepEqual([res.body.following, res.body.followerCount], [false, 1], '`following` is the viewer\'s');

  // An artist following another: her followingCount, his followerCount.
  assertNoContent(await followArtist(mara, idOf(juno)));
  assertNoContent(await followArtist(other, idOf(juno)));
  res = await getArtist(fan, idOf(mara));
  assert.deepEqual([res.body.followerCount, res.body.followingCount], [1, 1]);
  res = await getArtist(fan, idOf(juno));
  assert.deepEqual([res.body.following, res.body.followerCount, res.body.followingCount], [false, 2, 0]);

  assertNoContent(await unfollowArtist(fan, idOf(mara)));
  assertNoContent(await unfollowArtist(fan, idOf(mara)));
  res = await getArtist(fan, idOf(mara));
  assert.deepEqual([res.body.following, res.body.followerCount], [false, 0]);
  assert.equal(await Follow.countDocuments({ artistId: juno.user._id }), 2, 'other follows are left alone');
});

test('unfollow never 404s: unknown artist, malformed id, an account that is no longer an artist', async () => {
  const mara = await account();
  const songId = await song(mara);
  const fan = await account();
  assertNoContent(await followArtist(fan, idOf(mara)));
  await Content.deleteOne({ _id: songId });
  assertProblem(await getArtist(fan, idOf(mara)), 404, 'NOT_FOUND');
  assertProblem(await followArtist(fan, idOf(mara)), 404, 'NOT_FOUND');
  assertNoContent(await unfollowArtist(fan, idOf(mara)));
  assert.equal(await Follow.countDocuments({}), 0, 'a follower can still stop following');
  assertNoContent(await unfollowArtist(fan, String(new mongoose.Types.ObjectId())));
  assertNoContent(await unfollowArtist(fan, 'not-an-id'));
  assertNoContent(await unfollowArtist(fan, idOf(fan)));
});

test('follow: 404 NOT_FOUND for an unknown artist or an account that has published no song; nothing stored', async () => {
  const fan = await account();
  const listener = await account();
  await album(listener);
  for (const id of [String(new mongoose.Types.ObjectId()), 'not-an-id', idOf(listener)]) {
    assertProblem(await followArtist(fan, id), 404, 'NOT_FOUND');
  }
  assert.equal(await Follow.countDocuments({}), 0);
});

test('nobody can follow themselves: 422 CANNOT_FOLLOW_SELF, in any case, artist or not; nothing stored', async () => {
  const mara = await account();
  await song(mara);
  for (const id of [idOf(mara), idOf(mara).toUpperCase()]) {
    const res = await followArtist(mara, id);
    assertProblem(res, 422, 'CANNOT_FOLLOW_SELF');
    assertMatchesSpec('Problem', res.body);
    assert.deepEqual(res.body.errors.map((e) => e.code), ['CANNOT_FOLLOW_SELF']);
  }
  const listener = await account();
  assertProblem(await followArtist(listener, idOf(listener)), 422, 'CANNOT_FOLLOW_SELF');
  assert.equal(await Follow.countDocuments({}), 0);
  const res = await getArtist(mara, idOf(mara));
  assertOk(res);
  assert.equal(res.body.following, false, 'an artist does not follow themselves');
});

test('following is for accounts: a guest gets 403 GUEST_NOT_ALLOWED, no token 401', async () => {
  const mara = await account();
  await song(mara);
  const g = await guest();
  assertProblem(await followArtist(g, idOf(mara)), 403, 'GUEST_NOT_ALLOWED');
  assertProblem(await unfollowArtist(g, idOf(mara)), 403, 'GUEST_NOT_ALLOWED');
  for (const method of ['put', 'delete']) {
    assertProblem(await request(app)[method](`/v1/me/following/artists/${idOf(mara)}`).set(CLIENT), 401, 'UNAUTHENTICATED');
  }
  assert.equal(await Follow.countDocuments({}), 0);
});

test('follows sent at the same moment store one row', async () => {
  const mara = await account();
  await song(mara);
  const fan = await account();
  const answers = await Promise.all(Array.from({ length: 5 }, () => followArtist(fan, idOf(mara))));
  for (const res of answers) assertNoContent(res);
  assert.equal(await Follow.countDocuments({}), 1);
});

// ---------------------------------------------------------------------------
// Rate limits, the spec, indexes
// ---------------------------------------------------------------------------

test('follows are limited to 60 a minute per account, each operation on its own', async () => {
  const target = buildApp();
  const mara = await account();
  await song(mara);
  const fan = await account();
  for (let i = 0; i < 60; i += 1) assert.equal((await followArtist(fan, idOf(mara), target)).status, 204, `request ${i + 1}`);
  const limited = await followArtist(fan, idOf(mara), target);
  assertProblem(limited, 429, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await followArtist(await account(), idOf(mara), target)).status, 204, 'another account has its own count');
  assert.equal((await unfollowArtist(fan, idOf(mara), target)).status, 204, 'another operation has its own count');
  assert.equal((await getArtist(fan, idOf(mara), target)).status, 200);
});

test('the spec: the Artists operations, their rate limits, and the codes they use', () => {
  const operations = {
    getArtist: ['/artists/{artistId}', 'get'],
    followArtist: ['/me/following/artists/{artistId}', 'put'],
    unfollowArtist: ['/me/following/artists/{artistId}', 'delete'],
  };
  assert.deepEqual(Object.keys(LIMITS).sort(), Object.keys(operations).sort());
  for (const [operationId, [route, method]] of Object.entries(operations)) {
    const operation = spec.paths[route][method];
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.tags, ['Artists']);
    const [rule] = operation['x-rate-limit'];
    assert.deepEqual([rule.key, rule.limit, rule.window], ['account', LIMITS[operationId].points, '1m'], operationId);
    assert.equal(LIMITS[operationId].durationSeconds, 60);
    const names = operation.parameters.map((p) => (p.$ref ? spec.components.parameters[p.$ref.split('/').pop()] : p).name);
    assert.ok(names.includes('artistId'), operationId);
    assert.equal(names.includes('Idempotency-Key'), false, 'no Idempotency-Key, as the heart');
  }
  for (const code of ['NOT_FOUND', 'GUEST_NOT_ALLOWED', 'CANNOT_FOLLOW_SELF']) {
    assert.ok(spec.components.schemas.ErrorCode.enum.includes(code), code);
  }
  assert.equal(spec.components.schemas.Artist.properties.releases.maxItems, MAX_RELEASES);
});

test('the indexes: an artist once per follower, follower counts on their own index', async () => {
  const keysOf = async (Model) => Object.fromEntries((await Model.collection.indexes()).map((ix) => [ix.name, ix]));
  const follows = await keysOf(Follow);
  assert.deepEqual([follows.follower_artist.key, follows.follower_artist.unique], [{ followerId: 1, artistId: 1 }, true]);
  assert.deepEqual(follows.artist_followers.key, { artistId: 1, followedAt: -1, _id: -1 });
  const fan = new mongoose.Types.ObjectId();
  const artist = new mongoose.Types.ObjectId();
  await Follow.create({ followerId: fan, artistId: artist, followedAt: new Date() });
  await assert.rejects(Follow.create({ followerId: fan, artistId: artist, followedAt: new Date() }), (err) => err.code === 11000);
  const plan = await Follow.find({ artistId: artist }).explain();
  assert.match(JSON.stringify(plan.queryPlanner.winningPlan), /artist_followers/);
});
