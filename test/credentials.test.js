process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const request = require('supertest');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { createApp } = require('../src/app');
const { createAuthService } = require('../src/modules/auth/service');
const { createAuthRouter } = require('../src/modules/auth/routes');
const { createChallengeService } = require('../src/modules/challenges/service');
const { createCredentialsService } = require('../src/modules/credentials/service');
const { createCredentialsRouter } = require('../src/modules/credentials/routes');
const { createReauthTokenService } = require('../src/modules/reauthTokens/service');
const sessionService = require('../src/modules/sessions/service');
const passwords = require('../src/lib/passwords');
const { sha256 } = require('../src/lib/secrets');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { NOTICES } = require('../src/providers/messages');
const ReauthToken = require('../models/ReauthToken');
const Session = require('../models/Session');
const User = require('../models/User');
const db = require('./support/db');
const { CLIENT, DEVICE, signIn, assertProblem } = require('./support/api');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const OLD_PASSWORD = 'Correct-Horse-9';
const NEW_PASSWORD = 'Battery-Staple-7!';

// A fake clock for the services (reauth tokens, the lock). Sessions and access tokens use the real clock.
const clock = { t: 0, now: () => clock.t, advance(ms) { clock.t += ms; } };
const notices = createMemoryEmailProvider();
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const reauthTokens = createReauthTokenService({ now: clock.now });

