process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const mongoose = require('mongoose');
const request = require('supertest');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { createApp } = require('../src/app');
const { createContentService, CURSOR_TTL_MS } = require('../src/modules/content/service');
const { createContentRouter } = require('../src/modules/content/routes');
const Content = require('../models/Content');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const clock = { t: Date.now(), now: () => clock.t };
const DAY = 24 * 60 * 60 * 1000;

const buildApp = () => createApp({
  trustProxy: 1,
  contentRouter: createContentRouter({ content: createContentService({ now: clock.now }) }),
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
});
after(db.disconnect);

async function account() {
  return signIn(await makeUser({ password: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', emailVerified: true }));
}

async function guest() {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(res.status, 201, res.text);
  return { headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

/** One item owned by `who`, made `minutesAgo` before the base time. */
let base = Date.now();
async function item(who, { minutesAgo = 0, ...fields } = {}) {
  const at = new Date(base - minutesAgo * 60 * 1000);
  const doc = new Content({
    ownerId: who.user._id, type: 'song', title: 'Untitled', durationSec: 200, listens: 0, ...fields, createdAt: at, updatedAt: at,
  });
  await doc.save({ timestamps: false });
  return String(doc._id);
}

/**
 * Twelve items in a known order: titles that differ in case and accents, listens and times that tie, every type.
 * `recent` is the array order (each a minute older than the one before, except the tie); `popular` and `title` are
 * given below.
 */
async function library(who) {
  base = Date.now();
  const rows = [
    ['delta', { type: 'playlist', listens: 50, songCount: 12, badge: 'trending', minutesAgo: 0 }],
    ['Alpha', { type: 'album', listens: 900, songCount: 10, year: 2023, badge: 'top10', minutesAgo: 1 }],
    ['echo', { type: 'song', listens: 50, minutesAgo: 2 }],
    [`${String.fromCodePoint(0xC9)}clair`, { type: 'story', listens: 5, minutesAgo: 3 }],
    ['bravo', { type: 'song', listens: 300, hidden: true, minutesAgo: 4 }],
    ['Charlie', { type: 'album', listens: 0, songCount: 8, followersOnly: true, minutesAgo: 5 }],
    ['zulu', { type: 'story', listens: 70, minutesAgo: 6 }],
    ['Zeta', { type: 'playlist', listens: 70, songCount: 3, minutesAgo: 7 }],
    ['golf', { type: 'song', listens: 1, minutesAgo: 8 }],
    ['hotel', { type: 'story', listens: 2, hidden: true, minutesAgo: 8 }],
    ['India', { type: 'playlist', listens: 3, songCount: 0, minutesAgo: 10 }],
    ['juliet', { type: 'album', listens: 4, songCount: 5, minutesAgo: 11 }],
  ];
  const ids = {};
  for (const [title, fields] of rows) ids[title.toLowerCase()] = await item(who, { title, ...fields });
  ids.eclair = ids[`${String.fromCodePoint(0xE9)}clair`];
  return ids;
}

const list = (who, query = {}, target = app) => request(target).get('/v1/me/content').set(who.headers).query(query);
const patch = (who, id, body) => request(app).patch(`/v1/me/content/${id}`).set(who.headers).send(body);
const ids = (res) => res.body.data.map((c) => c.id);
const later = (a, b) => (a > b ? -1 : 1);

/** Every page of a list, following `nextCursor`; checks each page against the spec and `total`. */
async function allPages(who, query, target = app) {
  const seen = [];
  let cursor;
  let total;
  for (let n = 0; n < 50; n += 1) {
    const res = await list(who, { ...query, ...(cursor ? { cursor } : {}) }, target);
    assert.equal(res.status, 200, res.text);
    assertMatchesSpec('ContentPage', res.body);
    total ??= res.body.page.total;
    assert.equal(res.body.page.total, total, 'total is the same on every page');
    seen.push(...ids(res));
    if (!res.body.page.hasMore) {
      assert.equal(res.body.page.nextCursor, null);
      assert.equal(seen.length, total);
      return seen;
    }
    assert.equal(res.body.data.length, Number(query.limit ?? 20));
    cursor = res.body.page.nextCursor;
  }
  throw new Error('too many pages');
}

// ---------------------------------------------------------------------------
// GET /me/content
// ---------------------------------------------------------------------------

test('an account with no content gets an empty page, privately', async () => {
  const me = await account();
  const res = await list(me);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('ContentPage', res.body);
  assert.deepEqual(res.body, { data: [], page: { nextCursor: null, hasMore: false, total: 0 } });
  assert.equal(res.headers['cache-control'], 'private, no-cache');
});

test('recent is the default: newest first, ties newest id first; hidden and restricted items are listed', async () => {
  const me = await account();
  const s = await library(me);
  const res = await list(me);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('ContentPage', res.body);
  const [tieA, tieB] = [s.golf, s.hotel].sort(later);
  assert.deepEqual(ids(res), [s.delta, s.alpha, s.echo, s.eclair, s.bravo, s.charlie, s.zulu, s.zeta, tieA, tieB, s.india, s.juliet]);
  assert.deepEqual(res.body.page, { nextCursor: null, hasMore: false, total: 12 });
  assert.deepEqual(ids(await list(me, { sort: 'recent', type: 'all' })), ids(res), 'the defaults are recent and all');
});

test('popular: most listens first, ties newest id first', async () => {
  const me = await account();
  const s = await library(me);
  const [z1, z2] = [s.zulu, s.zeta].sort(later);
  const [f1, f2] = [s.delta, s.echo].sort(later);
  assert.deepEqual(ids(await list(me, { sort: 'popular' })),
    [s.alpha, s.bravo, z1, z2, f1, f2, s.eclair, s.juliet, s.india, s.hotel, s.golf, s.charlie]);
  // "Popular Releases" on Profile.
  const top = await list(me, { sort: 'popular', limit: 3 });
  assert.deepEqual(ids(top), [s.alpha, s.bravo, z1]);
  assert.equal(top.body.page.hasMore, true);
  assert.equal(top.body.page.total, 12);
});

test('title: A to Z ignoring case and accents', async () => {
  const me = await account();
  const s = await library(me);
  assert.deepEqual(ids(await list(me, { sort: 'title' })),
    [s.alpha, s.bravo, s.charlie, s.delta, s.echo, s.eclair, s.golf, s.hotel, s.india, s.juliet, s.zeta, s.zulu]);
  const stored = await Content.findById(s.eclair).lean();
  assert.equal(stored.titleLower, 'eclair', 'kept for the index');
});

test('each type filter lists only that type, and total counts only it', async () => {
  const me = await account();
  const s = await library(me);
  const expected = {
    playlist: [s.delta, s.zeta, s.india],
    album: [s.alpha, s.charlie, s.juliet],
    song: [s.echo, s.bravo, s.golf],
    story: [s.eclair, s.zulu, s.hotel],
  };
  for (const [type, want] of Object.entries(expected)) {
    const res = await list(me, { type });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(ids(res), want, type);
    assert.equal(res.body.page.total, 3, type);
    assert.ok(res.body.data.every((c) => c.type === type));
  }
  assert.deepEqual(ids(await list(me, { type: 'album', sort: 'popular' })), [s.alpha, s.juliet, s.charlie]);
  assert.deepEqual(ids(await list(me, { type: 'song', sort: 'title' })), [s.bravo, s.echo, s.golf]);
});

test('hidden=false lists only visible items, hidden=true only hidden ones; total counts with the filter', async () => {
  const me = await account();
  const s = await library(me);
  const visible = await list(me, { hidden: false });
  assert.equal(visible.status, 200, visible.text);
  assertMatchesSpec('ContentPage', visible.body);
  assert.deepEqual(ids(visible), [s.delta, s.alpha, s.echo, s.eclair, s.charlie, s.zulu, s.zeta, s.golf, s.india, s.juliet]);
  assert.equal(visible.body.page.total, 10);
  assert.ok(visible.body.data.every((c) => c.hidden === false));
  const hidden = await list(me, { hidden: true });
  assert.deepEqual(ids(hidden), [s.bravo, s.hotel]);
  assert.equal(hidden.body.page.total, 2);
  const both = await list(me);
  assert.ok(ids(both).includes(s.bravo) && ids(both).includes(s.hotel));
  assert.equal(both.body.page.total, 12, 'absent: every item, as before');
  // Popular Releases and the Profile tabs.
  const [z1, z2] = [s.zulu, s.zeta].sort(later);
  const top = await list(me, { sort: 'popular', limit: 3, hidden: false });
  assert.deepEqual(ids(top), [s.alpha, z1, z2], 'the hidden bravo (300 listens) is left out');
  assert.equal(top.body.page.total, 10);
  const songs = await list(me, { type: 'song', hidden: false });
  assert.deepEqual([ids(songs), songs.body.page.total], [[s.echo, s.golf], 2]);
  assert.deepEqual(ids(await list(me, { type: 'story', hidden: true })), [s.hotel]);
  assert.deepEqual(ids(await list(me, { type: 'album', hidden: true })), []);
});

test('the hidden filter follows changes, and an item stored without the flag counts as not hidden', async () => {
  const me = await account();
  const s = await library(me);
  assert.equal((await patch(me, s.delta, { hidden: true })).status, 200);
  assert.equal((await patch(me, s.bravo, { hidden: false })).status, 200);
  assert.deepEqual(ids(await list(me, { hidden: true })), [s.delta, s.hotel], 'newest first');
  assert.ok(ids(await list(me, { hidden: false, limit: 50 })).includes(s.bravo));
  await Content.collection.updateOne({ _id: new mongoose.Types.ObjectId(s.echo) }, { $unset: { hidden: '' } });
  const visible = await list(me, { hidden: false, limit: 50 });
  assert.ok(ids(visible).includes(s.echo));
  assert.equal(visible.body.data.find((c) => c.id === s.echo).hidden, false);
  assert.ok(!ids(await list(me, { hidden: true })).includes(s.echo));
});

test('paging with the hidden filter gives every matching item once, for every sort', async () => {
  const me = await account();
  await library(me);
  const target = buildApp();
  for (const sort of ['recent', 'popular', 'title']) {
    for (const hidden of [false, true]) {
      const whole = ids(await list(me, { sort, hidden, limit: 50 }, target));
      assert.deepEqual(await allPages(me, { sort, hidden, limit: 3 }, target), whole, `${sort} hidden=${hidden}`);
    }
  }
});

test('a cursor only works with the same hidden filter; hidden must be a boolean (validator)', async () => {
  const me = await account();
  await library(me);
  const fromVisible = (await list(me, { hidden: false, limit: 2 })).body.page.nextCursor;
  assert.equal((await list(me, { hidden: false, limit: 2, cursor: fromVisible })).status, 200);
  assertProblem(await list(me, { limit: 2, cursor: fromVisible }), 422, 'CURSOR_INVALID');
  assertProblem(await list(me, { hidden: true, limit: 2, cursor: fromVisible }), 422, 'CURSOR_INVALID');
  const fromAll = (await list(me, { limit: 2 })).body.page.nextCursor;
  assertProblem(await list(me, { hidden: false, limit: 2, cursor: fromAll }), 422, 'CURSOR_INVALID');
  for (const hidden of ['maybe', 'yes', 'null']) {
    assertProblem(await list(me, { hidden }), 422, 'VALIDATION_FAILED');
  }
});

test('paging gives every item once, in order, for every sort and type', async () => {
  const me = await account();
  await library(me);
  for (const sort of ['recent', 'popular', 'title']) {
    // A fresh app (and so a fresh rate limiter) for each sort: this test makes more than 120 requests.
    const target = buildApp();
    for (const type of ['all', 'playlist', 'album', 'song', 'story']) {
      const whole = ids(await list(me, { sort, type, limit: 50 }, target));
      for (const limit of [1, 2, 5]) {
        assert.deepEqual(await allPages(me, { sort, type, limit }, target), whole, `${sort} ${type} by ${limit}`);
      }
    }
  }
});

test('a page starts after the last item shown: items added meanwhile do not shift it', async () => {
  const me = await account();
  const s = await library(me);
  const first = await list(me, { limit: 4 });
  assert.deepEqual(ids(first), [s.delta, s.alpha, s.echo, s.eclair]);
  await item(me, { title: 'newest', minutesAgo: -5 });
  await Content.deleteOne({ _id: s.alpha });
  const next = await list(me, { limit: 4, cursor: first.body.page.nextCursor });
  assert.deepEqual(ids(next), [s.bravo, s.charlie, s.zulu, s.zeta]);
  assert.equal(next.body.page.total, 12, 'total is counted again on every page');
});

test('the Content shape: artwork, song count only for playlists and albums, flags, odd stored values', async () => {
  const me = await account();
  const album = await item(me, {
    type: 'album', title: 'Late Night Drive', year: 2024, songCount: 12, durationSec: 2710, listens: 48210, badge: 'top10',
    image: { url: 'https://cdn.example.com/c/late.jpg', width: 512, height: 512 },
  });
  const song = await item(me, { type: 'song', title: 'One', songCount: 1, hidden: true, followersOnly: true, minutesAgo: 1 });
  const res = await list(me);
  assertMatchesSpec('ContentPage', res.body);
  const [a, b] = res.body.data;
  assert.deepEqual(a, {
    id: album, type: 'album', title: 'Late Night Drive',
    image: { url: 'https://cdn.example.com/c/late.jpg', width: 512, height: 512, status: 'ready', blurhash: null },
    year: 2024, songCount: 12, durationSec: 2710, listens: 48210, badge: 'top10', hidden: false, followersOnly: false,
    createdAt: new Date(base).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  assert.equal(b.id, song);
  assert.equal(b.songCount, null, 'a song has no song count');
  assert.deepEqual([b.year, b.image, b.badge, b.hidden, b.followersOnly], [null, null, null, true, true]);

  // Values written elsewhere that are not in the spec's shape read as their defaults.
  await Content.collection.updateOne({ _id: new mongoose.Types.ObjectId(album) }, {
    $set: { badge: 'gold', year: 2024.5, songCount: -1, listens: -3, durationSec: 'long', image: { url: 'ftp://x/y.jpg' } },
  });
  const odd = (await list(me)).body;
  assertMatchesSpec('ContentPage', odd);
  assert.deepEqual([odd.data[0].badge, odd.data[0].year, odd.data[0].songCount, odd.data[0].listens, odd.data[0].durationSec, odd.data[0].image],
    [null, null, null, 0, 0, null]);
});

test('only the caller\'s own content is listed, and a cursor works only for its user, type and sort', async () => {
  const me = await account();
  const other = await account();
  await library(me);
  const theirs = await item(other, { title: 'Theirs' });
  assert.ok(!ids(await list(me, { limit: 50 })).includes(theirs));
  assert.deepEqual(ids(await list(other)), [theirs]);

  const first = await list(me, { limit: 2 });
  const { nextCursor } = first.body.page;
  assert.equal((await list(me, { limit: 2, cursor: nextCursor })).status, 200);
  assertProblem(await list(me, { limit: 2, cursor: nextCursor, sort: 'popular' }), 422, 'CURSOR_INVALID');
  assertProblem(await list(me, { limit: 2, cursor: nextCursor, type: 'song' }), 422, 'CURSOR_INVALID');
  assertProblem(await list(other, { limit: 2, cursor: nextCursor }), 422, 'CURSOR_INVALID');
  assert.equal((await list(me, { limit: 7, cursor: nextCursor })).status, 200, 'the page size may change');
});

test('a cursor expires after 24 hours; forged and malformed cursors are refused', async () => {
  const me = await account();
  await library(me);
  const { nextCursor } = (await list(me, { limit: 2 })).body.page;
  clock.t += CURSOR_TTL_MS - 1000;
  assert.equal((await list(me, { limit: 2, cursor: nextCursor })).status, 200);
  clock.t += 2000;
  const expired = await list(me, { limit: 2, cursor: nextCursor });
  assertProblem(expired, 422, 'CURSOR_INVALID');
  assertMatchesSpec('Problem', expired.body);
  assert.equal(expired.body.errors[0].field, 'cursor');
  clock.t -= CURSOR_TTL_MS;

  const decoded = JSON.parse(Buffer.from(nextCursor, 'base64url').toString('utf8'));
  const forge = (change) => Buffer.from(JSON.stringify({ ...decoded, ...change })).toString('base64url');
  for (const cursor of ['not a cursor', 'bm90LWpzb24', forge({ i: 'nope' }), forge({ k: 'text' }), forge({ f: 'other' }),
    forge({ t: Math.floor((clock.t + DAY) / 1000) }), forge({ t: 'now' }), Buffer.from('null').toString('base64url')]) {
    assertProblem(await list(me, { cursor }), 422, 'CURSOR_INVALID');
  }
  const title = (await list(me, { limit: 2, sort: 'title' })).body.page.nextCursor;
  const titleDecoded = JSON.parse(Buffer.from(title, 'base64url').toString('utf8'));
  assert.equal(typeof titleDecoded.k, 'string');
  const forged = Buffer.from(JSON.stringify({ ...titleDecoded, k: 5 })).toString('base64url');
  assertProblem(await list(me, { sort: 'title', cursor: forged }), 422, 'CURSOR_INVALID');
});

test('type, sort and limit are checked (validator)', async () => {
  const me = await account();
  for (const query of [{ type: 'video' }, { type: 'songs' }, { sort: 'oldest' }, { limit: 0 }, { limit: 51 }, { limit: 'x' },
    { cursor: 'a'.repeat(513) }, { other: '1' }]) {
    assertProblem(await list(me, query), 422, 'VALIDATION_FAILED');
  }
  assert.equal((await list(me, { limit: 50 })).status, 200);
});

test('content needs a session and an account', async () => {
  assertProblem(await request(app).get('/v1/me/content').set(CLIENT), 401, 'UNAUTHENTICATED');
  assertProblem(await request(app).patch(`/v1/me/content/${new mongoose.Types.ObjectId()}`).set(CLIENT).send({ hidden: true }),
    401, 'UNAUTHENTICATED');
  const g = await guest();
  assertProblem(await list(g), 403, 'GUEST_NOT_ALLOWED');
  assertProblem(await patch(g, new mongoose.Types.ObjectId(), { hidden: true }), 403, 'GUEST_NOT_ALLOWED');
});

test('listing is limited to 120 a minute per account', async () => {
  const target = buildApp();
  const me = await account();
  const other = await account();
  for (let i = 0; i < 120; i += 1) {
    const res = await list(me, {}, target);
    assert.equal(res.status, 200, `request ${i + 1}: ${res.text}`);
  }
  const limited = await list(me, {}, target);
  assertProblem(limited, 429, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await list(other, {}, target)).status, 200, 'another account has its own count');
});

// ---------------------------------------------------------------------------
// PATCH /me/content/{contentId}
// ---------------------------------------------------------------------------

test('PATCH hides and restricts an item, either or both, and the list shows it', async () => {
  const me = await account();
  const s = await library(me);
  let res = await patch(me, s.delta, { hidden: true });
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Content', res.body);
  assert.equal(res.headers['cache-control'], 'private, no-cache');
  assert.deepEqual([res.body.id, res.body.hidden, res.body.followersOnly], [s.delta, true, false]);
  res = await patch(me, s.delta, { followersOnly: true });
  assert.deepEqual([res.body.hidden, res.body.followersOnly], [true, true], 'a field not sent keeps its value');
  res = await request(app).patch(`/v1/me/content/${s.delta}`)
    .set({ ...me.headers, 'Content-Type': 'application/merge-patch+json' }).send(JSON.stringify({ hidden: false, followersOnly: false }));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.hidden, res.body.followersOnly], [false, false]);
  res = await patch(me, s.bravo, { hidden: false });
  assert.equal(res.body.hidden, false);
  const listed = (await list(me, { limit: 50 })).body.data;
  assert.equal(listed.find((c) => c.id === s.bravo).hidden, false);
  const stored = await Content.findById(s.bravo).lean();
  assert.equal(stored.hidden, false);
  assert.equal(stored.title, 'bravo', 'nothing else changes');
  assert.equal(stored.listens, 300);
});

test('someone else\'s item, an unknown id and a malformed id are all 404 CONTENT_NOT_FOUND', async () => {
  const me = await account();
  const other = await account();
  const theirs = await item(other, { title: 'Theirs' });
  const res = await patch(me, theirs, { hidden: true });
  assertProblem(res, 404, 'CONTENT_NOT_FOUND');
  assertMatchesSpec('Problem', res.body);
  assert.equal((await Content.findById(theirs).lean()).hidden, false, 'their item is unchanged');
  assertProblem(await patch(me, new mongoose.Types.ObjectId(), { hidden: true }), 404, 'CONTENT_NOT_FOUND');
  assertProblem(await patch(me, 'not-an-id', { hidden: true }), 404, 'CONTENT_NOT_FOUND');
});

test('PATCH needs hidden or followersOnly, as booleans, and nothing else (validator)', async () => {
  const me = await account();
  const id = await item(me);
  for (const body of [{}, { hidden: 'yes' }, { followersOnly: null }, { title: 'x' }, { hidden: true, listens: 9 }]) {
    assertProblem(await patch(me, id, body), 422, 'VALIDATION_FAILED');
  }
  assertProblem(await patch(me, 'x'.repeat(65), { hidden: true }), 422, 'VALIDATION_FAILED');
  assert.equal((await Content.findById(id).lean()).hidden, false);
});

test('the collection has the indexes the three sorts need', async () => {
  const indexes = await Content.collection.indexes();
  const keys = Object.fromEntries(indexes.map((ix) => [ix.name, ix.key]));
  assert.deepEqual(keys.owner_recent, { ownerId: 1, createdAt: -1, _id: -1 });
  assert.deepEqual(keys.owner_popular, { ownerId: 1, listens: -1, _id: -1 });
  assert.deepEqual(keys.owner_title, { ownerId: 1, titleLower: 1, _id: 1 });
  const me = await account();
  await library(me);
  for (const [sort, name] of [['recent', 'owner_recent'], ['popular', 'owner_popular'], ['title', 'owner_title']]) {
    const { SORTS } = require('../src/modules/content/repo');
    const { field, direction } = SORTS[sort];
    const plan = await Content.find({ ownerId: me.user._id }).sort({ [field]: direction, _id: direction }).limit(3).explain();
    assert.match(JSON.stringify(plan.queryPlanner.winningPlan), new RegExp(name), `${sort} uses ${name}`);
  }
});
