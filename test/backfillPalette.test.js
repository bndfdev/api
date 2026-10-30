process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { backfill, parseArgs } = require('../scripts/backfill-image-palette');
const { analyseImage, PALETTE_VERSION } = require('../src/lib/palette');
const { createLocalStorage } = require('../src/providers/storage/local');
const User = require('../models/User');
const db = require('./support/db');
const { makeUser } = require('./support/api');

const FIXTURES = path.join(__dirname, 'fixtures', 'palette');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bondfire-backfill-'));
const storage = createLocalStorage({ dir, publicUrl: 'http://localhost:3000/media' });
// A palette that colour rules v1 never give for these pictures, to see whether something was rewritten.
const MARKED = Object.freeze({ version: PALETTE_VERSION, seed: '#123456', accent: '#123456', neutral: false });

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

/**
 * Give `user` an avatar or banner the way an older server stored it: the default size in storage (a JPEG made from
 * a sample picture) and the record without palette or blurhash. `extra` is added to the record.
 */
async function oldImage(user, kind, picture, extra = {}) {
  const [width, height] = kind === 'avatar' ? [512, 512] : [786, 528];
  const folder = `${kind}s/${String(user._id)}/${crypto.randomBytes(6).toString('hex')}`;
  const jpeg = await sharp(path.join(FIXTURES, picture)).resize(width, height, { fit: 'fill' })
    .flatten({ background: '#000000' }).jpeg({ quality: 82 }).toBuffer();
  await storage.put(`${folder}/${width}.jpg`, jpeg);
  const image = { path: folder, width, height, variants: [{ width, height }], updatedAt: new Date('2026-10-01T00:00:00Z'), ...extra };
  await User.collection.updateOne({ _id: user._id }, { $set: { [kind]: image } });
  return { path: folder, jpeg };
}

const docOf = async (user) => User.findById(user._id).lean();
const quiet = () => {};

test('fills the palette and blurhash of old avatars and banners from their stored default size', async () => {
  const ann = await makeUser({ updatedAt: new Date('2026-10-02T00:00:00Z') });
  const bob = await makeUser();
  await makeUser(); // no photos
  const annBanner = await oldImage(ann, 'banner', 'red_blue.png');
  const annAvatar = await oldImage(ann, 'avatar', 'yellow.png');
  const bobBanner = await oldImage(bob, 'banner', 'navy.png');
  const lines = [];

  const counts = await backfill({ storage, log: (line) => lines.push(line) });
  assert.deepEqual(counts, { checked: 3, filled: 3, skipped: 0, failed: 0 });
  assert.match(lines.at(-1), /checked 3, filled 3, skipped 0 \(changed meanwhile\), failed 0/);

  const annDoc = await docOf(ann);
  for (const [image, stored] of [[annBanner, annDoc.banner], [annAvatar, annDoc.avatar], [bobBanner, (await docOf(bob)).banner]]) {
    const look = await analyseImage(image.jpeg);
    assert.deepEqual(stored.palette, look.palette);
    assert.equal(stored.blurhash, look.blurhash);
    assert.equal(stored.path, image.path);
  }
  assert.equal(annDoc.banner.palette.neutral, false);
  assert.deepEqual(annDoc.updatedAt, new Date('2026-10-02T00:00:00Z'), 'the profile itself did not change');
});

test('a second run changes nothing, and an image already done is left as it is', async () => {
  const ann = await makeUser();
  await oldImage(ann, 'avatar', 'yellow.png', { palette: MARKED, blurhash: 'LFTRW_?BfQ?B~OoKfQoKfQfQfQfQ' });
  await oldImage(ann, 'banner', 'red_blue.png');
  const first = await backfill({ storage, log: quiet });
  assert.deepEqual(first, { checked: 1, filled: 1, skipped: 0, failed: 0 });
  const afterFirst = await docOf(ann);
  assert.deepEqual(afterFirst.avatar.palette, MARKED, 'the avatar already had a v1 palette');
  assert.equal(afterFirst.banner.palette.version, PALETTE_VERSION);

  const second = await backfill({ storage, log: quiet });
  assert.deepEqual(second, { checked: 0, filled: 0, skipped: 0, failed: 0 });
  assert.deepEqual(await docOf(ann), afterFirst);
});

