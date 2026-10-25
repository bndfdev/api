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
const { createMeService, cleanLocation } = require('../src/modules/me/service');
const { createMeRouter } = require('../src/modules/me/routes');
const { createNotificationSettingsService, SWITCHES } = require('../src/modules/notificationSettings/service');
const { createNotificationSettingsRouter } = require('../src/modules/notificationSettings/routes');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const clock = { t: Date.now(), now: () => clock.t };

const app = createApp({
  trustProxy: 1,
  meRouter: createMeRouter({ me: createMeService({ now: clock.now }) }),
  notificationSettingsRouter: createNotificationSettingsRouter({ service: createNotificationSettingsService({ now: clock.now }) }),
});

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

async function account(extra = {}) {
  return signIn(await makeUser({ password: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', emailVerified: true, ...extra }));
}

async function guest() {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01', preferredLanguage: 'en' });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.user.id, headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

const getMe = (who, extra = {}) => request(app).get('/v1/me').set({ ...who.headers, ...extra });
const patchMe = (who, body, extra = {}) => request(app).patch('/v1/me')
  .set({ ...who.headers, 'Content-Type': 'application/merge-patch+json', ...extra }).send(JSON.stringify(body));
const getSettings = (who) => request(app).get('/v1/me/notification-settings').set(who.headers);
const patchSettings = (who, body, type = 'application/json') => request(app).patch('/v1/me/notification-settings')
  .set({ ...who.headers, 'Content-Type': type }).send(JSON.stringify(body));
const stored = async (who) => User.findById(who.user._id).lean();
const ALL_ON = Object.freeze(Object.fromEntries(SWITCHES.map((key) => [key, true])));
const char = (...codePoints) => String.fromCodePoint(...codePoints);

// ---------------------------------------------------------------------------
// User: storyTranslation, location, accountPrivacy
// ---------------------------------------------------------------------------

test('every User carries the settings with their defaults, accounts and guests alike', async () => {
  const me = await account();
  const res = await getMe(me);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('User', res.body);
  assert.equal(res.body.storyTranslation, false);
  assert.equal(res.body.location, null);
  assert.equal(res.body.accountPrivacy, 'public');
  const g = await guest();
  const mine = (await getMe(g)).body;
  assertMatchesSpec('User', mine);
  assert.deepEqual([mine.storyTranslation, mine.location, mine.accountPrivacy], [false, null, 'public']);
  const doc = await stored(me);
  for (const field of ['storyTranslation', 'location', 'accountPrivacy', 'notificationSettings']) {
    assert.equal(Object.hasOwn(doc, field), false, `${field} is not written until the user sets it`);
  }
});

test('Story Translation and Account Privacy are saved and read back', async () => {
  const me = await account();
  let res = await patchMe(me, { storyTranslation: true, accountPrivacy: 'followers' });
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('User', res.body);
  assert.equal(res.body.storyTranslation, true);
  assert.equal(res.body.accountPrivacy, 'followers');
  assert.deepEqual([(await stored(me)).storyTranslation, (await stored(me)).accountPrivacy], [true, 'followers']);
  assert.equal((await getMe(me)).body.accountPrivacy, 'followers');
  res = await patchMe(me, { storyTranslation: false });
  assert.equal(res.body.storyTranslation, false);
  assert.equal(res.body.accountPrivacy, 'followers', 'fields not sent keep their value');
  res = await patchMe(me, { accountPrivacy: 'public' });
  assert.equal(res.body.accountPrivacy, 'public');
});

test('accountPrivacy is public or followers; storyTranslation is a boolean (validator)', async () => {
  const me = await account();
  for (const body of [{ accountPrivacy: 'private' }, { accountPrivacy: null }, { accountPrivacy: 'Followers' },
    { storyTranslation: 'yes' }, { storyTranslation: null }, { storyTranslation: 1 }]) {
    assertProblem(await patchMe(me, body), 422, 'VALIDATION_FAILED');
  }
  const doc = await stored(me);
  assert.equal(Object.hasOwn(doc, 'accountPrivacy') || Object.hasOwn(doc, 'storyTranslation'), false, 'nothing saved');
});

test('location is trimmed, inner whitespace collapsed, and null clears it', async () => {
  const me = await account();
  let res = await patchMe(me, { location: '   Seattle,   WA  ' });
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('User', res.body);
  assert.equal(res.body.location, 'Seattle, WA');
  assert.equal((await stored(me)).location, 'Seattle, WA');
  res = await patchMe(me, { location: `Tokyo ${char(0x1F5FC)} ${char(0x1F1EF, 0x1F1F5)}` });
  assert.equal(res.body.location, `Tokyo ${char(0x1F5FC)} ${char(0x1F1EF, 0x1F1F5)}`, 'emoji and flags are fine');
  res = await patchMe(me, { location: null });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.location, null);
  assert.equal(Object.hasOwn(await stored(me), 'location'), false, 'cleared means removed');
  assert.equal((await patchMe(me, { location: null })).status, 200, 'clearing twice is fine');
});

test('location: 1 to 100 characters after trimming, counted as characters, else LOCATION_INVALID', async () => {
  const me = await account();
  const hundred = 'a'.repeat(100);
  assert.equal((await patchMe(me, { location: `  ${hundred}  ` })).body.location, hundred, 'trimmed before counting');
  const accents = char(0xE9).repeat(100);
  assert.equal((await patchMe(me, { location: accents })).body.location, accents);
  const emoji = char(0x1F5FC).repeat(100);
  assert.equal((await patchMe(me, { location: emoji })).body.location, emoji, '100 emoji are 100 characters');
  for (const location of ['', '   ', 'a'.repeat(101), char(0x1F5FC).repeat(101)]) {
    const res = await patchMe(me, { location });
    assertProblem(res, 422, 'LOCATION_INVALID');
    assertMatchesSpec('Problem', res.body);
    assert.equal(res.body.errors[0].field, '/location');
  }
  assert.equal((await stored(me)).location, emoji, 'a refused location changes nothing');
  assertProblem(await patchMe(me, { location: 'a'.repeat(201) }), 422, 'VALIDATION_FAILED');
  assertProblem(await patchMe(me, { location: 42 }), 422, 'VALIDATION_FAILED');
});

test('location: control, zero-width and direction characters are LOCATION_INVALID', async () => {
  const me = await account();
  const refused = [
    char(0x09), char(0x0A), char(0x00), char(0x7F), // tab, line feed, null, delete
    char(0x200B), char(0x200C), char(0x200D), char(0x2060), char(0xFEFF), // zero-width
    char(0x202E), char(0x200F), char(0x2066), // direction override, mark, isolate
    char(0x00AD), char(0x3164), // soft hyphen, Hangul filler
  ];
  for (const bad of refused) {
    assertProblem(await patchMe(me, { location: `Seattle${bad}WA` }), 422, 'LOCATION_INVALID');
    assertProblem(await patchMe(me, { location: `Seattle${bad}` }), 422, 'LOCATION_INVALID');
  }
  assert.throws(() => cleanLocation(`x${char(0xD800)}`), (err) => err.code === 'LOCATION_INVALID', 'lone surrogate');
  assert.equal(cleanLocation(`Cafe${char(0x301)} Lane`), `Caf${char(0xE9)} Lane`, 'stored in Unicode NFC');
  assert.equal(Object.hasOwn(await stored(me), 'location'), false);
});

test('guests cannot change the settings', async () => {
  const g = await guest();
  for (const body of [{ location: 'Seattle' }, { storyTranslation: true }, { accountPrivacy: 'followers' }]) {
    assertProblem(await patchMe(g, body), 403, 'GUEST_NOT_ALLOWED');
  }
});

test('If-Match covers the settings: a change on another device makes the copy stale', async () => {
  const me = await account();
  const first = await getMe(me);
  assert.equal((await patchMe(me, { location: 'Elsewhere' })).status, 200);
  assertProblem(await patchMe(me, { name: 'Mine' }, { 'If-Match': first.headers.etag }), 412, 'PRECONDITION_FAILED');
  const second = await getMe(me);
  assert.equal((await patchMe(me, { accountPrivacy: 'followers' })).status, 200);
  assertProblem(await patchMe(me, { storyTranslation: true }, { 'If-Match': second.headers.etag }), 412, 'PRECONDITION_FAILED');
  const fresh = await getMe(me);
  assert.equal((await patchMe(me, { storyTranslation: true }, { 'If-Match': fresh.headers.etag })).status, 200);
});

test('stored values not in the spec\'s shape read as the defaults', async () => {
  const me = await account();
  await User.collection.updateOne({ _id: me.user._id }, {
    $set: { location: 'x'.repeat(150), accountPrivacy: 'secret', storyTranslation: 'yes' },
  });
  const res = await getMe(me);
  assertMatchesSpec('User', res.body);
  assert.deepEqual([res.body.storyTranslation, res.body.location, res.body.accountPrivacy], [false, null, 'public']);
  await User.collection.updateOne({ _id: me.user._id }, { $set: { location: '   ' } });
  assert.equal((await getMe(me)).body.location, null);
});

// ---------------------------------------------------------------------------
// /me/notification-settings
// ---------------------------------------------------------------------------

test('a user who never saved the switches gets them all on, privately', async () => {
  const me = await account();
  const res = await getSettings(me);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('NotificationSettings', res.body);
  assert.deepEqual(res.body, ALL_ON);
  assert.deepEqual(Object.keys(res.body), [...SWITCHES], 'in the order of the screen');
  assert.equal(res.headers['cache-control'], 'private, no-cache');
  assert.equal(Object.hasOwn(await stored(me), 'notificationSettings'), false, 'reading writes nothing');
});

test('PATCH changes only the switches sent and answers with all of them', async () => {
  const me = await account();
  clock.t += 1000;
  let res = await patchSettings(me, { followRequests: false });
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('NotificationSettings', res.body);
  assert.deepEqual(res.body, { ...ALL_ON, followRequests: false });
  res = await patchSettings(me, { contributorMetrics: false, newOrTrendingContent: false }, 'application/merge-patch+json');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { ...ALL_ON, followRequests: false, contributorMetrics: false, newOrTrendingContent: false });
  res = await patchSettings(me, { followRequests: true });
  assert.deepEqual(res.body, { ...ALL_ON, contributorMetrics: false, newOrTrendingContent: false });
  assert.deepEqual((await getSettings(me)).body, res.body);
  const { notificationSettings } = await stored(me);
  assert.deepEqual(Object.keys(notificationSettings).sort(), ['contributorMetrics', 'followRequests', 'newOrTrendingContent', 'updatedAt']);
  assert.equal(notificationSettings.updatedAt.getTime(), clock.t);
});

test('every switch can be turned off and on again', async () => {
  const me = await account();
  for (const key of SWITCHES) {
    assert.equal((await patchSettings(me, { [key]: false })).body[key], false, key);
  }
  assert.deepEqual((await getSettings(me)).body, Object.fromEntries(SWITCHES.map((key) => [key, false])));
  assert.deepEqual((await patchSettings(me, ALL_ON)).body, ALL_ON);
});

test('PATCH needs at least one known switch, each a boolean (validator)', async () => {
  const me = await account();
  for (const body of [{}, { likes: false }, { likesAndComments: 'false' }, { likesAndComments: null }, { followRequests: false, extra: true }]) {
    assertProblem(await patchSettings(me, body), 422, 'VALIDATION_FAILED');
  }
  assert.equal(Object.hasOwn(await stored(me), 'notificationSettings'), false);
});

test('notification settings: a session is needed, guests are refused, a deleted account is signed out', async () => {
  assertProblem(await request(app).get('/v1/me/notification-settings').set(CLIENT), 401, 'UNAUTHENTICATED');
  assertProblem(await request(app).patch('/v1/me/notification-settings').set(CLIENT).send({ followRequests: false }), 401, 'UNAUTHENTICATED');
  const g = await guest();
  assertProblem(await getSettings(g), 403, 'GUEST_NOT_ALLOWED');
  assertProblem(await patchSettings(g, { followRequests: false }), 403, 'GUEST_NOT_ALLOWED');
  const me = await account();
  await User.deleteOne({ _id: me.user._id });
  assertProblem(await getSettings(me), 401, 'SESSION_REVOKED');
  assertProblem(await patchSettings(me, { followRequests: false }), 401, 'SESSION_REVOKED');
});

test('one user\'s switches never touch another\'s', async () => {
  const me = await account();
  const other = await account();
  await patchSettings(me, { likesAndComments: false });
  assert.deepEqual((await getSettings(other)).body, ALL_ON);
});
