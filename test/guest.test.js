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
const { createChallengeService } = require('../src/modules/challenges/service');
const { createAuthService } = require('../src/modules/auth/service');
const { createAuthRouter } = require('../src/modules/auth/routes');
const passwords = require('../src/lib/passwords');
const { checkDateOfBirth, localToday } = require('../src/lib/dateOfBirth');
const { createTokens } = require('../src/lib/tokens');
const { config } = require('../src/config');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { createMemorySmsProvider } = require('../src/providers/sms/memory');
const GuestAccount = require('../models/GuestAccount');
const Session = require('../models/Session');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem } = require('./support/api');

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'Correct-Horse-9';

const clock = { t: 0, now: () => clock.t };
const mail = createMemoryEmailProvider();
const sms = createMemorySmsProvider();
const silent = { debug() {}, info() {}, warn() {}, error() {} };

const challenges = createChallengeService({ now: clock.now, emailProvider: mail, smsProvider: sms, logger: silent });
const service = createAuthService({ now: clock.now, challenges, emailProvider: mail, logger: silent });
const app = createApp({ trustProxy: 1, authRouter: createAuthRouter({ service }) });

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
const ajv = new Ajv2020({ strict: false, logger: false });
const assertMatchesSpec = (name, value) => assert.equal(
  ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value),
  true,
  `${name}: ${JSON.stringify(ajv.errors)}`,
);

before(async () => {
  await db.connect();
  await passwords.dummyHash();
});
beforeEach(async () => {
  await db.clear();
  mail.clear();
  clock.t = Date.now();
});
after(db.disconnect);

let counter = 0;
const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
function newClient(extraDevice = {}) {
  counter += 1;
  const installationId = crypto.randomUUID();
  return {
    installationId,
    headers: {
      'X-Client-Platform': 'ios',
      'X-Client-Version': '1.4.0',
      'X-Installation-Id': installationId,
      'X-Forwarded-For': ipFor(counter),
    },
    device: { installationId, platform: 'ios', appVersion: '1.4.0+42', model: 'iPhone 16', ...extraDevice },
  };
}

const post = (client, path, body, extra = {}) => request(app).post(path).set({ ...client.headers, ...extra }).send(body);
const get = (client, path, extra = {}) => request(app).get(path).set({ ...client.headers, ...extra });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const startGuest = (client, body = {}) => post(client, '/v1/auth/guest', { device: client.device, dateOfBirth: '2000-05-17', ...body });

/** A date `years` years before today (UTC), as YYYY-MM-DD. */
const yearsAgo = (years, dayOffset = 0) => {
  const d = new Date(clock.t + dayOffset * DAY);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Starting a guest session
// ---------------------------------------------------------------------------

test('a new install becomes a guest: 201, a guest session, nothing in users', async () => {
  const client = newClient();
  const res = await startGuest(client, { preferredLanguage: 'es' });
  assert.equal(res.status, 201, res.text);
  assertMatchesSpec('Session', res.body);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.isNewUser, true);
  assert.equal(res.body.session.signInMethod, 'guest');
  const { user } = res.body;
  assert.equal(user.accountType, 'guest');
  assert.equal(user.dateOfBirth, '2000-05-17');
  assert.equal(user.preferredLanguage, 'es');
  assert.equal(user.email, null);
  assert.deepEqual(user.loginMethods, []);
  assert.equal(user.onboarding.status, 'completed');

  assert.equal(await User.countDocuments(), 0);
  const guests = await GuestAccount.find({}).lean();
  assert.equal(guests.length, 1);
  assert.equal(String(guests[0]._id), user.id);
  assert.equal(guests[0].installationId, client.installationId);
  const session = await Session.findById(res.body.session.id).lean();
  assert.equal(session.accountType, 'guest');
});

test('the same install gets the same guest back (200); another install gets its own', async () => {
  const client = newClient();
  const first = await startGuest(client);
  const again = await startGuest(client, { dateOfBirth: '1999-01-01' });
  assert.equal(again.status, 200, again.text);
  assertMatchesSpec('Session', again.body);
  assert.equal(again.body.isNewUser, false);
  assert.equal(again.body.user.id, first.body.user.id);
  assert.equal(again.body.user.dateOfBirth, '2000-05-17', 'the stored birthday stays');
  assert.notEqual(again.body.tokens.refreshToken, first.body.tokens.refreshToken);

  const other = await startGuest(newClient());
  assert.equal(other.status, 201);
  assert.notEqual(other.body.user.id, first.body.user.id);
  assert.equal(await GuestAccount.countDocuments(), 2);
});