test('a palette from an older version of the rules is worked out again', async () => {
  const ann = await makeUser();
  const { jpeg } = await oldImage(ann, 'banner', 'red_blue.png', { palette: { ...MARKED, version: 0 } });
  assert.deepEqual(await backfill({ storage, log: quiet }), { checked: 1, filled: 1, skipped: 0, failed: 0 });
  const { banner } = await docOf(ann);
  assert.deepEqual(banner.palette, (await analyseImage(jpeg)).palette);
  assert.equal(banner.palette.version, PALETTE_VERSION);
});

test('an image replaced while it was being read keeps the new photo and its own palette', async () => {
  const ann = await makeUser();
  await oldImage(ann, 'banner', 'red_blue.png');
  const replaced = {
    path: `banners/${ann._id}/newer`, width: 786, height: 528, variants: [{ width: 786, height: 528 }],
    updatedAt: new Date(), palette: MARKED, blurhash: 'L*J3}y{@OGOHspn~a}a}fQfQfQfQ',
  };
  // A new upload lands between reading the old file and saving its palette.
  const racing = {
    async get(key) {
      const body = await storage.get(key);
      await User.collection.updateOne({ _id: ann._id }, { $set: { banner: replaced } });
      return body;
    },
  };
  const counts = await backfill({ storage: racing, log: quiet });
  assert.deepEqual(counts, { checked: 1, filled: 0, skipped: 1, failed: 0 });
  const { banner } = await docOf(ann);
  assert.equal(banner.path, replaced.path);
  assert.deepEqual(banner.palette, MARKED);
  assert.equal(banner.blurhash, replaced.blurhash);
});

test('--dry-run works everything out and writes nothing', async () => {
  const ann = await makeUser();
  await oldImage(ann, 'banner', 'red_blue.png');
  await oldImage(ann, 'avatar', 'navy.png');
  const before = await docOf(ann);
  const lines = [];
  const counts = await backfill({ storage, dryRun: true, log: (line) => lines.push(line) });
  assert.deepEqual(counts, { checked: 2, filled: 2, skipped: 0, failed: 0 });
  assert.match(lines[0], /dry run/);
  assert.match(lines.at(-1), /would fill 2/);
  assert.deepEqual(await docOf(ann), before);
});

test('--limit stops after that many images, and the next run carries on where it stopped', async () => {
  const users = [await makeUser(), await makeUser()];
  await oldImage(users[0], 'avatar', 'yellow.png');
  await oldImage(users[0], 'banner', 'red_blue.png');
  await oldImage(users[1], 'banner', 'navy.png');
  assert.deepEqual(await backfill({ storage, limit: 2, log: quiet }), { checked: 2, filled: 2, skipped: 0, failed: 0 });
  assert.equal((await docOf(users[1])).banner.palette, undefined);
  assert.deepEqual(await backfill({ storage, log: quiet }), { checked: 1, filled: 1, skipped: 0, failed: 0 });
  assert.equal((await docOf(users[1])).banner.palette.version, PALETTE_VERSION);
});

test('an image whose file cannot be read is logged and left for the next run; the rest are filled', async () => {
  const ann = await makeUser();
  const bob = await makeUser();
  const missing = await oldImage(ann, 'banner', 'red_blue.png');
  fs.rmSync(path.join(dir, ...missing.path.split('/')), { recursive: true, force: true });
  await oldImage(bob, 'banner', 'navy.png');
  const lines = [];
  const counts = await backfill({ storage, log: (line) => lines.push(line), pageSize: 1 });
  assert.deepEqual(counts, { checked: 2, filled: 1, skipped: 0, failed: 1 });
  assert.ok(lines.some((line) => line.includes(`banner of user ${ann._id}`)), lines.join('\n'));
  assert.equal((await docOf(ann)).banner.palette, undefined);
  assert.equal((await docOf(bob)).banner.palette.version, PALETTE_VERSION);
});

test('the command line takes --dry-run and --limit N only', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, limit: Infinity });
  assert.deepEqual(parseArgs(['--dry-run', '--limit', '5']), { dryRun: true, limit: 5 });
  assert.deepEqual(parseArgs(['--limit=7']), { dryRun: false, limit: 7 });
  for (const argv of [['--limit'], ['--limit', '0'], ['--limit', 'x'], ['--limit=-1'], ['--force'], ['users']]) {
    assert.throws(() => parseArgs(argv), Error, argv.join(' '));
  }
});
