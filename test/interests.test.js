process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const request = require('supertest');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { createApp } = require('../src/app');
const { config } = require('../src/config');
const { createCatalog, fold } = require('../src/modules/interests/catalog');
const { createInterestsService, CURSOR_TTL_MS } = require('../src/modules/interests/service');
const { createInterestsRouter } = require('../src/modules/interests/routes');
const { createMeService } = require('../src/modules/me/service');
const { createMeRouter } = require('../src/modules/me/routes');
const { LIMITS } = require('../src/modules/meta/service');
const Genre = require('../models/Genre');
const Artist = require('../models/Artist');
const Country = require('../models/Country');
const User = require('../models/User');
const GuestAccount = require('../models/GuestAccount');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const clock = { t: Date.now(), now: () => clock.t };
const BASE = 'https://api.bondfire.test';

/** The app, with a catalog that reads the collections on every request (no cache) and the test clock. */
function buildApp({ maxInterests = LIMITS.maxInterests } = {}) {
  const catalog = createCatalog({ config: { ...config, apiBaseUrl: BASE }, ttlMs: 0, now: clock.now });
  const interests = createInterestsService({ catalog, now: clock.now, limits: { maxInterests } });
  return createApp({
    trustProxy: 1,
    interestsRouter: createInterestsRouter({ interests }),
    meRouter: createMeRouter({ me: createMeService({ now: clock.now }) }),
  });
}
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

/**
 * The catalog collections, as the old API and the admin panel fill them. Created one by one, so `_id`s (and
 * so "recent") follow this order within each collection.
 */
async function seed() {
  const g = {};
  for (const [key, doc] of [
    ['pop', { name: 'Pop', counter: 80, image: 'https://cdn.example.com/pop.png' }],
    ['hiphop', { name: 'Hip-Hop', counter: 50, image: '/uploads/genres/hiphop.jpg' }],
    ['jazz', { name: 'Jazz', counter: 10 }],
    ['kpop', { name: 'K-Pop', counter: 5, image: 'kpop.jpg' }],
    ['dormant', { name: 'Dormant', counter: 999, active: false }],
  ]) g[key] = await Genre.create(doc);
  const a = {};
  for (const [key, doc] of [
    ['daya', { name: 'Daya', image: 'daya.jpg' }],
    ['coastin', { name: 'Coastin\u2019' }],
    ['beyonce', { name: 'Beyonce\u0301' }],
    ['popsmoke', { name: 'Pop Smoke' }],
    ['gone', { name: 'Gone Artist', active: false }],
  ]) a[key] = await Artist.create(doc);
  const c = {};
  for (const [key, doc] of [
    ['us', { name: 'United States', code: 'US', flag: 'us.png', countryCode: '+1' }],
    ['in', { name: 'India', code: 'IN', flag: 'in.png', countryCode: '+91' }],
    ['off', { name: 'Hidden Land', code: 'HL', flag: 'hl.png', countryCode: '+999', enabled: false }],
  ]) c[key] = await Country.create(doc);
  const id = (kind, doc) => `${kind}_${doc._id}`;
  return {
    pop: id('genre', g.pop), hiphop: id('genre', g.hiphop), jazz: id('genre', g.jazz), kpop: id('genre', g.kpop),
    dormant: id('genre', g.dormant),
    daya: id('artist', a.daya), coastin: id('artist', a.coastin), beyonce: id('artist', a.beyonce),
    popsmoke: id('artist', a.popsmoke), gone: id('artist', a.gone),
    us: id('place', c.us), india: id('place', c.in), off: id('place', c.off),
    docs: { g, a, c },
  };
}