function buildApp(deps = {}) {
  const credentials = createCredentialsService({ now: clock.now, reauthTokens, emailProvider: notices, logger: silent, ...deps });
  const challenges = createChallengeService({ now: clock.now, emailProvider: createMemoryEmailProvider(), logger: silent });
  const auth = createAuthService({ now: clock.now, challenges, emailProvider: notices, logger: silent });
  return createApp({
    trustProxy: 1,
    authRouter: createAuthRouter({ service: auth }),
    credentialsRouter: createCredentialsRouter({ service: credentials }),
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
/** A problem with this status and code, in the spec's `Problem` shape. */
function assertSpecProblem(res, status, code) {
  assertProblem(res, status, code);
  assertMatchesSpec('Problem', res.body);
}

before(async () => {
  await db.connect();
  await passwords.dummyHash();
});
beforeEach(async () => {
  await db.clear();
  notices.clear();
  clock.t = Date.now();
});
after(db.disconnect);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
const uniqueEmail = () => `change${(counter += 1)}@example.com`;
const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

/** An account with a password, straight in the database. */
async function makeAccount({ email = uniqueEmail(), password = OLD_PASSWORD, hash } = {}) {
  const stored = hash ?? await passwords.hash(password);
  const user = await User.create({ email, password: stored, passwordAlgo: stored.startsWith('$argon2id$') ? 'argon2id' : 'bcrypt' });
  return { user, email };
}

/** An account with no password (social-only): no `password` field at all. */
async function makeSocialOnly({ email = uniqueEmail() } = {}) {
  const { insertedId } = await User.collection.insertOne({ email, createdAt: new Date() });
  return { user: await User.findById(insertedId).lean(), email };
}

/** A guest's session: a guest id that is not a user, with `accountType: guest`. */
async function guestHeaders() {
  const installationId = crypto.randomUUID();
  const { tokens } = await sessionService.createSession({
    userId: String(new mongoose.Types.ObjectId()), signInMethod: 'guest', device: DEVICE, installationId, accountType: 'guest',
  });
  return { ...CLIENT, 'X-Installation-Id': installationId, Authorization: `Bearer ${tokens.accessToken}` };
}

const reauth = (headers, body) => request(app).post('/v1/auth/reauthenticate').set(headers).send(body);
const changePassword = (headers, body, extra = {}) => request(app).put('/v1/me/password').set({ ...headers, ...extra }).send(body);
const listSessions = (headers) => request(app).get('/v1/me/sessions').set(headers);
function login(email, password) {
  counter += 1;
  const installationId = crypto.randomUUID();
  return request(app).post('/v1/auth/login')
    .set({ ...CLIENT, 'X-Installation-Id': installationId, 'X-Forwarded-For': ipFor(counter) })
    .send({ email, password, device: { ...DEVICE, installationId } });
}
const storedUser = (user) => User.findById(user._id).lean();
/** A reauth token for this signed-in device, as POST /auth/reauthenticate would issue it (for accounts that cannot get one over HTTP yet). */
const issueReauth = (signedIn) => reauthTokens.issue({ userId: String(signedIn.user._id), sessionId: signedIn.session.id });
/** Let the not-awaited notice go out. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// POST /auth/reauthenticate
// ---------------------------------------------------------------------------

test('reauthenticate: the right password gives a 5-minute reauthToken, stored only as a hash', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const res = await reauth(me.headers, { password: OLD_PASSWORD });
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('ReauthToken', res.body);
  assert.deepEqual(Object.keys(res.body).sort(), ['expiresAt', 'reauthToken']);
  assert.match(res.body.reauthToken, /^rat_[A-Za-z0-9_-]{43}$/);
  const expected = new Date(Math.floor(clock.t / SECOND) * SECOND + 5 * MINUTE).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.equal(res.body.expiresAt, expected, 'valid for 5 minutes');
  assert.equal(res.headers['cache-control'], 'no-store');

  const stored = await ReauthToken.find().lean();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].tokenHash, sha256(res.body.reauthToken));
  assert.equal(String(stored[0].userId), String(user._id));
  assert.equal(String(stored[0].sessionId), me.session.id);
  assert.equal(stored[0].usedAt, null);
  assert.ok(!JSON.stringify(stored[0]).includes(res.body.reauthToken.slice(4)), 'the raw token is never stored');
});

test('reauth_tokens has a TTL index on expiresAt and a unique tokenHash', async () => {
  const indexes = await ReauthToken.collection.indexes();
  const ttl = indexes.find((i) => i.key.expiresAt === 1);
  assert.ok(ttl, 'TTL index on expiresAt');
  assert.equal(ttl.expireAfterSeconds, 0);
  assert.equal(indexes.find((i) => i.key.tokenHash === 1).unique, true);
});

test('reauthenticate: a wrong password is 422 PASSWORD_INCORRECT (not 401) and no token is issued', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const res = await reauth(me.headers, { password: 'Wrong-Horse-99' });
  assertSpecProblem(res, 422, 'PASSWORD_INCORRECT');
  assert.equal(res.body.errors[0].field, '/password');
  assert.equal(await ReauthToken.countDocuments(), 0);
  // Still signed in.
  assert.equal((await listSessions(me.headers)).status, 200);
});

test('reauthenticate: an old bcrypt password works', async () => {
  const { user } = await makeAccount({ hash: bcrypt.hashSync(OLD_PASSWORD, 4) });
  const me = await signIn(user);
  assert.equal((await reauth(me.headers, { password: OLD_PASSWORD })).status, 200);
});

test('reauthenticate: 5 failures lock it like login (423 ACCOUNT_LOCKED), even for the right password, until the lock ends', async () => {
  const { user, email } = await makeAccount();
  const me = await signIn(user);
  for (let i = 1; i <= 4; i += 1) {
    assertSpecProblem(await reauth(me.headers, { password: `Wrong-Horse-${i}0` }), 422, 'PASSWORD_INCORRECT');
  }
  const fifth = await reauth(me.headers, { password: 'Wrong-Horse-50' });
  assertSpecProblem(fifth, 423, 'ACCOUNT_LOCKED');
  assert.equal(fifth.headers['retry-after'], '900');
  assert.equal(fifth.body.retryAfterSeconds, 900);

  assertSpecProblem(await reauth(me.headers, { password: OLD_PASSWORD }), 423, 'ACCOUNT_LOCKED');
  // The same lock as login.
  assertSpecProblem(await login(email, OLD_PASSWORD), 423, 'ACCOUNT_LOCKED');

  clock.advance(15 * MINUTE + SECOND);
  assert.equal((await reauth(me.headers, { password: OLD_PASSWORD })).status, 200);
});

test('reauthenticate: failed logins and failed re-authentications count towards one lock', async () => {
  const { user, email } = await makeAccount();
  const me = await signIn(user);
  for (let i = 0; i < 3; i += 1) assertSpecProblem(await login(email, 'Wrong-Horse-77'), 401, 'INVALID_CREDENTIALS');
  assertSpecProblem(await reauth(me.headers, { password: 'Wrong-Horse-77' }), 422, 'PASSWORD_INCORRECT');
  assertSpecProblem(await reauth(me.headers, { password: 'Wrong-Horse-77' }), 423, 'ACCOUNT_LOCKED');
});

test('reauthenticate: the right password clears earlier failures', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  for (let i = 0; i < 4; i += 1) await reauth(me.headers, { password: 'Wrong-Horse-77' });
  assert.equal((await reauth(me.headers, { password: OLD_PASSWORD })).status, 200);
  assertSpecProblem(await reauth(me.headers, { password: 'Wrong-Horse-77' }), 422, 'PASSWORD_INCORRECT');
  const stored = await storedUser(user);
  assert.equal(stored.loginFailedCount, 1);
  assert.equal(stored.loginLockedUntil, null);
});

test('reauthenticate: an account without a password cannot use one', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  assertSpecProblem(await reauth(me.headers, { password: OLD_PASSWORD }), 422, 'PASSWORD_INCORRECT');
});

test('reauthenticate: a social credential is refused until social sign-in exists (422 SOCIAL_PROVIDER_UNSUPPORTED)', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  const res = await reauth(me.headers, { social: { provider: 'google', idToken: 'eyJ.fake.token' } });
  assertSpecProblem(res, 422, 'SOCIAL_PROVIDER_UNSUPPORTED');
  assert.equal(await ReauthToken.countDocuments(), 0);
});

test('reauthenticate: exactly one of password and social', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const both = await reauth(me.headers, { password: OLD_PASSWORD, social: { provider: 'google', idToken: 'x' } });
  assert.ok([400, 422].includes(both.status), both.text);
  assertMatchesSpec('Problem', both.body);
  const neither = await reauth(me.headers, {});
  assert.ok([400, 422].includes(neither.status), neither.text);
  assertMatchesSpec('Problem', neither.body);
  assert.equal(await ReauthToken.countDocuments(), 0);
});

test('reauthenticate: guests get 403 GUEST_NOT_ALLOWED, and no token is 401', async () => {
  assertSpecProblem(await reauth(await guestHeaders(), { password: OLD_PASSWORD }), 403, 'GUEST_NOT_ALLOWED');
  assertSpecProblem(await reauth(CLIENT, { password: OLD_PASSWORD }), 401, 'UNAUTHENTICATED');
});

test('reauthenticate: a signed-out session gets 401 SESSION_REVOKED', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  await Session.updateOne({ _id: me.session.id }, { $set: { revokedAt: new Date() } });
  assertSpecProblem(await reauth(me.headers, { password: OLD_PASSWORD }), 401, 'SESSION_REVOKED');
});

// ---------------------------------------------------------------------------
// PUT /me/password with currentPassword
// ---------------------------------------------------------------------------

test('change password: 204; the old password is refused at login and the new one works; other devices signed out; notice sent', async () => {
  const { user, email } = await makeAccount();
  const me = await signIn(user);
  const phone2 = await signIn(user);
  const phone3 = await signIn(user);

  const res = await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
  assert.equal(res.status, 204, res.text);
  assert.equal(res.text, '');

  // This device stays signed in; the others are signed out.
  assert.equal((await listSessions(me.headers)).status, 200);
  for (const other of [phone2, phone3]) assertSpecProblem(await listSessions(other.headers), 401, 'SESSION_REVOKED');
  const revoked = await Session.find({ userId: user._id, revokedAt: { $ne: null } }).lean();
  assert.equal(revoked.length, 2);
  assert.ok(revoked.every((s) => s.revokeReason === 'password_changed'));

  assertSpecProblem(await login(email, OLD_PASSWORD), 401, 'INVALID_CREDENTIALS');
  assert.equal((await login(email, NEW_PASSWORD)).status, 200);
  const stored = await storedUser(user);
  assert.match(stored.password, /^\$argon2id\$/);
  assert.equal(stored.passwordAlgo, 'argon2id');

  await flush();
  assert.deepEqual(notices.notices, [{ to: email, notice: 'password_changed' }]);
});

test('change password: signOutOtherSessions false keeps the other devices signed in', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const other = await signIn(user);
  const res = await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, signOutOtherSessions: false });
  assert.equal(res.status, 204, res.text);
  assert.equal((await listSessions(other.headers)).status, 200);
  assert.equal(await Session.countDocuments({ userId: user._id, revokedAt: { $ne: null } }), 0);
});

test('change password: signOutOtherSessions true signs the others out too', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const other = await signIn(user);
  assert.equal((await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, signOutOtherSessions: true })).status, 204);
  assertSpecProblem(await listSessions(other.headers), 401, 'SESSION_REVOKED');
});

test('change password: the service signs the others out by default too, not only through the spec\'s default', async () => {
  const { user } = await makeAccount();
  const signedOut = [];
  const sessions = { async revokeAllOtherSessions(input) { signedOut.push(input); } };
  const service = createCredentialsService({ now: clock.now, reauthTokens, sessions, emailProvider: notices, logger: silent });
  const sessionId = String(new mongoose.Types.ObjectId());
  await service.changePassword({ auth: { userId: String(user._id), sessionId }, currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
  assert.ok(signedOut.length > 0, 'other sessions signed out');
  assert.ok(signedOut.every((s) => s.keepSessionId === sessionId && s.reason === 'password_changed'));
});

test('change password: an old bcrypt account can change it', async () => {
  const { user, email } = await makeAccount({ hash: bcrypt.hashSync(OLD_PASSWORD, 4) });
  const me = await signIn(user);
  assert.equal((await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status, 204);
  assert.equal((await login(email, NEW_PASSWORD)).status, 200);
});

test('change password: a wrong current password is 422 PASSWORD_INCORRECT and changes nothing', async () => {
  const { user, email } = await makeAccount();
  const me = await signIn(user);
  const other = await signIn(user);
  const before = (await storedUser(user)).password;
  const res = await changePassword(me.headers, { currentPassword: 'Wrong-Horse-99', newPassword: NEW_PASSWORD });
  assertSpecProblem(res, 422, 'PASSWORD_INCORRECT');
  assert.equal(res.body.errors[0].field, '/currentPassword');
  assert.equal((await storedUser(user)).password, before);
  assert.equal((await listSessions(other.headers)).status, 200);
  assert.equal((await login(email, OLD_PASSWORD)).status, 200);
  await flush();
  assert.deepEqual(notices.notices, []);
});

test('change password: 5 wrong current passwords lock it (423), and the lock is login\'s', async () => {
  const { user, email } = await makeAccount();
  const me = await signIn(user);
  for (let i = 1; i <= 4; i += 1) {
    assertSpecProblem(await changePassword(me.headers, { currentPassword: `Wrong-Horse-${i}0`, newPassword: NEW_PASSWORD }), 422, 'PASSWORD_INCORRECT');
  }
  const fifth = await changePassword(me.headers, { currentPassword: 'Wrong-Horse-50', newPassword: NEW_PASSWORD });
  assertSpecProblem(fifth, 423, 'ACCOUNT_LOCKED');
  assert.equal(fifth.headers['retry-after'], '900');
  assertSpecProblem(await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }), 423, 'ACCOUNT_LOCKED');
  assertSpecProblem(await login(email, OLD_PASSWORD), 423, 'ACCOUNT_LOCKED');
});

test('change password: a successful change clears the login lock counters', async () => {
  const { user, email } = await makeAccount();
  const me = await signIn(user);
  for (let i = 0; i < 4; i += 1) await login(email, 'Wrong-Horse-77');
  assert.equal((await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status, 204);
  const stored = await storedUser(user);
  assert.equal(stored.loginFailedCount, 0);
  assert.equal(stored.loginLockedUntil, null);
});

test('change password: an account with a password must send currentPassword, even with a reauth token', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const issued = await reauth(me.headers, { password: OLD_PASSWORD });
  const res = await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': issued.body.reauthToken });
  assertSpecProblem(res, 422, 'VALIDATION_FAILED');
  assert.equal(res.body.errors[0].field, '/currentPassword');
  assert.equal(await passwords.verify((await storedUser(user)).password, OLD_PASSWORD), true);
});

test('change password: the same password again is PASSWORD_REUSED', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const other = await signIn(user);
  const res = await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD });
  assertSpecProblem(res, 422, 'VALIDATION_FAILED');
  assert.equal(res.body.errors[0].code, 'PASSWORD_REUSED');
  assert.equal(res.body.errors[0].field, '/newPassword');
  assert.equal((await listSessions(other.headers)).status, 200);
});

test('change password: the same password typed in another Unicode form is PASSWORD_REUSED too (NFKC)', async () => {
  const password = 'Ｆullwidth-Pass-1';
  const { user } = await makeAccount({ password });
  const me = await signIn(user);
  const res = await changePassword(me.headers, { currentPassword: password, newPassword: password.normalize('NFKC') });
  assertSpecProblem(res, 422, 'VALIDATION_FAILED');
  assert.equal(res.body.errors[0].code, 'PASSWORD_REUSED');
});

test('change password: the sign-up policy applies (PASSWORD_POLICY_VIOLATION) and a weak password costs no attempt', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const res = await changePassword(me.headers, { currentPassword: 'Wrong-Horse-99', newPassword: 'lowercase only 12' });
  assertSpecProblem(res, 422, 'VALIDATION_FAILED');
  assert.equal(res.body.errors[0].code, 'PASSWORD_POLICY_VIOLATION');
  assert.equal(res.body.errors[0].field, '/newPassword');
  assert.deepEqual(res.body.errors[0].meta.unmetRules, ['uppercase', 'symbol']);
  assert.equal((await storedUser(user)).loginFailedCount ?? 0, 0);

  const short = await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: 'Sh0rt!' });
  assertSpecProblem(short, 422, 'VALIDATION_FAILED');
  assert.equal(short.body.errors[0].field, '/newPassword');
});

test('change password: guests get 403 GUEST_NOT_ALLOWED, and no token is 401', async () => {
  assertSpecProblem(await changePassword(await guestHeaders(), { newPassword: NEW_PASSWORD }), 403, 'GUEST_NOT_ALLOWED');
  assertSpecProblem(await changePassword(CLIENT, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }), 401, 'UNAUTHENTICATED');
});

test('change password: unknown fields are refused by the spec', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const res = await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, password: 'x' });
  assert.ok([400, 422].includes(res.status), res.text);
  assertMatchesSpec('Problem', res.body);
});

test('change password: a failing mail server does not fail the change', async () => {
  const { user, email } = await makeAccount();
  const me = await signIn(user);
  notices.failNext();
  assert.equal((await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status, 204);
  assert.equal((await login(email, NEW_PASSWORD)).status, 200);
});

test('change password: the notice says nothing about which devices were signed out', () => {
  assert.doesNotMatch(NOTICES.password_changed.text, /signed out/);
});

// ---------------------------------------------------------------------------
// PUT /me/password: a first password, with X-Reauth-Token
// ---------------------------------------------------------------------------

test('first password: a social-only account sets one with a reauth token; it then works at login', async () => {
  const { user, email } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  const other = await signIn(user, { signInMethod: 'google' });
  const { reauthToken } = await issueReauth(me);
  const res = await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': reauthToken });
  assert.equal(res.status, 204, res.text);
  assert.equal((await login(email, NEW_PASSWORD)).status, 200);
  assertSpecProblem(await listSessions(other.headers), 401, 'SESSION_REVOKED');
  assert.equal((await listSessions(me.headers)).status, 200);
  assert.ok((await ReauthToken.findOne({ tokenHash: sha256(reauthToken) }).lean()).usedAt, 'the token is used up');
  await flush();
  assert.deepEqual(notices.notices, [{ to: email, notice: 'password_changed' }]);
});

test('first password: an account whose stored password this API cannot read is treated as having none', async () => {
  const email = uniqueEmail();
  const user = await User.create({ email, password: 'x' });
  const me = await signIn(user);
  const { reauthToken } = await issueReauth(me);
  assert.equal((await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': reauthToken })).status, 204);
  assert.equal((await login(email, NEW_PASSWORD)).status, 200);
});

test('first password: without X-Reauth-Token it is 401 REAUTH_REQUIRED', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  assertSpecProblem(await changePassword(me.headers, { newPassword: NEW_PASSWORD }), 401, 'REAUTH_REQUIRED');
  assertSpecProblem(await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': 'rat_not-a-real-token' }), 401, 'REAUTH_REQUIRED');
  assert.equal((await storedUser(user)).password, undefined);
});

test('first password: a reused token is 401 REAUTH_REQUIRED', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  const { reauthToken } = await issueReauth(me);
  assert.equal((await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': reauthToken })).status, 204);
  // Back to no password, so only the token stands between the request and a new password.
  await User.collection.updateOne({ _id: user._id }, { $unset: { password: '' } });
  const again = await changePassword(me.headers, { newPassword: 'Another-Pass-42!' }, { 'X-Reauth-Token': reauthToken });
  assertSpecProblem(again, 401, 'REAUTH_REQUIRED');
  assert.equal((await storedUser(user)).password, undefined);
});

test('first password: a token is good for 5 minutes and expired after', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  const late = await issueReauth(me);
  clock.advance(5 * MINUTE);
  assertSpecProblem(await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': late.reauthToken }), 401, 'REAUTH_REQUIRED');
  const inTime = await issueReauth(me);
  clock.advance(5 * MINUTE - SECOND);
  assert.equal((await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': inTime.reauthToken })).status, 204);
});

test('first password: another user\'s token, or one from another of the user\'s devices, is 401 REAUTH_REQUIRED', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  const otherDevice = await signIn(user, { signInMethod: 'google' });
  const { user: someoneElse } = await makeSocialOnly();
  const theirs = await issueReauth(await signIn(someoneElse, { signInMethod: 'google' }));
  assertSpecProblem(await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': theirs.reauthToken }), 401, 'REAUTH_REQUIRED');
  const fromOtherDevice = await issueReauth(otherDevice);
  assertSpecProblem(await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': fromOtherDevice.reauthToken }), 401, 'REAUTH_REQUIRED');
  assert.equal((await storedUser(user)).password, undefined);
  // Neither token was used up by the failed attempts.
  assert.equal(await ReauthToken.countDocuments({ usedAt: { $ne: null } }), 0);
});

test('first password: a weak password does not use the token up', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  const { reauthToken } = await issueReauth(me);
  const weak = await changePassword(me.headers, { newPassword: 'lowercase only 12' }, { 'X-Reauth-Token': reauthToken });
  assertSpecProblem(weak, 422, 'VALIDATION_FAILED');
  assert.equal(weak.body.errors[0].code, 'PASSWORD_POLICY_VIOLATION');
  assert.equal((await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': reauthToken })).status, 204);
});

test('first password: a failure on our side gives the token back', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  const { reauthToken } = await issueReauth(me);
  const failing = buildApp({ users: { ...require('../src/modules/users/repo'), changePassword: async () => { throw new Error('db down'); } } });
  const res = await request(failing).put('/v1/me/password').set({ ...me.headers, 'X-Reauth-Token': reauthToken }).send({ newPassword: NEW_PASSWORD });
  assertSpecProblem(res, 500, 'INTERNAL_ERROR');
  assert.equal((await changePassword(me.headers, { newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': reauthToken })).status, 204);
});

test('first password: a social-only account that sends a currentPassword gets PASSWORD_INCORRECT', async () => {
  const { user } = await makeSocialOnly();
  const me = await signIn(user, { signInMethod: 'google' });
  const { reauthToken } = await issueReauth(me);
  const res = await changePassword(me.headers, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, { 'X-Reauth-Token': reauthToken });
  assertSpecProblem(res, 422, 'PASSWORD_INCORRECT');
  assert.equal((await storedUser(user)).password, undefined);
});

test('rate limits: the spec gives neither operation an x-rate-limit or an Idempotency-Key, so the login lock is the only limit', () => {
  const operations = [spec.paths['/auth/reauthenticate'].post, spec.paths['/me/password'].put];
  for (const operation of operations) {
    assert.equal(operation['x-rate-limit'], undefined, `${operation.operationId} now has an x-rate-limit: add the limiter`);
    const params = JSON.stringify(operation.parameters || []);
    assert.doesNotMatch(params, /IdempotencyKey|Idempotency-Key/, `${operation.operationId} now takes an Idempotency-Key`);
  }
});

test('a password changed by another request in the meantime is not overwritten', async () => {
  const { user } = await makeAccount();
  const me = await signIn(user);
  const users = require('../src/modules/users/repo');
  // Another change lands between this request reading the user and saving the new password.
  const racing = buildApp({
    users: {
      ...users,
      async changePassword(userId, change) {
        await User.updateOne({ _id: userId }, { $set: { password: await passwords.hash('Someone-Else-1!') } });
        return users.changePassword(userId, change);
      },
    },
  });
  const res = await request(racing).put('/v1/me/password').set(me.headers).send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
  assertSpecProblem(res, 422, 'PASSWORD_INCORRECT');
  assert.equal(await passwords.verify((await storedUser(user)).password, 'Someone-Else-1!'), true);
});
