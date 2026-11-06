process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const sharp = require('sharp');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { createApp } = require('../src/app');
const { config, loadConfig } = require('../src/config');
const { createLocalStorage } = require('../src/providers/storage/local');
const { createMediaService } = require('../src/modules/media/service');
const { createMediaRouter } = require('../src/modules/media/routes');
const usersRepo = require('../src/modules/users/repo');
const { toImage } = require('../src/modules/users/service');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bondfire-media-'));
const storage = createLocalStorage({ dir, publicUrl: config.media.publicUrl });
const buildApp = (service = createMediaService({ storage })) => createApp({
  trustProxy: 1, storage, mediaRouter: createMediaRouter({ service }),
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
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
after(async () => {
  await db.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function account() {
  const user = await makeUser({ password: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', emailVerified: true });
  return signIn(user);
}

/** A JPEG of the given size with EXIF (camera and GPS) that must not survive processing. */
function photo(width, height, background = '#3366cc') {
  return sharp({ create: { width, height, channels: 3, background } })
    .withExif({ IFD0: { Make: 'TestCam' }, GPS: { GPSLatitudeRef: 'N', GPSLatitude: '12/1 0/1 0/1' } })
    .jpeg().toBuffer();
}
const FULL = JSON.stringify({ x: 0, y: 0, width: 1, height: 1 });

const put = (who, kind, file, crop = FULL, extra = {}) => {
  const req = request(app).put(`/v1/me/${kind}`).set({ ...who.headers, ...extra });
  if (file) req.attach('file', file, { filename: 'photo.jpg', contentType: 'image/jpeg' });
  if (crop !== null) req.field('crop', crop);
  return req;
};
const fileOf = (url) => path.join(dir, ...url.slice(config.media.publicUrl.length + 1).split('/'));
const foldersOf = (userId, kind) => {
  const base = path.join(dir, `${kind}s`, String(userId));
  return fs.existsSync(base) ? fs.readdirSync(base) : [];
};

// ---------------------------------------------------------------------------
// PUT /me/avatar, PUT /me/banner

test('PUT /me/avatar stores the sizes, returns a ready Image and shows it on GET /me', async () => {
  const who = await account();
  const res = await put(who, 'avatar', await photo(700, 700));
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Image', res.body);
  assert.equal(res.body.status, 'ready');
  assert.deepEqual([res.body.width, res.body.height], [512, 512]);
  assert.deepEqual(Object.keys(res.body.variants), ['128', '256', '512']);
  assert.ok(res.body.url.startsWith(`${config.media.publicUrl}/avatars/${who.user._id}/`));

  for (const url of Object.values(res.body.variants)) assert.ok(fs.existsSync(fileOf(url)), url);
  const stored = await sharp(fs.readFileSync(fileOf(res.body.url))).metadata();
  assert.equal(stored.format, 'jpeg');
  assert.equal(stored.exif, undefined, 'EXIF (camera, GPS) is removed');

  const me = await request(app).get('/v1/me').set(who.headers);
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.avatar, res.body);
  assert.equal(me.body.banner, null);
});

test('the crop is taken from the photo as shown: EXIF orientation applied first', async () => {
  const who = await account();
  // Stored 800x400, left half red and right half blue, with orientation 6 (turn a quarter clockwise): shown
  // 400x800 with red on top and blue below. The bottom half is blue only when the turn is applied first.
  const half = (background) => sharp({ create: { width: 400, height: 400, channels: 3, background } }).png().toBuffer();
  const turned = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#000000' } })
    .composite([{ input: await half('#ff0000'), left: 0, top: 0 }, { input: await half('#0000ff'), left: 400, top: 0 }])
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const res = await put(who, 'avatar', turned, JSON.stringify({ x: 0, y: 0.5, width: 1, height: 0.5 }));
  assert.equal(res.status, 200, res.text);
  const { dominant } = await sharp(fs.readFileSync(fileOf(res.body.url))).stats();
  assert.ok(dominant.b > 200 && dominant.r < 60, `expected the blue bottom half, got ${JSON.stringify(dominant)}`);
});

test('the stored files are served at /media with a long cache', async () => {
  const who = await account();
  const { body } = await put(who, 'avatar', await photo(300, 300));
  const res = await request(app).get(new URL(body.url).pathname);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^image\/jpeg/);
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal((await request(app).get('/media/avatars/nothing/here/1.jpg')).status, 404);
});

test('PUT /me/banner makes the banner sizes at 393:264', async () => {
  const who = await account();
  const res = await put(who, 'banner', await photo(1600, 1200), JSON.stringify({ x: 0, y: 0.0625, width: 1, height: 0.8956 }));
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Image', res.body);
  assert.deepEqual([res.body.width, res.body.height], [1179, 792]);
  assert.deepEqual(Object.keys(res.body.variants), ['786', '1179', '1572']);
  const me = await request(app).get('/v1/me').set(who.headers);
  assert.deepEqual(me.body.banner, res.body);
});

test('a new photo replaces the old one and deletes its files', async () => {
  const who = await account();
  const first = await put(who, 'avatar', await photo(400, 400));
  const second = await put(who, 'avatar', await photo(400, 400, '#cc3333'));
  assert.equal(second.status, 200);
  assert.notEqual(first.body.url, second.body.url);
  assert.equal(fs.existsSync(fileOf(first.body.url)), false);
  assert.equal(fs.existsSync(fileOf(second.body.url)), true);
  assert.equal(foldersOf(who.user._id, 'avatar').length, 1);
});

test('DELETE /me/avatar removes the photo and its files, and is idempotent', async () => {
  const who = await account();
  const { body } = await put(who, 'avatar', await photo(400, 400));
  const res = await request(app).delete('/v1/me/avatar').set(who.headers);
  assert.equal(res.status, 204);
  assert.equal(fs.existsSync(fileOf(body.url)), false);
  assert.equal((await request(app).get('/v1/me').set(who.headers)).body.avatar, null);
  assert.equal((await request(app).delete('/v1/me/avatar').set(who.headers)).status, 204);
  assert.equal((await request(app).delete('/v1/me/banner').set(who.headers)).status, 204);
});

// ---------------------------------------------------------------------------
// Refusals

test('guests and signed-out callers cannot set photos', async () => {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const guest = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(guest.status, 201, guest.text);
  const asGuest = { headers: { ...headers, Authorization: `Bearer ${guest.body.tokens.accessToken}` } };
  assertProblem(await put(asGuest, 'avatar', await photo(300, 300)), 403, 'GUEST_NOT_ALLOWED');
  assertProblem(await request(app).delete('/v1/me/banner').set(asGuest.headers), 403, 'GUEST_NOT_ALLOWED');
  assert.equal((await put({ headers: CLIENT }, 'avatar', await photo(300, 300))).status, 401);
});

test('bad crops, small photos and files that are not photos are refused, and nothing is stored', async () => {
  const who = await account();
  assertProblem(await put(who, 'avatar', await photo(800, 400)), 422, 'CROP_INVALID');
  assertProblem(await put(who, 'avatar', await photo(400, 400), JSON.stringify({ x: 0.5, y: 0, width: 0.6, height: 0.6 })), 422, 'CROP_INVALID');
  assertProblem(await put(who, 'avatar', await photo(400, 400), 'not json'), 422, 'CROP_INVALID');
  assertProblem(await put(who, 'avatar', await photo(150, 150)), 422, 'IMAGE_TOO_SMALL');
  assertProblem(await put(who, 'banner', await photo(700, 470)), 422, 'IMAGE_TOO_SMALL');
  assertProblem(await put(who, 'avatar', Buffer.from('definitely not a photo')), 422, 'IMAGE_UNREADABLE');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"/>');
  assertProblem(await put(who, 'avatar', svg), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(foldersOf(who.user._id, 'avatar').length, 0);
  assert.equal((await User.findById(who.user._id).lean()).avatar, undefined);
});

test('a request without the file or the crop is refused by the spec check', async () => {
  const who = await account();
  const noFile = await put(who, 'avatar', null);
  assert.ok(noFile.status === 400 || noFile.status === 422, noFile.text);
  const noCrop = await put(who, 'avatar', await photo(300, 300), null);
  assert.ok(noCrop.status === 400 || noCrop.status === 422, noCrop.text);
});

test('a file over 10 MB is 413 PAYLOAD_TOO_LARGE', async () => {
  const who = await account();
  const res = await put(who, 'avatar', Buffer.alloc(10 * 1024 * 1024 + 1, 1));
  assertProblem(res, 413, 'PAYLOAD_TOO_LARGE');
});

test('an uploadId (two-step upload, not offered yet) is UPLOAD_NOT_FOUND', async () => {
  const who = await account();
  const res = await request(app).put('/v1/me/avatar').set(who.headers)
    .send({ uploadId: '6ab00fb4d7a4aaa7e623288e', crop: { x: 0, y: 0, width: 1, height: 1 } });
  assertProblem(res, 404, 'UPLOAD_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Retries and failures

test('a retry with the same Idempotency-Key replays; a different photo with that key is refused', async () => {
  const who = await account();
  const key = crypto.randomUUID();
  const file = await photo(400, 400);
  const first = await put(who, 'avatar', file, FULL, { 'Idempotency-Key': key });
  const again = await put(who, 'avatar', file, FULL, { 'Idempotency-Key': key });
  assert.equal(again.status, 200);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.deepEqual(again.body, first.body);
  assert.equal(foldersOf(who.user._id, 'avatar').length, 1);
  const other = await put(who, 'avatar', await photo(400, 400, '#00ff00'), FULL, { 'Idempotency-Key': key });
  assertProblem(other, 422, 'IDEMPOTENCY_KEY_REUSED');
});

test('when storage fails, the account keeps its photo and no files are left', async () => {
  const who = await account();
  const { body: kept } = await put(who, 'avatar', await photo(400, 400));
  let puts = 0;
  const failing = { ...storage, async put(key, data) { puts += 1; if (puts === 2) throw new Error('disk full'); return storage.put(key, data); } };
  const broken = buildApp(createMediaService({ storage: failing }));
  const res = await request(broken).put('/v1/me/avatar').set(who.headers)
    .attach('file', await photo(400, 400, '#ff0000'), { filename: 'p.jpg', contentType: 'image/jpeg' }).field('crop', FULL);
  assert.equal(res.status, 500);
  assert.equal(foldersOf(who.user._id, 'avatar').length, 1, 'the half-written upload is removed');
  const me = await request(app).get('/v1/me').set(who.headers);
  assert.deepEqual(me.body.avatar, kept);
});

test('an account deleted meanwhile gets SESSION_REVOKED and its upload is removed', async () => {
  const who = await account();
  const gone = { ...usersRepo, async setImage() { return { found: false, previous: null }; } };
  const res = await request(buildApp(createMediaService({ storage, users: gone }))).put('/v1/me/avatar').set(who.headers)
    .attach('file', await photo(300, 300), { filename: 'p.jpg', contentType: 'image/jpeg' }).field('crop', FULL);
  assertProblem(res, 401, 'SESSION_REVOKED');
  assert.equal(foldersOf(who.user._id, 'avatar').length, 0);
});

// ---------------------------------------------------------------------------
// Storage and config

test('local storage refuses keys that could leave its folder', async () => {
  for (const key of ['../x.jpg', 'avatars/../../x', '/etc/passwd', 'a\\b', 'A/b.jpg', '', 'a//b']) {
    await assert.rejects(() => storage.put(key, Buffer.from('x')), /Unsafe storage key/, key);
  }
  assert.throws(() => storage.publicUrl('../x'), /Unsafe storage key/);
});

test('media config: local only, and the public address must be http(s)', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).media.storage, 'local');
  assert.equal(loadConfig({ NODE_ENV: 'test', MEDIA_PUBLIC_URL: 'https://x.example/media/' }).media.publicUrl, 'https://x.example/media');
  assert.equal(loadConfig({ NODE_ENV: 'test', API_BASE_URL: 'https://api.example' }).media.publicUrl, 'https://api.example/media');
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MEDIA_STORAGE: 's3' }), /MEDIA_STORAGE/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MEDIA_PUBLIC_URL: 'ftp://x' }), /MEDIA_PUBLIC_URL/);
});