test('first requests from one install at the same moment still make one guest', async () => {
  const client = newClient();
  const results = await Promise.all(Array.from({ length: 5 }, () => startGuest(client)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map((r) => r.body.user.id)).size, 1);
  assert.equal(await GuestAccount.countDocuments(), 1);
});

test('the date of birth must be real, not in the future, and at least 13 and at most 120 years ago', async () => {
  assertProblem(await startGuest(newClient(), { dateOfBirth: '2001-02-29' }), 422, 'DATE_OF_BIRTH_INVALID');
  assertProblem(await startGuest(newClient(), { dateOfBirth: yearsAgo(0, 2) }), 422, 'DATE_OF_BIRTH_INVALID');
  assertProblem(await startGuest(newClient(), { dateOfBirth: yearsAgo(121) }), 422, 'DATE_OF_BIRTH_INVALID');
  const young = await startGuest(newClient(), { dateOfBirth: yearsAgo(13, 2) });
  assertProblem(young, 422, 'AGE_REQUIREMENT_NOT_MET');
  assert.equal(young.body.meta.minimumAge, 13);
  assert.equal((await startGuest(newClient(), { dateOfBirth: yearsAgo(13, -2) })).status, 201);
  assert.equal(await GuestAccount.countDocuments(), 1);
});

test('age is counted on the person\'s own date (device.timeZone)', () => {
  // 10:30 UTC on 1 March 2026 is already 2 March in Kiritimati (UTC+14), and 00:30 on 1 March in Honolulu (UTC-10).
  const at = Date.UTC(2026, 2, 1, 10, 30);
  assert.equal(localToday(at, 'Pacific/Kiritimati'), '2026-03-02');
  assert.equal(localToday(at, 'Pacific/Honolulu'), '2026-03-01');
  assert.equal(localToday(at, 'Not/AZone'), '2026-03-01', 'an unknown zone counts as UTC');
  // Born 2 March 2013: 13 today in Kiritimati, still 12 in Honolulu.
  assert.equal(checkDateOfBirth('2013-03-02', { at, timeZone: 'Pacific/Kiritimati' }), '2013-03-02');
  assert.throws(() => checkDateOfBirth('2013-03-02', { at, timeZone: 'Pacific/Honolulu' }), (err) => err.code === 'AGE_REQUIREMENT_NOT_MET');
  // A 29 February birthday counts from 1 March in other years.
  assert.throws(() => checkDateOfBirth('2012-02-29', { at: Date.UTC(2025, 1, 28, 12) }), (err) => err.code === 'AGE_REQUIREMENT_NOT_MET');
  assert.equal(checkDateOfBirth('2012-02-29', { at: Date.UTC(2025, 2, 1, 12) }), '2012-02-29');
});

test('the device must be the install in the header', async () => {
  const client = newClient();
  const res = await post(client, '/v1/auth/guest', {
    device: { ...client.device, installationId: crypto.randomUUID() }, dateOfBirth: '2000-05-17',
  });
  assertProblem(res, 422, 'VALIDATION_FAILED');
});

// ---------------------------------------------------------------------------
// What a guest's token can do
// ---------------------------------------------------------------------------

test('a guest token carries the guest type; account-only endpoints answer 403 GUEST_NOT_ALLOWED', async () => {
  const client = newClient();
  const { body } = await startGuest(client);
  const claims = await createTokens({ jwt: config.jwt }).verifyAccessToken(body.tokens.accessToken);
  assert.equal(claims.accountType, 'guest');
  assert.equal(claims.userId, body.user.id);

  assertProblem(await get(client, '/v1/me/sessions', bearer(body.tokens.accessToken)), 403, 'GUEST_NOT_ALLOWED');
  const del = await request(app).delete('/v1/me/sessions').set({ ...client.headers, ...bearer(body.tokens.accessToken) });
  assertProblem(del, 403, 'GUEST_NOT_ALLOWED');
});

test('a guest can sign out its own session by id (the spec lists no 403 there)', async () => {
  const client = newClient();
  const { body } = await startGuest(client);
  const del = await request(app).delete(`/v1/me/sessions/${body.session.id}`).set({ ...client.headers, ...bearer(body.tokens.accessToken) });
  assert.equal(del.status, 204, del.text);
  assertProblem(await post(client, '/v1/auth/token/refresh', { refreshToken: body.tokens.refreshToken }), 401, 'SESSION_REVOKED');
});

