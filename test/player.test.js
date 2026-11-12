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
const { createPlayerService, CURSOR_TTL_MS, PLAYBACK_TTL_MS } = require('../src/modules/player/service');
const { createPlayerRouter, LIMITS } = require('../src/modules/player/routes');
const Content = require('../models/Content');
const PlaylistItem = require('../models/PlaylistItem');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bondfire-player-'));
const storage = createLocalStorage({ dir, publicUrl: config.media.publicUrl });
const clock = { t: Date.now(), now: () => clock.t };
const buildApp = () => createApp({
  trustProxy: 1,
  storage,
  playerRouter: createPlayerRouter({ player: createPlayerService({ storage, now: clock.now }) }),
});
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
  clock.t = Date.now();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
after(async () => {
  await db.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
const PALETTE = Object.freeze({ version: 1, seed: '#2F6FB0', accent: '#2F6FB0', neutral: false });
const BLURHASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';
const LEVELS = Array.from({ length: 128 }, (_, i) => Math.round(Math.abs(Math.sin(i / 9)) * 100) / 100);
const AVATAR = Object.freeze({
  path: 'avatars/a1b2/c3d4', width: 512, height: 512, variants: [{ width: 128, height: 128 }, { width: 512, height: 512 }],
  updatedAt: new Date('2026-11-01T10:00:00Z'), palette: { version: 1, seed: '#B0522F', accent: '#A84E2D', neutral: false },
  blurhash: 'L*J3}y{@OGOHspn~a}a}fQfQfQfQ',
});

/** Stored artwork, with its palette and BlurHash unless `look` is false. */
const art = (slug, look = true) => ({
  url: `https://cdn.example.com/c/${slug}/512.jpg`, width: 512, height: 512,
  ...(look ? { palette: { ...PALETTE }, blurhash: BLURHASH } : {}),
});
/** The spec's `Image` for `art(slug, look)`. */
const imageOf = (slug, look = true) => ({
  url: `https://cdn.example.com/c/${slug}/512.jpg`, width: 512, height: 512, status: 'ready',
  blurhash: look ? BLURHASH : null, palette: look ? { ...PALETTE } : null,
});
let files = 0;
/** A ready audio file record (the file itself is only written where a test reads it). */
const audio = (extra = {}) => ({
  key: `audio/s${(files += 1)}/f${files}.mp3`, mimeType: 'audio/mpeg', sizeBytes: 4096, durationMs: 187040,
  status: 'ready', uploadedAt: new Date(), ...extra,
});
const oid = (id) => new mongoose.Types.ObjectId(String(id));

async function artist(extra = {}) {
  return signIn(await makeUser({ password: HASH, emailVerified: true, name: 'Mara Quillon', ...extra }));
}

async function listener() {
  return signIn(await makeUser({ password: HASH, emailVerified: true }));
}

async function guest() {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(res.status, 201, res.text);
  return { guest: true, headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

/** One `contents` item of `owner` (a song with ready audio unless told otherwise). */
async function add(owner, fields = {}) {
  const doc = await Content.create({ ownerId: owner.user._id, type: 'song', title: 'Untitled', durationSec: 200, ...fields });
  return String(doc._id);
}
const song = (owner, fields = {}) => add(owner, { type: 'song', audio: audio(), ...fields });
const album = (owner, fields = {}) => add(owner, { type: 'album', songCount: 0, ...fields });
const playlist = (owner, fields = {}) => add(owner, { type: 'playlist', songCount: 0, ...fields });

/** Put songs in a playlist, in this order (positions 1, 2, ...), added a minute apart up to `lastAddedAt`. */
async function fill(playlistId, songIds, { lastAddedAt = new Date('2026-11-10T08:05:00Z'), from = 1 } = {}) {
  await PlaylistItem.insertMany(songIds.map((songId, i) => ({
    playlistId, songId, position: from + i, addedAt: new Date(lastAddedAt.getTime() - (songIds.length - 1 - i) * 60000),
  })));
}

const get = (who, url, target = app) => request(target).get(`/v1${url}`).set(who.headers);
const ids = (res) => res.body.data.map((s) => s.id);
const songsUrl = (list) => `/songs?ids=${list.join(',')}`;

/** A 200 the spec allows, with the player's private caching. */
function assertOk(res, schema) {
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec(schema, res.body);
  assert.equal(res.headers['cache-control'], schema === 'Playback' ? 'private, no-store' : 'private, no-cache');
}

// ---------------------------------------------------------------------------
// GET /songs/{songId}
// ---------------------------------------------------------------------------

test('GET /songs/{id}: everything the player shows, the same for an account, a guest and the artist', async () => {
  const mara = await artist({ avatar: AVATAR });
  const albumId = await album(mara, { title: 'Tallow Bay', image: art('tallow-bay'), year: 2026 });
  const id = await song(mara, {
    title: 'Kites Over Tallow Bay', albumId, trackNumber: 1, image: art('kites'), waveform: LEVELS,
    transcriptLanguages: ['en', 'es'], listens: 48210, commentCount: 549, audio: audio({ durationMs: 214380 }),
  });
  const expected = {
    id,
    title: 'Kites Over Tallow Bay',
    artist: { id: String(mara.user._id), name: 'Mara Quillon', image: toImage(AVATAR, (key) => storage.publicUrl(key)) },
    album: { id: albumId, title: 'Tallow Bay' },
    image: imageOf('tallow-bay'),
    durationMs: 214380,
    waveform: LEVELS,
    transcriptLanguages: ['en', 'es'],
    listens: 48210,
    commentCount: 549,
    latestComment: null,
    liked: false,
    followersOnly: false,
    playable: true,
  };
  assert.ok(expected.artist.image.palette && expected.artist.image.blurhash, 'the artist photo keeps its look');
  for (const who of [await listener(), await guest(), mara]) {
    const res = await get(who, `/songs/${id}`);
    assertOk(res, 'Song');
    assert.deepEqual(res.body, expected);
  }
  assert.deepEqual((await get(mara, `/songs/${id.toUpperCase()}`)).body, expected, 'an id in upper case is the same id');
});

test('artwork: the album\'s when the song is on one and it has artwork, else the song\'s own, else null', async () => {
  const mara = await artist();
  const withArt = await album(mara, { title: 'With Art', image: art('with') });
  const noArt = await album(mara, { title: 'No Art' });
  const s1 = await song(mara, { albumId: withArt, image: art('s1') });
  const s2 = await song(mara, { albumId: noArt, image: art('s2', false) });
  const s3 = await song(mara, { image: art('s3') });
  const s4 = await song(mara);
  const res = await get(mara, songsUrl([s1, s2, s3, s4]));
  assertOk(res, 'SongList');
  assert.deepEqual(res.body.data.map((s) => [s.album, s.image]), [
    [{ id: withArt, title: 'With Art' }, imageOf('with')],
    [{ id: noArt, title: 'No Art' }, imageOf('s2', false)],
    [null, imageOf('s3')],
    [null, null],
  ]);
});

test('a song is on an album only when albumId names an album of the same owner; otherwise it is a single', async () => {
  const mara = await artist();
  const theo = await artist({ name: 'Theo Brannick' });
  const theirs = await album(theo, { title: 'Not Hers', image: art('theirs') });
  const aSong = await song(mara, { title: 'A song' });
  const aPlaylist = await playlist(mara, { title: 'A playlist' });
  const gone = String(new mongoose.Types.ObjectId());
  const songs = [];
  for (const albumId of [theirs, aSong, aPlaylist, gone]) songs.push(await song(mara, { albumId, image: art('own') }));
  const res = await get(mara, songsUrl(songs));
  assertOk(res, 'SongList');
  assert.deepEqual(res.body.data.map((s) => [s.id, s.album, s.image]), songs.map((id) => [id, null, imageOf('own')]));
  const theirAlbum = await get(theo, `/albums/${theirs}`);
  assertOk(theirAlbum, 'Album');
  assert.deepEqual(theirAlbum.body.songs, [], 'her song is not on his album');
});

test('length, waveform and languages: from the ready audio, else durationSec; stored values in another shape read as defaults', async () => {
  const mara = await artist();
  const noAudio = await song(mara, { durationSec: 187, audio: undefined });
  const processing = await song(mara, { durationSec: 201, audio: audio({ status: 'processing', durationMs: 999 }) });
  const odd = await song(mara);
  await Content.collection.updateOne({ _id: oid(odd) }, {
    $set: {
      listens: -3, commentCount: 'many', waveform: [0.5, 2], transcriptLanguages: ['en', 'EN!', 7, 'en', 'pt-BR'],
      image: { url: 'ftp://cdn.example.com/x.jpg', width: 1, height: 1 }, durationSec: 201.5, audio: { key: 'audio/x/y.mp3', status: 'ready' },
    },
  });
  const res = await get(mara, songsUrl([noAudio, processing, odd]));
  assertOk(res, 'SongList');
  const [a, b, c] = res.body.data;
  assert.deepEqual([a.durationMs, a.waveform, a.transcriptLanguages, a.playable], [187000, null, [], false]);
  assert.deepEqual([b.durationMs, b.playable], [201000, false], 'a file still processing does not give the length');
  assert.deepEqual([c.listens, c.commentCount, c.waveform, c.transcriptLanguages, c.image, c.durationMs, c.playable],
    [0, 0, null, ['en', 'pt-BR'], null, 201500, false]);

  for (const [waveform, expected] of [[[], null], [Array(1025).fill(0.5), null], [[0, 1, 0.25], [0, 1, 0.25]], [['0.5'], null]]) {
    await Content.collection.updateOne({ _id: oid(odd) }, { $set: { waveform } });
    const one = await get(mara, `/songs/${odd}`);
    assertOk(one, 'Song');
    assert.deepEqual(one.body.waveform, expected, JSON.stringify(waveform).slice(0, 40));
  }
  await Content.collection.updateOne({ _id: oid(odd) }, {
    $set: { image: { url: 'https://cdn.example.com/x.jpg', width: 'wide', height: 512, palette: { version: 1, seed: 'red' }, blurhash: 'no' } },
  });
  const look = await get(mara, `/songs/${odd}`);
  assertOk(look, 'Song');
  assert.deepEqual(look.body.image, { url: 'https://cdn.example.com/x.jpg', width: 0, height: 512, status: 'ready', blurhash: null, palette: null });
});

test('the artist: a name the account does not have reads as \'\', an account that is gone also loses its photo', async () => {
  const nameless = await artist({ name: undefined, avatar: AVATAR });
  const id = await song(nameless);
  const res = await get(nameless, `/songs/${id}`);
  assertOk(res, 'Song');
  assert.deepEqual([res.body.artist.name, res.body.artist.image.url], ['', storage.publicUrl('avatars/a1b2/c3d4/512.jpg')]);
  await User.deleteOne({ _id: nameless.user._id });
  const g = await guest();
  const gone = await get(g, `/songs/${id}`);
  assertOk(gone, 'Song');
  assert.deepEqual(gone.body.artist, { id: String(nameless.user._id), name: '', image: null });
});

test('an unknown id, an id of another type and an id in no known format are 404 CONTENT_NOT_FOUND', async () => {
  const mara = await artist();
  const others = [await album(mara), await playlist(mara), await add(mara, { type: 'story' })];
  const g = await guest();
  for (const id of [String(new mongoose.Types.ObjectId()), ...others, 'not-an-id', 'x']) {
    for (const suffix of ['', '/playback', '/transcript']) {
      const res = await get(g, `/songs/${id}${suffix}`);
      assertProblem(res, 404, 'CONTENT_NOT_FOUND');
      assertMatchesSpec('Problem', res.body);
    }
  }
  assertProblem(await get(g, `/songs/${'a'.repeat(65)}`), 422, 'VALIDATION_FAILED');
});

test('hidden songs still answer: by id, in lists, on their album and in playlists', async () => {
  const mara = await artist();
  const albumId = await album(mara, { title: 'Album', hidden: true });
  const hidden = await song(mara, { title: 'Hidden', hidden: true, albumId, trackNumber: 1 });
  const listId = await playlist(mara, { hidden: true });
  await fill(listId, [hidden]);
  const g = await guest();
  assertOk(await get(g, `/songs/${hidden}`), 'Song');
  assert.deepEqual(ids(await get(g, songsUrl([hidden]))), [hidden]);
  assert.deepEqual((await get(g, `/albums/${albumId}`)).body.songs.map((s) => s.id), [hidden]);
  assert.equal((await get(g, `/playlists/${listId}`)).status, 200);
  assert.deepEqual(ids(await get(g, `/playlists/${listId}/songs`)), [hidden]);
  assert.equal((await get(g, `/songs/${hidden}/playback`)).status, 200);
});

// ---------------------------------------------------------------------------
// Followers-only and playback
// ---------------------------------------------------------------------------

test('followers-only (the song or its album): described to everyone, playable only by the artist', async () => {
  const mara = await artist();
  const restrictedAlbum = await album(mara, { title: 'Members', followersOnly: true });
  const own = await song(mara, { followersOnly: true });
  const onAlbum = await song(mara, { albumId: restrictedAlbum, trackNumber: 1 });
  const open = await song(mara);
  const other = await listener();
  const g = await guest();
  for (const [who, mayPlay] of [[mara, true], [other, false], [g, false]]) {
    const res = await get(who, songsUrl([own, onAlbum, open]));
    assertOk(res, 'SongList');
    assert.deepEqual(res.body.data.map((s) => [s.followersOnly, s.playable]), [[true, mayPlay], [true, mayPlay], [false, true]]);
    for (const id of [own, onAlbum]) {
      const playback = await get(who, `/songs/${id}/playback`);
      if (mayPlay) assertOk(playback, 'Playback');
      else {
        assertProblem(playback, 403, 'CONTENT_RESTRICTED');
        assertMatchesSpec('Problem', playback.body);
      }
    }
  }
  const albumRes = await get(g, `/albums/${restrictedAlbum}`);
  assertOk(albumRes, 'Album');
  assert.deepEqual(albumRes.body.songs.map((s) => [s.followersOnly, s.playable]), [[true, false]]);
});

test('no audio, audio still processing or failed, or an incomplete record: playable false and 409 AUDIO_UNAVAILABLE', async () => {
  const mara = await artist();
  const songs = [
    await song(mara, { audio: undefined }),
    await song(mara, { audio: audio({ status: 'processing' }) }),
    await song(mara, { audio: audio({ status: 'failed' }) }),
    await song(mara, { audio: audio({ sizeBytes: undefined }) }),
    await song(mara, { audio: audio({ mimeType: undefined }) }),
  ];
  const g = await guest();
  const res = await get(g, songsUrl(songs));
  assertOk(res, 'SongList');
  assert.ok(res.body.data.every((s) => s.playable === false));
  for (const id of songs) {
    const playback = await get(g, `/songs/${id}/playback`);
    assertProblem(playback, 409, 'AUDIO_UNAVAILABLE');
    assertMatchesSpec('Problem', playback.body);
  }
  // Restricted comes first: a viewer who may not play it is not told whether its audio is ready.
  const both = await song(mara, { followersOnly: true, audio: undefined });
  assertProblem(await get(g, `/songs/${both}/playback`), 403, 'CONTENT_RESTRICTED');
  assertProblem(await get(mara, `/songs/${both}/playback`), 409, 'AUDIO_UNAVAILABLE');
});

test('GET /songs/{id}/playback: the stored file\'s address for 6 hours, which answers Range requests with 206', async () => {
  const mara = await artist();
  const bytes = crypto.randomBytes(5000);
  const stored = audio({ key: 'audio/p1/take2.mp3', sizeBytes: bytes.length, durationMs: 31250 });
  await storage.put(stored.key, bytes);
  const id = await song(mara, { audio: stored, durationSec: 31 });
  const g = await guest();
  const res = await get(g, `/songs/${id}/playback`);
  assertOk(res, 'Playback');
  assert.deepEqual(res.body, {
    url: storage.publicUrl('audio/p1/take2.mp3'),
    expiresAt: iso(clock.t + PLAYBACK_TTL_MS),
    mimeType: 'audio/mpeg',
    sizeBytes: 5000,
    durationMs: 31250,
  });
  assert.equal(PLAYBACK_TTL_MS, 6 * 60 * 60 * 1000);
  assert.equal((await get(await listener(), `/songs/${id}/playback`)).status, 200);

  // The address works without a token and seeks.
  const filePath = new URL(res.body.url).pathname;
  const part = await request(app).get(filePath).set('Range', 'bytes=100-1099').buffer(true)
    .parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 100-1099/5000');
  assert.equal(part.headers['accept-ranges'], 'bytes');
  assert.match(part.headers['content-type'], /^audio\/mpeg/);
  assert.ok(Buffer.compare(part.body, bytes.subarray(100, 1100)) === 0);
  const whole = await request(app).get(filePath);
  assert.equal(whole.status, 200);
  assert.equal(Number(whole.headers['content-length']), 5000);
});

test('an audio key the storage cannot serve is AUDIO_UNAVAILABLE, not a server error', async () => {
  const mara = await artist();
  const id = await song(mara, { audio: audio({ key: '../outside.mp3' }) });
  assertProblem(await get(mara, `/songs/${id}/playback`), 409, 'AUDIO_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// GET /songs?ids=
// ---------------------------------------------------------------------------

test('GET /songs?ids=: the songs in the order asked; unknown ids and other types left out; a repeat answered once', async () => {
  const mara = await artist();
  const [a, b, c] = [await song(mara, { title: 'A' }), await song(mara, { title: 'B' }), await song(mara, { title: 'C' })];
  const albumId = await album(mara);
  const unknown = String(new mongoose.Types.ObjectId());
  const g = await guest();
  const res = await get(g, songsUrl([c, unknown, a, albumId, 'not-an-id', c, b.toUpperCase(), a]));
  assertOk(res, 'SongList');
  assert.deepEqual(ids(res), [c, a, b]);
  assert.deepEqual(res.body.data.map((s) => s.title), ['C', 'A', 'B']);
  const none = await get(g, songsUrl([unknown, albumId]));
  assertOk(none, 'SongList');
  assert.deepEqual(none.body, { data: [] });
  assert.deepEqual(ids(await get(g, songsUrl([b]))), [b], 'one id');
  assert.deepEqual(ids(await request(app).get(`/v1/songs?ids=${a}&ids=${b}`).set(g.headers)), [a, b], 'the exploded form too');
});

test('GET /songs: 1 to 50 ids, each a valid Id (validator)', async () => {
  const g = await guest();
  const many = Array.from({ length: 50 }, () => String(new mongoose.Types.ObjectId()));
  assertOk(await get(g, songsUrl(many)), 'SongList');
  for (const url of ['/songs', '/songs?ids=', songsUrl([...many, String(new mongoose.Types.ObjectId())]), songsUrl(['a'.repeat(65)]),
    `${songsUrl(many.slice(0, 1))}&limit=2`]) {
    assertProblem(await get(g, url), 422, 'VALIDATION_FAILED');
  }
});

// ---------------------------------------------------------------------------
// GET /albums/{albumId}
// ---------------------------------------------------------------------------

test('GET /albums/{id}: the album and its songs in track order, with their total length', async () => {
  const mara = await artist({ avatar: AVATAR });
  const albumId = await album(mara, { title: 'Tallow Bay', image: art('tallow-bay'), year: 2026, songCount: 9 });
  const third = await song(mara, { title: 'Third', albumId, trackNumber: 3, audio: audio({ durationMs: 100000 }) });
  const first = await song(mara, { title: 'First', albumId, trackNumber: 1, audio: audio({ durationMs: 187040 }) });
  const second = await song(mara, { title: 'Second', albumId, trackNumber: 2, audio: undefined, durationSec: 201 });
  const tieA = await song(mara, { title: 'Tie A', albumId, trackNumber: 4, audio: audio({ durationMs: 1000 }) });
  const tieB = await song(mara, { title: 'Tie B', albumId, trackNumber: 4, audio: audio({ durationMs: 1000 }) });
  await song(mara, { title: 'Single' });
  await add(mara, { type: 'story', title: 'A story on it', albumId, trackNumber: 1 });
  const theo = await artist({ name: 'Theo' });
  await song(theo, { title: 'His, pointing at her album', albumId, trackNumber: 1 });

  const g = await guest();
  const res = await get(g, `/albums/${albumId}`);
  assertOk(res, 'Album');
  const { songs, ...header } = res.body;
  assert.deepEqual(header, {
    id: albumId,
    title: 'Tallow Bay',
    artist: { id: String(mara.user._id), name: 'Mara Quillon', image: toImage(AVATAR, (key) => storage.publicUrl(key)) },
    image: imageOf('tallow-bay'),
    year: 2026,
    durationMs: 187040 + 201000 + 100000 + 1000 + 1000,
    songCount: 5,
  });
  assert.deepEqual(songs.map((s) => s.id), [first, second, third, ...[tieA, tieB].sort()]);
  for (const s of songs) {
    assert.deepEqual([s.album, s.image], [{ id: albumId, title: 'Tallow Bay' }, imageOf('tallow-bay')]);
    assert.equal(s.artist.name, 'Mara Quillon');
  }
  assert.deepEqual(songs.map((s) => s.playable), [true, false, true, true, true]);
});

test('an empty album, an album with no year or artwork; an id that is not an album is 404', async () => {
  const mara = await artist();
  const albumId = await album(mara, { title: 'Empty' });
  const res = await get(mara, `/albums/${albumId}`);
  assertOk(res, 'Album');
  assert.deepEqual([res.body.songs, res.body.songCount, res.body.durationMs, res.body.image, res.body.year], [[], 0, 0, null, null]);
  for (const id of [await song(mara), await playlist(mara), String(new mongoose.Types.ObjectId()), 'nope']) {
    assertProblem(await get(mara, `/albums/${id}`), 404, 'CONTENT_NOT_FOUND');
  }
});

// ---------------------------------------------------------------------------
// GET /playlists/{playlistId} and /songs
// ---------------------------------------------------------------------------

test('GET /playlists/{id}: owner, picture, size, length and when a song was last added', async () => {
  const amelia = await artist({ name: 'Amelia Jane' });
  const mara = await artist();
  const songs = [
    await song(mara, { audio: audio({ durationMs: 243900 }) }),
    await song(mara, { audio: undefined, durationSec: 100 }),
    await song(amelia, { audio: audio({ durationMs: 1100 }), followersOnly: true }),
  ];
  const listId = await playlist(amelia, { title: 'Rainy Commute', image: art('rainy') });
  await fill(listId, songs, { lastAddedAt: new Date('2026-11-10T08:05:00Z') });
  const g = await guest();
  const res = await get(g, `/playlists/${listId}`);
  assertOk(res, 'Playlist');
  assert.deepEqual(res.body, {
    id: listId,
    title: 'Rainy Commute',
    owner: { id: String(amelia.user._id), name: 'Amelia Jane', avatar: null },
    image: imageOf('rainy'),
    songCount: 3,
    durationMs: 243900 + 100000 + 1100,
    updatedAt: '2026-11-10T08:05:00Z',
  });

  // A song that no longer exists is not in the length, but its item still counts until it is removed.
  await Content.deleteOne({ _id: oid(songs[1]) });
  const after = (await get(g, `/playlists/${listId}`)).body;
  assert.deepEqual([after.songCount, after.durationMs], [3, 243900 + 1100]);
});

test('an empty playlist: no songs, updated when it was made; an owner with no name; not a playlist is 404', async () => {
  const nameless = await artist({ name: undefined });
  const listId = await playlist(nameless);
  const made = (await Content.findById(listId).lean()).createdAt;
  const res = await get(nameless, `/playlists/${listId}`);
  assertOk(res, 'Playlist');
  assert.deepEqual([res.body.songCount, res.body.durationMs, res.body.image, res.body.updatedAt, res.body.owner.name],
    [0, 0, null, iso(made), null]);
  const songsPage = await get(nameless, `/playlists/${listId}/songs`);
  assertOk(songsPage, 'SongPage');
  assert.deepEqual(songsPage.body, { data: [], page: { nextCursor: null, hasMore: false, total: 0 } });
  for (const id of [await song(nameless), await album(nameless), String(new mongoose.Types.ObjectId()), 'nope']) {
    assertProblem(await get(nameless, `/playlists/${id}`), 404, 'CONTENT_NOT_FOUND');
    assertProblem(await get(nameless, `/playlists/${id}/songs`), 404, 'CONTENT_NOT_FOUND');
  }
});

/** Every page of a playlist's songs, following `nextCursor`; checks each page against the spec and `total`. */
async function allPages(who, listId, limit, target = app) {
  const seen = [];
  let cursor;
  for (let n = 0; n < 50; n += 1) {
    const res = await get(who, `/playlists/${listId}/songs?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, target);
    assertOk(res, 'SongPage');
    seen.push(...ids(res));
    if (!res.body.page.hasMore) {
      assert.equal(res.body.page.nextCursor, null);
      return { seen, total: res.body.page.total };
    }
    assert.equal(res.body.data.length, limit);
    cursor = res.body.page.nextCursor;
  }
  throw new Error('too many pages');
}

test('GET /playlists/{id}/songs: playlist order (position, then item id), every song once at any page size', async () => {
  const mara = await artist();
  const songs = [];
  for (let i = 0; i < 7; i += 1) songs.push(await song(mara, { title: `S${i}`, hidden: i === 2, followersOnly: i === 3 }));
  const listId = await playlist(mara);
  // Positions 1..5, then two songs at the same position 9: the older item first.
  await fill(listId, songs.slice(0, 5));
  await fill(listId, songs.slice(5), { from: 9 });
  await PlaylistItem.updateOne({ playlistId: listId, songId: songs[6] }, { $set: { position: 9 } });
  const tie = (await PlaylistItem.find({ playlistId: listId, position: 9 }).sort({ _id: 1 }).lean()).map((r) => String(r.songId));
  const expected = [...songs.slice(0, 5), ...tie];
  const g = await guest();
  const first = await get(g, `/playlists/${listId}/songs`);
  assertOk(first, 'SongPage');
  assert.deepEqual(ids(first), expected);
  assert.deepEqual(first.body.page, { nextCursor: null, hasMore: false, total: 7 });
  assert.deepEqual(first.body.data.map((s) => [s.followersOnly, s.playable]).slice(2, 4), [[false, true], [true, false]]);
  const target = buildApp();
  for (const limit of [1, 2, 3, 7]) {
    assert.deepEqual(await allPages(g, listId, limit, target), { seen: expected, total: 7 }, `by ${limit}`);
  }
});

test('a page starts after the last item shown; a song that no longer exists is left out but still counted', async () => {
  const mara = await artist();
  const songs = [];
  for (let i = 0; i < 4; i += 1) songs.push(await song(mara, { title: `S${i}` }));
  const listId = await playlist(mara);
  await fill(listId, songs);
  const g = await guest();
  const first = await get(g, `/playlists/${listId}/songs?limit=2`);
  assert.deepEqual([ids(first), first.body.page.total, first.body.page.hasMore], [songs.slice(0, 2), 4, true]);
  await PlaylistItem.deleteOne({ playlistId: listId, songId: songs[0] });
  const late = await song(mara, { title: 'Late' });
  await fill(listId, [late], { from: 10 });
  await Content.deleteOne({ _id: oid(songs[3]) });
  const next = await get(g, `/playlists/${listId}/songs?limit=2&cursor=${first.body.page.nextCursor}`);
  assertOk(next, 'SongPage');
  assert.deepEqual(ids(next), [songs[2]], 'the gone song is left out of its page');
  assert.equal(next.body.page.total, 4);
  assert.equal(next.body.page.hasMore, true);
  const last = await get(g, `/playlists/${listId}/songs?limit=2&cursor=${next.body.page.nextCursor}`);
  assert.deepEqual([ids(last), last.body.page.hasMore], [[late], false]);
});

test('a playlist cursor works only for its playlist and for 24 hours; forged and malformed cursors are refused', async () => {
  const mara = await artist();
  const songs = [await song(mara), await song(mara), await song(mara)];
  const one = await playlist(mara);
  const two = await playlist(mara);
  await fill(one, songs);
  await fill(two, songs);
  const g = await guest();
  const { nextCursor } = (await get(g, `/playlists/${one}/songs?limit=1`)).body.page;
  assert.equal((await get(g, `/playlists/${one}/songs?limit=1&cursor=${nextCursor}`)).status, 200);
  assert.equal((await get(await listener(), `/playlists/${one}/songs?limit=2&cursor=${nextCursor}`)).status, 200,
    'another viewer and another page size may use it');
  const elsewhere = await get(g, `/playlists/${two}/songs?limit=1&cursor=${nextCursor}`);
  assertProblem(elsewhere, 422, 'CURSOR_INVALID');
  assertMatchesSpec('Problem', elsewhere.body);
  assert.equal(elsewhere.body.errors[0].field, 'cursor');

  clock.t += CURSOR_TTL_MS - 1000;
  assert.equal((await get(g, `/playlists/${one}/songs?limit=1&cursor=${nextCursor}`)).status, 200);
  clock.t += 2000;
  assertProblem(await get(g, `/playlists/${one}/songs?limit=1&cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  clock.t -= CURSOR_TTL_MS;

  const decoded = JSON.parse(Buffer.from(nextCursor, 'base64url').toString('utf8'));
  const forge = (change) => Buffer.from(JSON.stringify({ ...decoded, ...change })).toString('base64url');
  for (const cursor of ['not%20a%20cursor', 'bm90LWpzb24', forge({ i: 'nope' }), forge({ k: 'one' }), forge({ k: null }),
    forge({ f: 'other' }), forge({ t: Math.floor((clock.t + 60 * 60 * 1000) / 1000) }), forge({ t: 'now' }),
    Buffer.from('null').toString('base64url')]) {
    assertProblem(await get(g, `/playlists/${one}/songs?cursor=${cursor}`), 422, 'CURSOR_INVALID');
  }
  for (const query of ['limit=0', 'limit=51', 'limit=x', `cursor=${'a'.repeat(513)}`, 'other=1']) {
    assertProblem(await get(g, `/playlists/${one}/songs?${query}`), 422, 'VALIDATION_FAILED');
  }
});

// ---------------------------------------------------------------------------
// Auth, rate limits, the spec, indexes
// ---------------------------------------------------------------------------

test('every Player read needs a token (an account or a guest)', async () => {
  const id = String(new mongoose.Types.ObjectId());
  for (const url of [songsUrl([id]), `/songs/${id}`, `/songs/${id}/playback`, `/songs/${id}/transcript`, `/albums/${id}`,
    `/playlists/${id}`, `/playlists/${id}/songs`]) {
    const res = await request(app).get(`/v1${url}`).set(CLIENT);
    assertProblem(res, 401, 'UNAUTHENTICATED');
    assert.ok(res.headers['www-authenticate']);
  }
});

test('reads are limited to 120 a minute per account, each operation on its own; a guest counts as one', async () => {
  const target = buildApp();
  const mara = await artist();
  const id = await song(mara);
  const g = await guest();
  for (let i = 0; i < 120; i += 1) {
    const res = await get(g, `/songs/${id}`, target);
    assert.equal(res.status, 200, `request ${i + 1}: ${res.text}`);
  }
  const limited = await get(g, `/songs/${id}`, target);
  assertProblem(limited, 429, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await get(mara, `/songs/${id}`, target)).status, 200, 'another account has its own count');
  assert.equal((await get(g, `/songs/${id}/playback`, target)).status, 200, 'another operation has its own count');
});

test('the spec: the Player operations, their rate limits, and the codes they use', () => {
  const operations = {
    listSongs: ['/songs', 'get'],
    getSong: ['/songs/{songId}', 'get'],
    getSongPlayback: ['/songs/{songId}/playback', 'get'],
    getSongTranscript: ['/songs/{songId}/transcript', 'get'],
    getAlbum: ['/albums/{albumId}', 'get'],
    getPlaylist: ['/playlists/{playlistId}', 'get'],
    listPlaylistSongs: ['/playlists/{playlistId}/songs', 'get'],
    recordListens: ['/me/listens', 'post'],
  };
  assert.deepEqual(Object.keys(LIMITS).sort(), Object.keys(operations).sort());
  for (const [operationId, [route, method]] of Object.entries(operations)) {
    const operation = spec.paths[route][method];
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.tags, ['Player']);
    const [rule] = operation['x-rate-limit'];
    assert.deepEqual([rule.key, rule.limit, rule.window], ['account', LIMITS[operationId].points, '1m'], operationId);
    assert.equal(LIMITS[operationId].durationSeconds, 60);
  }
  for (const code of ['CONTENT_NOT_FOUND', 'CONTENT_RESTRICTED', 'AUDIO_UNAVAILABLE', 'TRANSCRIPT_NOT_FOUND', 'CURSOR_INVALID']) {
    assert.ok(spec.components.schemas.ErrorCode.enum.includes(code), code);
  }
});

test('the indexes: album order and playlist order serve their reads; a song is in a playlist at most once', async () => {
  const contentKeys = Object.fromEntries((await Content.collection.indexes()).map((ix) => [ix.name, ix]));
  assert.deepEqual(contentKeys.album_order.key, { albumId: 1, trackNumber: 1, _id: 1 });
  assert.deepEqual(contentKeys.album_order.partialFilterExpression, { albumId: { $exists: true } });
  const itemKeys = Object.fromEntries((await PlaylistItem.collection.indexes()).map((ix) => [ix.name, ix]));
  assert.deepEqual([itemKeys.playlist_song.key, itemKeys.playlist_song.unique], [{ playlistId: 1, songId: 1 }, true]);
  assert.deepEqual(itemKeys.playlist_order.key, { playlistId: 1, position: 1, _id: 1 });

  const mara = await artist();
  const albumId = await album(mara);
  const s = await song(mara, { albumId, trackNumber: 1 });
  const listId = await playlist(mara);
  await fill(listId, [s]);
  const albumPlan = await Content.find({ albumId, ownerId: mara.user._id, type: 'song' }).sort({ trackNumber: 1, _id: 1 }).explain();
  assert.match(JSON.stringify(albumPlan.queryPlanner.winningPlan), /album_order/);
  const listPlan = await PlaylistItem.find({ playlistId: listId }).sort({ position: 1, _id: 1 }).limit(3).explain();
  assert.match(JSON.stringify(listPlan.queryPlanner.winningPlan), /playlist_order/);
  await assert.rejects(PlaylistItem.create({ playlistId: listId, songId: s, position: 2, addedAt: new Date() }), (err) => err.code === 11000);
});