// ---------------------------------------------------------------------------
// Palette and blur preview (colour rules v1, src/lib/palette.js)

const FIXTURES = path.join(__dirname, 'fixtures', 'palette');
const expectedLook = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8')).files;

test('PUT /me/banner works out the palette and blurhash of the crop as shown, stores them, and GET /me shows them', async () => {
  const who = await account();
  // 786x528 is exactly 393:264, so the full crop is the picture itself: the upload must agree with expected.json.
  for (const file of ['red_blue.png', 'transparent.png']) {
    const res = await request(app).put('/v1/me/banner').set(who.headers)
      .attach('file', fs.readFileSync(path.join(FIXTURES, file)), { filename: file, contentType: 'image/png' })
      .field('crop', FULL);
    assert.equal(res.status, 200, res.text);
    assertMatchesSpec('Image', res.body);
    assert.deepEqual(res.body.palette, expectedLook[file].palette, file);
    assert.equal(res.body.blurhash, expectedLook[file].blurhash, file);

    const stored = (await User.findById(who.user._id).lean()).banner;
    assert.deepEqual(stored.palette, expectedLook[file].palette);
    assert.equal(stored.blurhash, expectedLook[file].blurhash);
    const me = await request(app).get('/v1/me').set(who.headers);
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.banner, res.body);
  }
});