test('a guest can refresh (which keeps the guest alive) and log out', async () => {
  const client = newClient();
  const { body } = await startGuest(client);
  const before = (await GuestAccount.findById(body.user.id).lean()).purgeAt.getTime();
  await new Promise((resolve) => { setTimeout(resolve, 1100); });

  const refreshed = await post(client, '/v1/auth/token/refresh', { refreshToken: body.tokens.refreshToken });
  assert.equal(refreshed.status, 200, refreshed.text);
  const claims = await createTokens({ jwt: config.jwt }).verifyAccessToken(refreshed.body.accessToken);
  assert.equal(claims.accountType, 'guest', 'a refreshed token is still a guest token');
  const after = (await GuestAccount.findById(body.user.id).lean()).purgeAt.getTime();
  assert.ok(after > before, 'deletion moved later');

  const out = await post(client, '/v1/auth/logout', { refreshToken: refreshed.body.refreshToken }, bearer(refreshed.body.accessToken));
  assert.equal(out.status, 204);
  assertProblem(await post(client, '/v1/auth/token/refresh', { refreshToken: refreshed.body.refreshToken }), 401, 'SESSION_REVOKED');
});

test('once the guest is deleted, its refresh token stops working', async () => {
  const client = newClient();
  const { body } = await startGuest(client);
  await GuestAccount.deleteOne({ _id: body.user.id });
  assertProblem(await post(client, '/v1/auth/token/refresh', { refreshToken: body.tokens.refreshToken }), 401, 'REFRESH_TOKEN_INVALID');
});

test('a guest is deleted 180 days after it was last active (TTL index)', async () => {
  const indexes = await GuestAccount.collection.indexes();
  const ttl = indexes.find((i) => i.key.purgeAt === 1);
  assert.equal(ttl.expireAfterSeconds, 0);
  const client = newClient();
  const { body } = await startGuest(client);
  const guest = await GuestAccount.findById(body.user.id).lean();
  const days = (guest.purgeAt.getTime() - guest.lastActiveAt.getTime()) / DAY;
  assert.equal(days, 180);
});

// ---------------------------------------------------------------------------
// Guest → account
// ---------------------------------------------------------------------------

async function signupToken(client, email) {
  const start = await post(client, '/v1/auth/signup/email', { email });
  assert.equal(start.status, 202, start.text);
  const verify = await post(client, `/v1/auth/challenges/${start.body.id}/verify`, { code: mail.lastCodeFor(email) });
  assert.equal(verify.status, 200, verify.text);
  return verify.body.signupToken;
}

test('signing up with a guest token moves the guest over and retires it', async () => {
  const client = newClient();
  const guest = (await startGuest(client, { preferredLanguage: 'hi' })).body;
  const token = await signupToken(client, 'from.guest@example.com');

  const done = await post(client, '/v1/auth/signup/complete',
    { signupToken: token, password: PASSWORD, device: client.device }, bearer(guest.tokens.accessToken));
  assert.equal(done.status, 201, done.text);
  assertMatchesSpec('Session', done.body);
  assert.equal(done.body.user.accountType, 'user');
  assert.equal(done.body.user.dateOfBirth, '2000-05-17');
  assert.equal(done.body.user.preferredLanguage, 'hi');
  assert.notEqual(done.body.user.id, guest.user.id);

  assert.equal(await GuestAccount.countDocuments(), 0, 'the guest is gone');
  assertProblem(await post(client, '/v1/auth/token/refresh', { refreshToken: guest.tokens.refreshToken }), 401, 'SESSION_REVOKED');
  assert.equal((await get(client, '/v1/me/sessions', bearer(done.body.tokens.accessToken))).status, 200, 'the new account works');
});