async function account(extra = {}) {
  return signIn(await makeUser({ password: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', emailVerified: true, ...extra }));
}

async function guest(target = app) {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(target).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.user.id, headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

const get = (who, path, extra = {}, target = app) => request(target).get(path).set({ ...who.headers, ...extra });
const putAll = (who, interestIds, target = app) => request(target).put('/v1/me/interests').set(who.headers).send({ interestIds });
const addOne = (who, id, target = app) => request(target).put(`/v1/me/interests/${id}`).set(who.headers);
const removeOne = (who, id, target = app) => request(target).delete(`/v1/me/interests/${id}`).set(who.headers);
const ids = (res) => res.body.data.map((i) => i.id);
const stepOf = (onboarding) => onboarding.steps.find((s) => s.step === 'interests');

/** Every page of a list, following `nextCursor`. */
async function allPages(who, path, query) {
  const seen = [];
  let cursor;
  for (let n = 0; n < 50; n += 1) {
    const res = await get(who, path).query({ ...query, ...(cursor ? { cursor } : {}) });
    assert.equal(res.status, 200, res.text);
    assertMatchesSpec('InterestPage', res.body);
    seen.push(...res.body.data);
    if (!res.body.page.hasMore) {
      assert.equal(res.body.page.nextCursor, null);
      return seen;
    }
    cursor = res.body.page.nextCursor;
  }
  throw new Error('too many pages');
}

// ---------------------------------------------------------------------------
// GET /interests/featured
// ---------------------------------------------------------------------------

test('featured mixes the kinds in turn, most popular first, with grid sizes and mapped images', async () => {
  const s = await seed();
  const me = await account();
  const res = await get(me, '/v1/interests/featured');
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('InterestPage', res.body);
  // genre, artist, place in turn; genres by popularity, artists and places (no popularity) by title.
  assert.deepEqual(ids(res), [
    s.pop, s.beyonce, s.india,
    s.hiphop, s.coastin, s.us,
    s.jazz, s.daya,
    s.kpop, s.popsmoke,
  ]);
  assert.deepEqual(res.body.data.map((i) => i.presentation.size),
    ['small', 'small', 'large', 'small', 'small', 'small', 'small', 'small', 'large', 'small']);
  assert.deepEqual(res.body.page, { nextCursor: null, hasMore: false });
  const byId = Object.fromEntries(res.body.data.map((i) => [i.id, i]));
  assert.deepEqual(byId[s.pop], {
    id: s.pop, kind: 'genre', title: 'Pop', subtitle: null,
    image: { url: 'https://cdn.example.com/pop.png', width: 0, height: 0, status: 'ready', blurhash: null },
    presentation: { size: 'small' },
  });
  assert.equal(byId[s.hiphop].image.url, `${BASE}/uploads/genres/hiphop.jpg`);
  assert.equal(byId[s.kpop].image.url, `${BASE}/uploads/genres/kpop.jpg`);
  assert.equal(byId[s.daya].image.url, `${BASE}/uploads/artists/daya.jpg`);
  assert.equal(byId[s.jazz].image, null);
  assert.equal(byId[s.india].image, null);
  assert.equal(byId[s.india].kind, 'place');
  for (const hidden of [s.dormant, s.gone, s.off]) assert.equal(byId[hidden], undefined, 'inactive items are left out');
});

test('featured pages with a cursor; sizes follow the position in the whole list', async () => {
  await seed();
  const me = await account();
  const whole = (await get(me, '/v1/interests/featured').query({ limit: 50 })).body.data;
  const paged = await allPages(me, '/v1/interests/featured', { limit: 3 });
  assert.deepEqual(paged, whole);
  const first = await get(me, '/v1/interests/featured').query({ limit: 3 });
  assert.equal(first.body.data.length, 3);
  assert.equal(first.body.page.hasMore, true);
  assert.equal(typeof first.body.page.nextCursor, 'string');
});

test('featured puts the viewer\'s country first among places, and a cursor stays with its region', async () => {
  const s = await seed();
  const me = await account();
  const us = await get(me, '/v1/interests/featured', { 'CloudFront-Viewer-Country': 'US' });
  assert.equal(us.body.data[2].id, s.us);
  assert.equal(us.body.data[5].id, s.india);
  const unknown = await get(me, '/v1/interests/featured', { 'CF-IPCountry': 'ZZ' });
  assert.equal(unknown.body.data[2].id, s.india, 'a country not in the catalog changes nothing');

  const page1 = await get(me, '/v1/interests/featured', { 'CloudFront-Viewer-Country': 'US' }).query({ limit: 2 });
  const elsewhere = await get(me, '/v1/interests/featured', { 'CloudFront-Viewer-Country': 'IN' })
    .query({ limit: 2, cursor: page1.body.page.nextCursor });
  assertProblem(elsewhere, 422, 'CURSOR_INVALID');
});

test('featured holds at most 20 of each kind; the other kinds carry on when one runs out', async () => {
  const genres = [];
  for (let i = 0; i < 25; i += 1) genres.push(await Genre.create({ name: `Genre ${i}`, counter: 100 - i }));
  const artist = await Artist.create({ name: 'Solo' });
  const me = await account();
  const all = await allPages(me, '/v1/interests/featured', { limit: 50 });
  assert.equal(all.length, 21);
  assert.deepEqual(all.map((i) => i.id), [
    `genre_${genres[0]._id}`, `artist_${artist._id}`,
    ...genres.slice(1, 20).map((g) => `genre_${g._id}`),
  ], 'the 20 most popular genres; the 5 least popular are left out');
});

test('featured needs a session; guests may read it; an empty catalog is an empty page', async () => {
  assertProblem(await request(app).get('/v1/interests/featured').set(CLIENT), 401, 'UNAUTHENTICATED');
  const visitor = await guest();
  const empty = await get(visitor, '/v1/interests/featured');
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body, { data: [], page: { nextCursor: null, hasMore: false } });
});

test('featured refuses a bad limit (validator) and a bad cursor', async () => {
  await seed();
  const me = await account();
  assertProblem(await get(me, '/v1/interests/featured').query({ limit: 0 }), 422, 'VALIDATION_FAILED');
  assertProblem(await get(me, '/v1/interests/featured').query({ limit: 51 }), 422, 'VALIDATION_FAILED');
  const bad = await get(me, '/v1/interests/featured').query({ cursor: 'not-a-cursor' });
  assertProblem(bad, 422, 'CURSOR_INVALID');
  assertMatchesSpec('Problem', bad.body);
  const long = await get(me, '/v1/interests/featured').query({ cursor: 'a'.repeat(513) });
  assertProblem(long, 422, 'VALIDATION_FAILED');
  assert.equal(long.body.errors[0].code, 'CURSOR_INVALID');
  // A search cursor is not a featured cursor.
  const searched = await get(me, '/v1/interests/search').query({ limit: 1 });
  assertProblem(await get(me, '/v1/interests/featured').query({ cursor: searched.body.page.nextCursor }), 422, 'CURSOR_INVALID');
});

// ---------------------------------------------------------------------------
// GET /interests/search
// ---------------------------------------------------------------------------

test('search ignores case, accents and punctuation, and matches word prefixes as the user types', async () => {
  const s = await seed();
  const me = await account();
  const find = async (q, extra = {}) => {
    const res = await get(me, '/v1/interests/search').query({ q, ...extra });
    assert.equal(res.status, 200, res.text);
    assertMatchesSpec('InterestPage', res.body);
    return ids(res);
  };
  assert.deepEqual(await find('Coastin'), [s.coastin]);
  assert.deepEqual(await find("coastin'"), [s.coastin]);
  assert.deepEqual(await find('BEYONC\u00c9'), [s.beyonce]);
  assert.deepEqual(await find('  bey '), [s.beyonce]);
  assert.deepEqual(await find('hop'), [s.hiphop], 'each word of a title can start a match');
  assert.deepEqual(await find('ip'), [], 'only word starts match');
  assert.deepEqual(await find('states united'), [s.us], 'words in any order');
  assert.deepEqual(await find('united kingdom'), [], 'every word must match');
  assert.deepEqual(await find('gone'), [], 'inactive items are not found');
  assert.deepEqual(await find('hidden'), [], 'disabled countries are not found');
  assert.equal(fold('Beyonc\u00e9 \u2013 K-Pop\u2019s'), 'beyonce k pops');
});

test('search by relevance: the whole title, then its start, then word starts; ties by popularity', async () => {
  const s = await seed();
  const me = await account();
  const res = await get(me, '/v1/interests/search').query({ q: 'pop' });
  assert.deepEqual(ids(res), [s.pop, s.popsmoke, s.kpop]);
  assert.equal(res.body.data[0].presentation, undefined, 'the grid hint is only for featured');
});

test('search with no text returns the popular items of the chosen kinds; kind filters; other sorts', async () => {
  const s = await seed();
  const me = await account();
  const list = async (query) => ids(await get(me, '/v1/interests/search').query(query));
  assert.deepEqual(await list({ kind: 'genre' }), [s.pop, s.hiphop, s.jazz, s.kpop]);
  assert.deepEqual(await list({ q: '   ', kind: 'genre' }), [s.pop, s.hiphop, s.jazz, s.kpop]);
  assert.deepEqual(await list({ kind: ['artist', 'place'], sort: 'alphabetical' }),
    [s.beyonce, s.coastin, s.daya, s.india, s.popsmoke, s.us]);
  assert.deepEqual(await list({ kind: 'genre', sort: 'recent' }), [s.kpop, s.jazz, s.hiphop, s.pop]);
  assert.deepEqual(await list({ kind: 'genre', sort: 'popular', q: 'p' }), [s.pop, s.kpop]);
  assert.deepEqual(await list({ kind: 'album' }), [], 'kinds with no data yet return nothing');
  assert.equal((await list({})).length, 10, 'no filter: every active item');
  const req = new URLSearchParams([['kind', 'genre'], ['kind', 'place'], ['kind', 'genre']]);
  assert.deepEqual(ids(await get(me, `/v1/interests/search?${req}`)), [s.pop, s.hiphop, s.jazz, s.kpop, s.india, s.us]);
});

test('search pages with a cursor that only works for the same search and for 24 hours', async () => {
  await seed();
  const me = await account();
  const whole = ids(await get(me, '/v1/interests/search').query({ limit: 50 }));
  const paged = (await allPages(me, '/v1/interests/search', { limit: 4 })).map((i) => i.id);
  assert.deepEqual(paged, whole);

  const first = await get(me, '/v1/interests/search').query({ q: 'p', limit: 1 });
  const cursor = first.body.page.nextCursor;
  assert.equal(first.body.page.hasMore, true);
  const next = await get(me, '/v1/interests/search').query({ q: 'P', limit: 1, cursor });
  assert.equal(next.status, 200, 'the same query in another case is the same search');
  assertProblem(await get(me, '/v1/interests/search').query({ q: 'po', cursor }), 422, 'CURSOR_INVALID');
  assertProblem(await get(me, '/v1/interests/search').query({ q: 'p', sort: 'recent', cursor }), 422, 'CURSOR_INVALID');
  assertProblem(await get(me, '/v1/interests/search').query({ q: 'p', kind: 'genre', cursor }), 422, 'CURSOR_INVALID');

  clock.t += CURSOR_TTL_MS - 1000;
  assert.equal((await get(me, '/v1/interests/search').query({ q: 'p', cursor })).status, 200);
  clock.t += 2000;
  assertProblem(await get(me, '/v1/interests/search').query({ q: 'p', cursor }), 422, 'CURSOR_INVALID');

  const forged = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  for (const bad of [{ ...body, o: -1 }, { ...body, o: 1.5 }, { ...body, t: Math.floor(clock.t / 1000) + 3600 }, { ...body, f: 'x' }, [1]]) {
    assertProblem(await get(me, '/v1/interests/search').query({ q: 'p', cursor: forged(bad) }), 422, 'CURSOR_INVALID');
  }
});

test('search refuses invalid text, kinds and limits', async () => {
  const me = await account();
  const long = await get(me, '/v1/interests/search').query({ q: 'a'.repeat(101) });
  assertProblem(long, 422, 'VALIDATION_FAILED');
  assert.deepEqual(long.body.errors, [{ field: 'q', code: 'SEARCH_QUERY_INVALID', message: 'Use up to 100 characters.' }]);
  assert.equal((await get(me, '/v1/interests/search').query({ q: 'a'.repeat(100) })).status, 200);
  const control = await get(me, '/v1/interests/search').query({ q: 'pop\u0007' });
  assertProblem(control, 422, 'SEARCH_QUERY_INVALID');
  assertMatchesSpec('Problem', control.body);
  assertProblem(await get(me, '/v1/interests/search').query({ kind: 'planet' }), 422, 'VALIDATION_FAILED');
  assertProblem(await get(me, '/v1/interests/search').query({ sort: 'random' }), 422, 'VALIDATION_FAILED');
  assertProblem(await get(me, '/v1/interests/search').query({ limit: 'many' }), 422, 'VALIDATION_FAILED');
  assertProblem(await get(me, '/v1/interests/search').query({ page: 2 }), 422, 'VALIDATION_FAILED');
  assertProblem(await request(app).get('/v1/interests/search').set(CLIENT), 401, 'UNAUTHENTICATED');
});

test('search is limited to 120 a minute per account', async () => {
  const target = buildApp();
  const me = await account();
  const other = await account();
  for (let i = 0; i < 120; i += 1) {
    const res = await get(me, '/v1/interests/search', {}, target);
    assert.equal(res.status, 200, `request ${i + 1}: ${res.text}`);
  }
  const limited = await get(me, '/v1/interests/search', {}, target);
  assertProblem(limited, 429, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await get(other, '/v1/interests/search', {}, target)).status, 200, 'another account has its own count');
  assert.equal((await get(me, '/v1/interests/featured', {}, target)).status, 200, 'only search is limited');
});

// ---------------------------------------------------------------------------
// GET /interests/{interestId}
// ---------------------------------------------------------------------------

test('one interest by id; unknown, inactive and malformed ids are 404 INTEREST_NOT_FOUND', async () => {
  const s = await seed();
  const me = await account();
  const res = await get(me, `/v1/interests/${s.daya}`);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Interest', res.body);
  assert.deepEqual(res.body, {
    id: s.daya, kind: 'artist', title: 'Daya', subtitle: null,
    image: { url: `${BASE}/uploads/artists/daya.jpg`, width: 0, height: 0, status: 'ready', blurhash: null },
  });
  const place = await get(me, `/v1/interests/${s.us}`);
  assert.equal(place.body.title, 'United States');
  for (const missing of [s.gone, s.off, `artist_${'0'.repeat(24)}`, `genre_${s.docs.a.daya._id}`, 'int_paradise', 'genre_', s.daya.toUpperCase()]) {
    const r = await get(me, `/v1/interests/${missing}`);
    assertProblem(r, 404, 'INTEREST_NOT_FOUND');
    assertMatchesSpec('Problem', r.body);
  }
  assertProblem(await get(me, `/v1/interests/${'x'.repeat(65)}`), 422, 'VALIDATION_FAILED');
  assertProblem(await request(app).get(`/v1/interests/${s.daya}`).set(CLIENT), 401, 'UNAUTHENTICATED');
});

// ---------------------------------------------------------------------------
// The user's selection
// ---------------------------------------------------------------------------

test('GET /me/interests starts empty, and is private', async () => {
  const me = await account();
  const res = await get(me, '/v1/me/interests');
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('UserInterests', res.body);
  assert.deepEqual(res.body, { data: [], updatedAt: null });
  assert.equal(res.headers['cache-control'], 'private, no-cache');
  assertProblem(await request(app).get('/v1/me/interests').set(CLIENT), 401, 'UNAUTHENTICATED');
});

test('PUT /me/interests replaces the selection in order, ignores duplicates and completes the onboarding step', async () => {
  const s = await seed();
  const me = await account();
  const res = await putAll(me, [s.us, s.daya, s.us, s.pop]);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('UserInterests', res.body);
  assert.deepEqual(ids(res), [s.us, s.daya, s.pop]);
  assert.equal(res.body.updatedAt, new Date(clock.t).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  assert.equal(res.headers['cache-control'], 'private, no-cache');
  assert.deepEqual(await get(me, '/v1/me/interests').then((r) => r.body), res.body);

  const onboarding = (await get(me, '/v1/me/onboarding')).body;
  assert.equal(stepOf(onboarding).status, 'completed');
  assert.equal(stepOf(onboarding).updatedAt, res.body.updatedAt);

  // Replacing again keeps when each remaining interest was first added.
  const firstAdded = new Date(clock.t);
  clock.t += 60000;
  const again = await putAll(me, [s.pop, s.hiphop]);
  assert.deepEqual(ids(again), [s.pop, s.hiphop]);
  const stored = (await User.findById(me.user._id).lean()).interests;
  assert.deepEqual(stored, [{ id: s.pop, addedAt: firstAdded }, { id: s.hiphop, addedAt: new Date(clock.t) }]);
});

test('PUT /me/interests with an empty list clears the selection and still completes the step', async () => {
  const s = await seed();
  const me = await account();
  await putAll(me, [s.pop]);
  const res = await putAll(me, []);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('UserInterests', res.body);
  assert.deepEqual(res.body.data, []);
  assert.equal(stepOf((await get(me, '/v1/me/onboarding')).body).status, 'completed');

  const fresh = await account();
  await putAll(fresh, []);
  assert.equal(stepOf((await get(fresh, '/v1/me/onboarding')).body).status, 'completed', 'Next with nothing chosen');
});

test('"Later" (skipped) still works, and choosing interests afterwards completes the step', async () => {
  const s = await seed();
  const me = await account();
  const skip = await request(app).put('/v1/me/onboarding/steps/interests').set(me.headers).send({ status: 'skipped' });
  assert.equal(skip.status, 200, skip.text);
  assert.equal(stepOf(skip.body).status, 'skipped');
  assert.equal(stepOf((await get(me, '/v1/me/onboarding')).body).status, 'skipped', 'reading the selection changes nothing');
  assert.equal((await addOne(me, s.pop)).status, 204);
  assert.equal(stepOf((await get(me, '/v1/me/onboarding')).body).status, 'completed', 'one interest completes it');
  await removeOne(me, s.pop);
  assert.equal(stepOf((await get(me, '/v1/me/onboarding')).body).status, 'skipped', 'back to what the user marked');
  await putAll(me, []);
  assert.equal(stepOf((await get(me, '/v1/me/onboarding')).body).status, 'completed');
});

test('PUT /me/interests refuses unknown ids all at once and saves nothing', async () => {
  const s = await seed();
  const me = await account();
  await putAll(me, [s.pop]);
  const unknown = `artist_${'a'.repeat(24)}`;
  const res = await putAll(me, [s.daya, s.gone, 'whatever', s.daya, unknown]);
  assertProblem(res, 422, 'INTEREST_NOT_FOUND');
  assertMatchesSpec('Problem', res.body);
  assert.deepEqual(res.body.meta, { unknownIds: [s.gone, 'whatever', unknown] });
  assert.deepEqual(res.body.errors.map((e) => e.field), ['/interestIds/1', '/interestIds/2', '/interestIds/4']);
  assert.deepEqual(ids(await get(me, '/v1/me/interests')), [s.pop], 'the old selection stays');
});

test('PUT /me/interests checks the body and the limit', async () => {
  const s = await seed();
  const me = await account();
  assertProblem(await request(app).put('/v1/me/interests').set(me.headers).send({}), 422, 'VALIDATION_FAILED');
  assertProblem(await request(app).put('/v1/me/interests').set(me.headers).send({ interestIds: [s.pop], extra: 1 }), 422, 'VALIDATION_FAILED');
  assertProblem(await request(app).put('/v1/me/interests').set(me.headers).send({ interestIds: [''] }), 422, 'VALIDATION_FAILED');
  assertProblem(await request(app).put('/v1/me/interests').set(me.headers), 400, 'MALFORMED_REQUEST');
  const tooMany = Array.from({ length: 101 }, (_, i) => `genre_${String(i).padStart(24, '0')}`);
  assertProblem(await putAll(me, tooMany), 422, 'VALIDATION_FAILED');

  // Below the spec's 100 (GET /config's maxInterests decides): more distinct interests than that are refused.
  const small = buildApp({ maxInterests: 2 });
  const capped = await putAll(me, [s.pop, s.jazz, s.daya], small);
  assertProblem(capped, 422, 'INTEREST_LIMIT_EXCEEDED');
  assert.deepEqual(capped.body.meta, { maxInterests: 2 });
  assert.equal((await putAll(me, [s.pop, s.jazz, s.pop], small)).status, 200, 'duplicates do not count');
});

test('the limit is the one GET /config advertises', async () => {
  const me = await account();
  const res = await get(me, '/v1/config');
  assert.equal(res.body.limits.maxInterests, 100);
  assert.equal(spec.components.schemas.UserInterestsReplace.properties.interestIds.maxItems, res.body.limits.maxInterests);
});

test('PUT /me/interests/{id} adds one at the end, idempotently; unknown ids are 404', async () => {
  const s = await seed();
  const me = await account();
  await putAll(me, [s.pop]);
  const added = await addOne(me, s.daya);
  assert.equal(added.status, 204, added.text);
  assert.equal(added.text, '');
  assert.equal((await addOne(me, s.daya)).status, 204);
  assert.deepEqual(ids(await get(me, '/v1/me/interests')), [s.pop, s.daya]);
  const stored = await User.findById(me.user._id).lean();
  assert.equal(stored.interests.length, 2);
  for (const missing of [s.gone, 'nope', `place_${'b'.repeat(24)}`]) assertProblem(await addOne(me, missing), 404, 'INTEREST_NOT_FOUND');
  assert.equal((await User.findById(me.user._id).lean()).interests.length, 2);
});

test('adding one completes the onboarding step', async () => {
  const s = await seed();
  const me = await account();
  assert.equal(stepOf((await get(me, '/v1/me/onboarding')).body).status, 'pending');
  await addOne(me, s.india);
  const step = stepOf((await get(me, '/v1/me/onboarding')).body);
  assert.equal(step.status, 'completed');
  assert.equal(step.updatedAt, new Date(clock.t).toISOString().replace(/\.\d{3}Z$/, 'Z'));
});

test('adding stops at the limit, even with many adds at once; one already chosen is still fine', async () => {
  const s = await seed();
  const me = await account();
  const small = buildApp({ maxInterests: 2 });
  const results = await Promise.all([s.pop, s.jazz, s.daya, s.us, s.india].map((id) => addOne(me, id, small)));
  assert.equal(results.filter((r) => r.status === 204).length, 2);
  for (const r of results.filter((x) => x.status !== 204)) assertProblem(r, 422, 'INTEREST_LIMIT_EXCEEDED');
  const stored = (await User.findById(me.user._id).lean()).interests;
  assert.equal(stored.length, 2);
  assert.equal((await addOne(me, stored[0].id, small)).status, 204, 'already chosen: nothing to add');
  assertProblem(await addOne(me, [s.pop, s.jazz, s.daya].find((id) => !stored.some((e) => e.id === id)), small), 422, 'INTEREST_LIMIT_EXCEEDED');
});

test('DELETE /me/interests/{id} removes one, idempotently, whatever the id', async () => {
  const s = await seed();
  const me = await account();
  await putAll(me, [s.pop, s.daya, s.us]);
  const res = await removeOne(me, s.daya);
  assert.equal(res.status, 204, res.text);
  assert.deepEqual(ids(await get(me, '/v1/me/interests')), [s.pop, s.us]);
  assert.equal((await removeOne(me, s.daya)).status, 204);
  assert.equal((await removeOne(me, 'never-existed')).status, 204);
  assert.equal((await removeOne(me, s.gone)).status, 204);
  assert.deepEqual(ids(await get(me, '/v1/me/interests')), [s.pop, s.us]);
  assertProblem(await request(app).delete(`/v1/me/interests/${s.pop}`).set(CLIENT), 401, 'UNAUTHENTICATED');
});

test('the selection leaves out interests that left the catalog', async () => {
  const s = await seed();
  const me = await account();
  await putAll(me, [s.daya, s.pop, s.us]);
  await Artist.updateOne({ _id: s.docs.a.daya._id }, { $set: { active: false } });
  const res = await get(me, '/v1/me/interests');
  assertMatchesSpec('UserInterests', res.body);
  assert.deepEqual(ids(res), [s.pop, s.us]);
});

test('an account deleted while its session lives gets 401 SESSION_REVOKED', async () => {
  const s = await seed();
  const me = await account();
  await User.deleteOne({ _id: me.user._id });
  assertProblem(await get(me, '/v1/me/interests'), 401, 'SESSION_REVOKED');
  assertProblem(await putAll(me, [s.pop]), 401, 'SESSION_REVOKED');
  assertProblem(await addOne(me, s.pop), 401, 'SESSION_REVOKED');
  assertProblem(await removeOne(me, s.pop), 401, 'SESSION_REVOKED');
});

test('guests choose interests too: kept on the guest, never in users, onboarding unchanged', async () => {
  const s = await seed();
  const visitor = await guest();
  const res = await putAll(visitor, [s.jazz, s.coastin]);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('UserInterests', res.body);
  assert.equal((await addOne(visitor, s.us)).status, 204);
  assert.equal((await removeOne(visitor, s.jazz)).status, 204);
  const mine = await get(visitor, '/v1/me/interests');
  assert.deepEqual(ids(mine), [s.coastin, s.us]);
  const stored = await GuestAccount.findById(visitor.id).lean();
  assert.deepEqual(stored.interests.map((e) => e.id), [s.coastin, s.us]);
  assert.equal(await User.countDocuments(), 0);
  const me = (await get(visitor, '/v1/me')).body;
  assert.equal(me.accountType, 'guest');
  assert.deepEqual(me.onboarding.steps.map((st) => st.step), ['date_of_birth']);
});

test('accounts and guests that never chose anything have no interests field', async () => {
  await seed();
  const me = await account();
  await get(me, '/v1/me');
  const visitor = await guest();
  assert.equal(Object.hasOwn(await User.findById(me.user._id).lean(), 'interests'), false);
  assert.equal(Object.hasOwn(await GuestAccount.findById(visitor.id).lean(), 'interests'), false);
});

// ---------------------------------------------------------------------------
// The catalog module
// ---------------------------------------------------------------------------

test('the catalog keeps its snapshot for ttlMs, and never writes to the source collections', async () => {
  const s = await seed();
  const t = { now: 0 };
  const catalog = createCatalog({ config: { ...config, apiBaseUrl: BASE }, ttlMs: 60000, now: () => t.now });
  assert.equal((await catalog.get(s.pop)).title, 'Pop');
  const before = JSON.stringify(await Promise.all([Genre, Artist, Country].map((m) => m.find().sort({ _id: 1 }).lean())));
  await Genre.updateOne({ _id: s.docs.g.pop._id }, { $set: { name: 'Pop Music' } });
  t.now = 59999;
  assert.equal((await catalog.get(s.pop)).title, 'Pop', 'still the snapshot');
  t.now = 60000;
  assert.equal((await catalog.get(s.pop)).title, 'Pop Music', 'reloaded');
  await Genre.updateOne({ _id: s.docs.g.pop._id }, { $set: { name: 'Pop' } });
  t.now = 1000;
  assert.equal((await catalog.get(s.pop)).title, 'Pop', 'a clock that went back reloads too');
  t.now = 60000;
  const service = createInterestsService({ catalog, now: clock.now });
  const me = await account();
  await service.replaceMine({ userId: String(me.user._id), accountType: 'user' }, [s.pop, s.daya]);
  await service.addMine({ userId: String(me.user._id), accountType: 'user' }, s.us);
  const after = JSON.stringify(await Promise.all([Genre, Artist, Country].map((m) => m.find().sort({ _id: 1 }).lean())));
  assert.equal(after, before, 'choosing interests changes no catalog document (genre counters included)');
});

test('without API_BASE_URL a stored file name has no image; absolute URLs still do', async () => {
  const s = await seed();
  const catalog = createCatalog({ config: { ...config, apiBaseUrl: undefined }, ttlMs: 0 });
  assert.equal((await catalog.get(s.daya)).image, null);
  assert.equal((await catalog.get(s.pop)).image.url, 'https://cdn.example.com/pop.png');
});