test('the palette is the crop\'s, not the whole photo\'s (#11)', async () => {
  const who = await account();
  // 1600x4000: a red band at the top, exactly the banner crop (1600x1075), and blue below it (73% of the photo).
  const band = await sharp({ create: { width: 1600, height: 1075, channels: 3, background: '#d02020' } }).png().toBuffer();
  const tall = await sharp({ create: { width: 1600, height: 4000, channels: 3, background: '#2040d0' } })
    .composite([{ input: band, left: 0, top: 0 }]).png().toBuffer();
  const res = await request(app).put('/v1/me/banner').set(who.headers)
    .attach('file', tall, { filename: 'tall.png', contentType: 'image/png' })
    .field('crop', JSON.stringify({ x: 0, y: 0, width: 1, height: 1075 / 4000 }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.palette.seed, '#D02020');
});

test('PUT /me/avatar returns a palette and blurhash too, and a replay returns the same', async () => {
  const who = await account();
  const key = crypto.randomUUID();
  const file = await photo(400, 400, '#2040d0');
  const res = await put(who, 'avatar', file, FULL, { 'Idempotency-Key': key });
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Image', res.body);
  assert.equal(res.body.palette.version, 1);
  assert.equal(res.body.palette.neutral, false);
  assert.equal(res.body.blurhash.length, 28);
  const me = await request(app).get('/v1/me').set(who.headers);
  assert.deepEqual(me.body.avatar, res.body);
  assert.deepEqual((await put(who, 'avatar', file, FULL, { 'Idempotency-Key': key })).body, res.body);
});

test('an image stored before palettes existed, or with one in another shape, has palette and blurhash null', async () => {
  const who = await account();
  const old = { path: `avatars/${who.user._id}/old`, width: 512, height: 512, variants: [{ width: 512, height: 512 }], updatedAt: new Date() };
  const odd = {
    ...old,
    path: `banners/${who.user._id}/odd`,
    palette: { version: 1, seed: '#d02020', accent: '#D02020', neutral: false },
    blurhash: 'not a blurhash',
  };
  // Written straight to the collection, as an older server (or another tool) would have left them.
  await User.collection.updateOne({ _id: who.user._id }, { $set: { avatar: old, banner: odd } });
  const me = await request(app).get('/v1/me').set(who.headers);
  assert.equal(me.status, 200, me.text);
  for (const kind of ['avatar', 'banner']) {
    assertMatchesSpec('Image', me.body[kind]);
    assert.equal(me.body[kind].palette, null, kind);
    assert.equal(me.body[kind].blurhash, null, kind);
  }
});

test('toImage passes on only a palette in the spec shape', () => {
  const urlFor = (key) => `https://cdn.example/${key}`;
  const good = { version: 1, seed: '#D02020', accent: '#B01B1B', neutral: false };
  const base = { path: 'banners/u/1', width: 1179, height: 792, variants: [{ width: 1179, height: 792 }] };
  assert.deepEqual(toImage({ ...base, palette: { ...good, extra: 'x' }, blurhash: 'LmK@9_oNK7sp{cn$wHn%K7jZbHfQ' }, urlFor).palette, good);
  assert.equal(toImage({ ...base, palette: good, blurhash: 'LmK@9_oNK7sp{cn$wHn%K7jZbHfQ' }, urlFor).blurhash, 'LmK@9_oNK7sp{cn$wHn%K7jZbHfQ');
  for (const palette of [
    undefined, null, 'red', [],
    { ...good, version: '1' }, { ...good, version: 0 }, { ...good, version: 1.5 },
    { ...good, seed: 'D02020' }, { ...good, seed: '#D0202' }, { ...good, accent: '#b01b1b' }, { ...good, accent: null },
    { ...good, neutral: 'false' }, { version: 1, seed: '#D02020', accent: '#B01B1B' },
  ]) {
    assert.equal(toImage({ ...base, palette }, urlFor).palette, null, JSON.stringify(palette));
  }
  for (const blurhash of [undefined, null, '', 'short', 'has spaces in it', 42]) {
    assert.equal(toImage({ ...base, blurhash }, urlFor).blurhash, null, String(blurhash));
  }
});