test('an expired guest token at sign-up is refused before anything happens; refreshed, the guest moves over', async () => {
  const client = newClient();
  const guest = (await startGuest(client, { preferredLanguage: 'hi' })).body;
  // The same guest's token as it is 16 minutes later (access tokens live 15 minutes).
  const later = createTokens({ jwt: config.jwt, now: () => Date.now() - 16 * 60 * 1000 });
  const { token: expired } = await later.signAccessToken({ userId: guest.user.id, sessionId: guest.session.id, accountType: 'guest' });
  const token = await signupToken(client, 'late.guest@example.com');
  const body = { signupToken: token, password: PASSWORD, device: client.device };

  assertProblem(await post(client, '/v1/auth/signup/complete', body, bearer(expired)), 401, 'TOKEN_EXPIRED');
  assert.equal(await User.countDocuments(), 0, 'no account yet');

  const refreshed = await post(client, '/v1/auth/token/refresh', { refreshToken: guest.tokens.refreshToken });
  assert.equal(refreshed.status, 200, refreshed.text);
  const done = await post(client, '/v1/auth/signup/complete', body, bearer(refreshed.body.accessToken));
  assert.equal(done.status, 201, done.text);
  assert.equal(done.body.user.dateOfBirth, '2000-05-17');
  assert.equal(await GuestAccount.countDocuments(), 0);
});

test('a revoked guest token at sign-up is ignored: the sign-up goes on without it', async () => {
  const client = newClient();
  const guest = (await startGuest(client)).body;
  await post(client, '/v1/auth/logout', { refreshToken: guest.tokens.refreshToken }, bearer(guest.tokens.accessToken));
  const done = await post(client, '/v1/auth/signup/complete',
    { signupToken: await signupToken(client, 'gone.guest@example.com'), password: PASSWORD, device: client.device },
    bearer(guest.tokens.accessToken));
  assert.equal(done.status, 201, done.text);
  assert.equal(done.body.user.dateOfBirth, null);
});

test('a guest token from another install does not move that install\'s guest', async () => {
  const a = newClient();
  const b = newClient();
  const guestA = (await startGuest(a, { dateOfBirth: '1990-01-02' })).body;
  const done = await post(b, '/v1/auth/signup/complete',
    { signupToken: await signupToken(b, 'b@example.com'), password: PASSWORD, device: b.device }, bearer(guestA.tokens.accessToken));
  assert.equal(done.status, 201, done.text);
  assert.equal(done.body.user.dateOfBirth, null);
  assert.equal(await GuestAccount.countDocuments({ _id: guestA.user.id }), 1, 'install A keeps its guest');
  assert.equal((await post(a, '/v1/auth/token/refresh', { refreshToken: guestA.tokens.refreshToken })).status, 200);
});

test('repeating a guest\'s sign-up with the same Idempotency-Key replays it, although the guest session has ended', async () => {
  const client = newClient();
  const guest = (await startGuest(client)).body;
  const body = { signupToken: await signupToken(client, 'repeat.guest@example.com'), password: PASSWORD, device: client.device };
  const headers = { ...bearer(guest.tokens.accessToken), 'Idempotency-Key': crypto.randomUUID() };
  const first = await post(client, '/v1/auth/signup/complete', body, headers);
  assert.equal(first.status, 201, first.text);
  const again = await post(client, '/v1/auth/signup/complete', body, headers);
  assert.equal(again.status, 201, again.text);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.equal(again.body.user.id, first.body.user.id);
});

test('a language sent at sign-up wins over the guest\'s', async () => {
  const client = newClient();
  const guest = (await startGuest(client, { preferredLanguage: 'hi' })).body;
  const token = await signupToken(client, 'lang@example.com');
  const done = await post(client, '/v1/auth/signup/complete',
    { signupToken: token, password: PASSWORD, device: client.device, preferredLanguage: 'fr' }, bearer(guest.tokens.accessToken));
  assert.equal(done.body.user.preferredLanguage, 'fr');
});

test('sign-up without a guest token is unchanged; with a full account\'s token nothing moves', async () => {
  const client = newClient();
  const plain = await post(client, '/v1/auth/signup/complete',
    { signupToken: await signupToken(client, 'plain@example.com'), password: PASSWORD, device: client.device });
  assert.equal(plain.status, 201, plain.text);
  assert.equal(plain.body.user.dateOfBirth, null);

  const other = newClient();
  const withUserToken = await post(other, '/v1/auth/signup/complete',
    { signupToken: await signupToken(other, 'second@example.com'), password: PASSWORD, device: other.device },
    bearer(plain.body.tokens.accessToken));
  assert.equal(withUserToken.status, 201, withUserToken.text);
  assert.equal(withUserToken.body.user.dateOfBirth, null);
  assert.equal((await get(client, '/v1/me/sessions', bearer(plain.body.tokens.accessToken))).status, 200, 'the other account is untouched');
});
