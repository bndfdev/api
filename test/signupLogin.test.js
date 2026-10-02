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
const { createChallengeService } = require('../src/modules/challenges/service');
const { createSignupTokenService } = require('../src/modules/signupTokens/service');
const { createAuthService, LOGIN_RULES } = require('../src/modules/auth/service');
const { createAuthRouter } = require('../src/modules/auth/routes');
const defaultPasswords = require('../src/lib/passwords');
const usersRepo = require('../src/modules/users/repo');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { createMemorySmsProvider } = require('../src/providers/sms/memory');
const Challenge = require('../models/Challenge');
const Session = require('../models/Session');
const LoginAttempt = require('../models/LoginAttempt');
const SignupToken = require('../models/SignupToken');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem } = require('./support/api');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PASSWORD = 'Correct-Horse-9';

// A fake clock for the services: tests move time by hand instead of sleeping. (Rate limits, idempotency and
// sessions use the real clock.)
const clock = { t: 0, now: () => clock.t, advance(ms) { clock.t += ms; } };
const mail = createMemoryEmailProvider();
const sms = createMemorySmsProvider();
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** A complete app with a fake email provider and clock. `deps` replace parts of the auth service. */
function buildApp(deps = {}) {
  const challenges = createChallengeService({ now: clock.now, emailProvider: mail, smsProvider: sms, logger: silent });
  const service = createAuthService({ now: clock.now, challenges, logger: silent, ...deps });
  return createApp({ trustProxy: 1, authRouter: createAuthRouter({ service }) });
}
const app = buildApp();

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
// `format` is not checked (the unknown-format warning is silenced).
const ajv = new Ajv2020({ strict: false, logger: false });
const matchesSpec = (name, value) => ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value);
const assertMatchesSpec = (name, value) => assert.equal(matchesSpec(name, value), true, `${name}: ${JSON.stringify(ajv.errors)}`);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

before(async () => {
  await db.connect();
  await defaultPasswords.dummyHash();
});
beforeEach(async () => {
  await db.clear();
  mail.clear();
  sms.clear();
  clock.t = Date.now();
});
after(db.disconnect);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
const uniqueEmail = () => `person${(counter += 1)}@example.com`;
const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

/** One app install behind its own IP address, so every test has its own rate-limit counters. */
function newClient() {
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
    device: { installationId, platform: 'ios', appVersion: '1.4.0+42', model: 'iPhone 16' },
  };
}

const post = (client, path, body, extra = {}, target = app) => request(target).post(path).set({ ...client.headers, ...extra }).send(body);
const get = (client, path, extra = {}) => request(app).get(path).set({ ...client.headers, ...extra });

const startSignup = (client, email, extra, target) => post(client, '/v1/auth/signup/email', { email }, extra, target);
const verifyCode = (client, challengeId, code) => post(client, `/v1/auth/challenges/${challengeId}/verify`, { code });
const completeSignup = (client, signupToken, password = PASSWORD, extra = {}, headers = {}, target = app) =>
  post(client, '/v1/auth/signup/complete', { signupToken, password, device: client.device, ...extra }, headers, target);
const login = (client, email, password = PASSWORD, target = app) =>
  post(client, '/v1/auth/login', { email, password, device: client.device }, {}, target);

/** Start sign-up and verify the code that "arrived": returns the sign-up token. */
async function verifiedEmail(client, email = uniqueEmail()) {
  const start = await startSignup(client, email);
  assert.equal(start.status, 202, start.text);
  const code = mail.lastCodeFor(email);
  assert.match(code, /^\d{6}$/);
  const verify = await verifyCode(client, start.body.id, code);
  assert.equal(verify.status, 200, verify.text);
  return { email, challenge: start.body, code, signupToken: verify.body.signupToken, verify };
}

/** A whole sign-up. */
async function signUp(client = newClient(), { email = uniqueEmail(), password = PASSWORD } = {}) {
  const step = await verifiedEmail(client, email);
  const res = await completeSignup(client, step.signupToken, password);
  assert.equal(res.status, 201, res.text);
  return { client, email, password, res, session: res.body };
}

/** Every stored document of every collection, as one string. */
async function wholeDatabase() {
  const parts = [];
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    parts.push(JSON.stringify(await mongoose.connection.db.collection(name).find({}).toArray()));
  }
  return parts.join('\n');
}

const withoutRequestId = ({ requestId, ...rest }) => rest;
const wrongPassword = 'Wrong-Horse-1234!';

// ---------------------------------------------------------------------------
// Sign-up end to end
// ---------------------------------------------------------------------------

test('sign-up end to end: availability, code, verify, complete; nothing is created until the last step', async () => {
  const client = newClient();
  const email = uniqueEmail();

  const availability = await post(client, '/v1/auth/email/availability', { email });
  assert.equal(availability.status, 200, availability.text);
  assert.deepEqual(availability.body, { email, available: true, suggestion: null });
  assertMatchesSpec('EmailAvailability', availability.body);

  const start = await startSignup(client, email);
  assert.equal(start.status, 202, start.text);
  assertMatchesSpec('Challenge', start.body);
  assert.equal(start.body.purpose, 'signup_email');
  assert.equal(start.body.channel, 'email');
  assert.match(start.headers.ratelimit, /^limit=\d+, remaining=\d+, reset=\d+$/);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, email);
  assert.equal(await User.countDocuments(), 0, 'no user yet');

  const code = mail.lastCodeFor(email);
  const verify = await verifyCode(client, start.body.id, code);
  assert.equal(verify.status, 200, verify.text);
  assertMatchesSpec('ChallengeVerification', verify.body);
  assert.deepEqual(Object.keys(verify.body).sort(), ['email', 'purpose', 'signupToken', 'signupTokenExpiresAt']);
  assert.equal(verify.body.purpose, 'signup_email');
  assert.equal(verify.body.email, email);
  assert.match(verify.body.signupToken, /^sgt_[A-Za-z0-9_-]{43}$/);
  assert.equal(verify.body.signupTokenExpiresAt, iso(Math.floor(clock.t / SECOND) * SECOND + 30 * MINUTE), 'valid for 30 minutes');
  assert.equal(verify.headers['cache-control'], 'no-store');
  assert.equal(await User.countDocuments(), 0, 'still no user');

  const done = await completeSignup(client, verify.body.signupToken);
  assert.equal(done.status, 201, done.text);
  assertMatchesSpec('Session', done.body);
  assert.equal(done.headers['cache-control'], 'no-store');
  assert.equal(done.body.isNewUser, true);
  assert.equal(done.body.tokens.tokenType, 'Bearer');
  assert.equal(done.body.session.current, true);
  assert.equal(done.body.session.signInMethod, 'password');
  assert.deepEqual(done.body.session.device, { platform: 'ios', model: 'iPhone 16', appVersion: '1.4.0+42' });

  const { user } = done.body;
  assert.equal(user.accountType, 'user');
  assert.equal(user.status, 'active');
  assert.equal(user.email, email);
  assert.equal(user.emailVerified, true);
  assert.equal(user.phoneVerified, false);
  assert.equal(user.onboarding.status, 'in_progress');
  assert.equal(user.onboarding.nextStep, 'phone_verified', 'the spec: completeSignup leaves phone_verified next');
  assert.deepEqual(user.onboarding.steps.map((s) => [s.step, s.status]), [
    ['email_verified', 'completed'], ['password_set', 'completed'], ['phone_verified', 'pending'], ['date_of_birth', 'pending'],
    ['terms_accepted', 'pending'], ['gender', 'pending'], ['interests', 'pending'], ['profile', 'pending'],
  ]);
  assert.deepEqual(user.onboarding.steps.filter((s) => s.skippable).map((s) => s.step), ['interests', 'profile']);
  assert.equal(user.consents.termsUpToDate, false);
  assert.ok(!('password' in user));

  // The new access token works for this session.
  const sessions = await get(client, '/v1/me/sessions', { Authorization: `Bearer ${done.body.tokens.accessToken}` });
  assert.equal(sessions.status, 200, sessions.text);
  assert.deepEqual(sessions.body.data.map((s) => s.id), [done.body.session.id]);

  // What was stored: an argon2id hash, the normalised email, and the flags the API needs.
  const stored = await User.findOne({ email }).lean();
  assert.match(stored.password, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(stored.passwordAlgo, 'argon2id');
  assert.equal(stored.email, email, 'stored already normalised, so the unique index on email covers duplicates');
  assert.ok(!('emailNormalized' in stored));
  assert.equal(stored.emailVerified, true);
  assert.equal(String(stored._id), user.id);
  assert.equal(await Session.countDocuments({ userId: stored._id }), 1);

  // And the new account can sign in.
  const again = await login(newClient(), email);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.user.id, user.id);
});

test('nothing secret is stored or logged in plain text: password, sign-up token, access and refresh tokens', async () => {
  const { res, email } = await signUp();
  const secrets = [PASSWORD, res.body.tokens.accessToken, res.body.tokens.refreshToken];
  const token = (await SignupToken.findOne({}).lean()).tokenHash;
  assert.match(token, /^[0-9a-f]{64}$/, 'only a hash of the sign-up token is kept');
  const everything = await wholeDatabase();
  for (const secret of secrets) assert.ok(!everything.includes(secret), 'a secret is stored in plain text');
  assert.ok(everything.includes(email), 'sanity: the database was searched');
  // Nor does a response repeat the password back.
  const weak = await completeSignup(newClient(), 'sgt_unknown', 'weak');
  assert.ok(!weak.text.includes('weak'));
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test('availability: a registered address is not available, in any case or padding; a typo gets a suggestion', async () => {
  await signUp(newClient(), { email: 'amelia.jane@example.com' });
  const client = newClient();
  for (const email of ['amelia.jane@example.com', 'Amelia.Jane@EXAMPLE.com', '  amelia.jane@example.com  ']) {
    const res = await post(client, '/v1/auth/email/availability', { email });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { email: 'amelia.jane@example.com', available: false, suggestion: null }, email);
  }
  const typo = await post(client, '/v1/auth/email/availability', { email: 'amelia.jane@gmial.com' });
  assert.deepEqual(typo.body, { email: 'amelia.jane@gmial.com', available: true, suggestion: 'amelia.jane@gmail.com' });
  assertMatchesSpec('EmailAvailability', typo.body);
});

test('availability: an address that is not an address is EMAIL_INVALID with a field error', async () => {
  const client = newClient();
  for (const email of ['nope', 'a@', '@example.com', 'a b@example.com', '']) {
    const res = await post(client, '/v1/auth/email/availability', { email });
    assertProblem(res, 422, 'VALIDATION_FAILED');
    assert.equal(res.body.errors[0].field, '/email', email);
    assert.equal(res.body.errors[0].code, 'EMAIL_INVALID', email);
  }
  // One the spec's format check lets through but the API's stricter check does not.
  const doubleDot = await post(client, '/v1/auth/email/availability', { email: 'a..b@example.com' });
  assert.equal(doubleDot.status, 422);
  assert.equal(doubleDot.body.errors[0].code, 'EMAIL_INVALID');
});

// ---------------------------------------------------------------------------
// Starting sign-up
// ---------------------------------------------------------------------------

test('start: a registered address is 409 EMAIL_TAKEN and nothing is sent, in any case', async () => {
  await signUp(newClient(), { email: 'taken@example.com' });
  mail.clear();
  const client = newClient();
  for (const email of ['taken@example.com', 'TAKEN@Example.COM']) {
    const res = await startSignup(client, email);
    assertProblem(res, 409, 'EMAIL_TAKEN');
  }
  assert.equal(mail.sent.length, 0);
  assert.equal(await Challenge.countDocuments({ purpose: 'signup_email' }), 1, 'only the first sign-up made one');
});

test('start: an older user whose stored email differs only in case counts as taken', async () => {
  // Written like the old API did, by hand: mixed case.
  await User.collection.insertOne({ email: 'Legacy.Mixed@Example.com', password: await bcrypt.hash(PASSWORD, 4), createdAt: new Date() });
  const client = newClient();
  const availability = await post(client, '/v1/auth/email/availability', { email: 'legacy.mixed@example.com' });
  assert.equal(availability.body.available, false);
  assertProblem(await startSignup(client, 'legacy.mixed@example.com'), 409, 'EMAIL_TAKEN');
  assert.equal(mail.sent.length, 0);
});

test('two older accounts whose emails differ only in case: the oldest one is always the one found', async () => {
  const older = await bcrypt.hash('Older-Pass-1!', 4);
  const newer = await bcrypt.hash('Newer-Pass-2!', 4);
  // Inserted newest first, so that insertion order and age disagree.
  await User.collection.insertOne({ email: 'ann@example.com', password: newer, createdAt: new Date('2025-06-01T00:00:00Z') });
  await User.collection.insertOne({ email: 'Ann@Example.com', password: older, createdAt: new Date('2024-01-01T00:00:00Z') });
  const client = newClient();
  assert.equal((await post(client, '/v1/auth/email/availability', { email: 'ann@example.com' })).body.available, false);
  const res = await login(client, 'ANN@example.com', 'Older-Pass-1!');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.user.email, 'Ann@Example.com', 'the oldest account');
  assertProblem(await login(client, 'ann@example.com', 'Newer-Pass-2!'), 401, 'INVALID_CREDENTIALS');

  // With no createdAt at all, the lower _id (made first) wins.
  const first = await User.collection.insertOne({ email: 'Bo@Example.com', password: older });
  await User.collection.insertOne({ email: 'bo@example.com', password: newer });
  const bo = await login(client, 'bo@example.com', 'Older-Pass-1!');
  assert.equal(bo.status, 200, bo.text);
  assert.equal(bo.body.user.id, String(first.insertedId));
});

test('the users indexes: the unique one on email stays, the case-insensitive one is not unique, and there is no emailNormalized', async () => {
  const indexes = await User.collection.indexes();
  const byName = Object.fromEntries(indexes.map((i) => [i.name, i]));
  assert.equal(byName.email_1.unique, true);
  assert.equal(byName.email_case_insensitive.unique, undefined);
  assert.deepEqual(byName.email_case_insensitive.collation && { locale: byName.email_case_insensitive.collation.locale, strength: byName.email_case_insensitive.collation.strength }, { locale: 'en', strength: 2 });
  assert.ok(!indexes.some((i) => 'emailNormalized' in i.key));
});

test('start: asking twice from one install returns the same challenge and sends one email', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const first = await startSignup(client, email);
  const second = await startSignup(client, email);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.body.id, first.body.id);
  assert.equal(mail.sent.length, 1);
});

test('start: an Idempotency-Key replays the first answer without sending another code', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const key = { 'Idempotency-Key': crypto.randomUUID() };
  const first = await startSignup(client, email, key);
  const second = await startSignup(client, email, key);
  assert.equal(second.status, 202);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(mail.sent.length, 1);
  assertProblem(await startSignup(client, uniqueEmail(), key), 422, 'IDEMPOTENCY_KEY_REUSED');
});

test('start: an email that cannot be delivered is 503 and the address can try again', async () => {
  const client = newClient();
  const email = uniqueEmail();
  mail.failNext();
  const res = await startSignup(client, email);
  assertProblem(res, 503, 'EMAIL_DELIVERY_FAILED');
  assert.ok(Number(res.headers['retry-after']) >= 1);
  assert.equal((await startSignup(client, email)).status, 202);
});

test('the sign-up code is never in a response', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email);
  assert.ok(!start.text.includes(mail.lastCodeFor(email)));
  assert.ok(start.body.destination.includes('•'), 'only a masked address comes back');
  assert.ok(!start.text.includes(email));
});

// ---------------------------------------------------------------------------
// The code: read, resend, verify
// ---------------------------------------------------------------------------

test('get: restores the challenge, only for the install that asked for it', async () => {
  const client = newClient();
  const start = await startSignup(client, uniqueEmail());
  const res = await get(client, `/v1/auth/challenges/${start.body.id}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, start.body);
  assertProblem(await get(newClient(), `/v1/auth/challenges/${start.body.id}`), 404, 'CHALLENGE_NOT_FOUND');
  assertProblem(await get(client, `/v1/auth/challenges/${'a'.repeat(24)}`), 404, 'CHALLENGE_NOT_FOUND');
});

test('resend: too soon is 429 RESEND_TOO_SOON; after the cooldown a new code replaces the old one', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email);
  const oldCode = mail.lastCodeFor(email);
  const resend = () => post(client, `/v1/auth/challenges/${start.body.id}/resend`, undefined);

  const early = await resend();
  assertProblem(early, 429, 'RESEND_TOO_SOON');
  assert.ok(early.body.retryAfterSeconds >= 1 && early.body.retryAfterSeconds <= 30);
  assert.equal(early.headers['retry-after'], String(early.body.retryAfterSeconds));

  clock.advance(31 * SECOND);
  const res = await resend();
  assert.equal(res.status, 202, res.text);
  assertMatchesSpec('Challenge', res.body);
  assert.equal(res.body.id, start.body.id, 'a resend keeps the challenge');
  assert.equal(res.body.sendsRemaining, start.body.sendsRemaining - 1);
  assert.equal(mail.sent.length, 2);

  const newCode = mail.lastCodeFor(email);
  if (newCode !== oldCode) assertProblem(await verifyCode(client, start.body.id, oldCode), 422, 'CODE_INCORRECT');
  assert.equal((await verifyCode(client, start.body.id, newCode)).status, 200);
});

test('resend: an Idempotency-Key replays the first answer and sends nothing more', async () => {
  const client = newClient();
  const start = await startSignup(client, uniqueEmail());
  clock.advance(31 * SECOND);
  const key = { 'Idempotency-Key': crypto.randomUUID() };
  const first = await post(client, `/v1/auth/challenges/${start.body.id}/resend`, undefined, key);
  const second = await post(client, `/v1/auth/challenges/${start.body.id}/resend`, undefined, key);
  assert.equal(first.status, 202);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(mail.sent.length, 2, 'the first send and one resend');
});

test('verify: a wrong code is CODE_INCORRECT with the attempts left; a badly formed one costs no attempt', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email);
  const code = mail.lastCodeFor(email);
  const wrong = code === '000000' ? '111111' : '000000';

  const res = await verifyCode(client, start.body.id, wrong);
  assertProblem(res, 422, 'CODE_INCORRECT');
  assert.deepEqual(res.body.meta, { attemptsRemaining: 4 });

  // Not 6 digits: refused by the spec check (format) or the service, and no attempt is used.
  assert.equal((await verifyCode(client, start.body.id, '12345')).status, 422);
  assert.equal((await get(client, `/v1/auth/challenges/${start.body.id}`)).body.attemptsRemaining, 4);
  assert.equal((await verifyCode(client, start.body.id, code)).status, 200);
});

test('verify: an expired code is 410 CHALLENGE_EXPIRED', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email);
  const code = mail.lastCodeFor(email);
  clock.advance(10 * MINUTE + SECOND);
  assertProblem(await verifyCode(client, start.body.id, code), 410, 'CHALLENGE_EXPIRED');
});

test('verify: a code works once; another install cannot use it', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email);
  const code = mail.lastCodeFor(email);
  assertProblem(await verifyCode(newClient(), start.body.id, code), 404, 'CHALLENGE_NOT_FOUND');
  assert.equal((await verifyCode(client, start.body.id, code)).status, 200);
  assertProblem(await verifyCode(client, start.body.id, code), 409, 'CHALLENGE_ALREADY_USED');
});

test('verify: if the sign-up token cannot be made, the right code is not lost and can be entered again', async () => {
  let failures = 1;
  const base = createSignupTokenService({ now: clock.now });
  const flaky = { ...base, issue: async (input) => { if (failures-- > 0) throw new Error('database hiccup'); return base.issue(input); } };
  const flakyApp = buildApp({ signupTokens: flaky });
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email, {}, flakyApp);
  const code = mail.lastCodeFor(email);

  const failed = await post(client, `/v1/auth/challenges/${start.body.id}/verify`, { code }, {}, flakyApp);
  assertProblem(failed, 500, 'INTERNAL_ERROR');
  const stored = await Challenge.findById(start.body.id).lean();
  assert.equal(stored.verifiedAt, null, 'the code was given back');
  assert.equal(stored.attempts, 0, 'and the correct attempt does not count');
  assert.equal(await SignupToken.countDocuments(), 0);

  const again = await post(client, `/v1/auth/challenges/${start.body.id}/verify`, { code }, {}, flakyApp);
  assert.equal(again.status, 200, again.text);
  assert.equal((await completeSignup(client, again.body.signupToken, PASSWORD, {}, {}, flakyApp)).status, 201);
});

test('verify: giving the code back also gives back the attempt, so a right code on the 5th try is not locked out', async () => {
  let failures = 1;
  const base = createSignupTokenService({ now: clock.now });
  const flaky = { ...base, issue: async (input) => { if (failures-- > 0) throw new Error('database hiccup'); return base.issue(input); } };
  const flakyApp = buildApp({ signupTokens: flaky });
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email, {}, flakyApp);
  const code = mail.lastCodeFor(email);
  const wrong = code === '000000' ? '111111' : '000000';
  const verify = (c) => post(client, `/v1/auth/challenges/${start.body.id}/verify`, { code: c }, {}, flakyApp);
  for (let i = 0; i < 4; i += 1) assertProblem(await verify(wrong), 422, 'CODE_INCORRECT');
  assertProblem(await verify(code), 500, 'INTERNAL_ERROR'); // the 5th attempt, right code, token failure
  assert.equal((await Challenge.findById(start.body.id).lean()).attempts, 4);
  assert.equal((await verify(code)).status, 200, 'not locked: the code still works');
});

test('verify: after 5 wrong codes the challenge is locked, and no sign-up token can come out of it', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email);
  const code = mail.lastCodeFor(email);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i += 1) assertProblem(await verifyCode(client, start.body.id, wrong), 422, 'CODE_INCORRECT');
  assertProblem(await verifyCode(client, start.body.id, wrong), 423, 'CHALLENGE_LOCKED');
  assertProblem(await verifyCode(client, start.body.id, code), 423, 'CHALLENGE_LOCKED');
  assert.equal(await SignupToken.countDocuments(), 0);
});

test('verify: a challenge of another purpose cannot be used up here (reset and phone come in the next PR)', async () => {
  const client = newClient();
  const email = uniqueEmail();
  const challenges = createChallengeService({ now: clock.now, emailProvider: mail, smsProvider: sms, logger: silent });
  const reset = await challenges.start({ purpose: 'password_reset', channel: 'email', destination: email, installationId: client.installationId });
  const code = mail.lastCodeFor(email);
  assertProblem(await verifyCode(client, reset.id, code), 404, 'CHALLENGE_NOT_FOUND');
  const stored = await Challenge.findById(reset.id).lean();
  assert.equal(stored.verifiedAt, null, 'not used up');
  assert.equal(stored.attempts, 0, 'no attempt counted');
  assert.equal(await SignupToken.countDocuments(), 0);
  // It can still be read and resent: those work for every purpose.
  assert.equal((await get(client, `/v1/auth/challenges/${reset.id}`)).status, 200);
});

// ---------------------------------------------------------------------------
// The sign-up token
// ---------------------------------------------------------------------------

test('a sign-up token works once: the second use is 401 SIGNUP_TOKEN_INVALID and makes no second user', async () => {
  const client = newClient();
  const { signupToken, email } = await verifiedEmail(client);
  assert.equal((await completeSignup(client, signupToken)).status, 201);
  assertProblem(await completeSignup(client, signupToken), 401, 'SIGNUP_TOKEN_INVALID');
  assert.equal(await User.countDocuments({ email }), 1);
});

test('a sign-up token is good for 30 minutes, then 401 SIGNUP_TOKEN_EXPIRED', async () => {
  const early = newClient();
  const late = newClient();
  const first = await verifiedEmail(early);
  const second = await verifiedEmail(late);
  clock.advance(30 * MINUTE - SECOND);
  assert.equal((await completeSignup(early, first.signupToken)).status, 201, 'a second before the end it still works');
  clock.advance(2 * SECOND);
  assertProblem(await completeSignup(late, second.signupToken), 401, 'SIGNUP_TOKEN_EXPIRED');
  assert.equal(await User.countDocuments(), 1);
});

test('an unknown token, and a token from another install, are 401 SIGNUP_TOKEN_INVALID', async () => {
  const client = newClient();
  const { signupToken } = await verifiedEmail(client);
  assertProblem(await completeSignup(client, 'sgt_does-not-exist'), 401, 'SIGNUP_TOKEN_INVALID');
  assertProblem(await completeSignup(newClient(), signupToken), 401, 'SIGNUP_TOKEN_INVALID');
  // The real owner can still use it: those attempts did not use it up.
  assert.equal((await completeSignup(client, signupToken)).status, 201);
});

test('a weak password does not use the token up: fix the password and send again', async () => {
  const client = newClient();
  const { signupToken } = await verifiedEmail(client);
  assertProblem(await completeSignup(client, signupToken, 'alllowercase1!'), 422, 'VALIDATION_FAILED');
  assert.equal((await completeSignup(client, signupToken)).status, 201);
});

test('the same token sent twice at the same moment makes exactly one account', async () => {
  const client = newClient();
  const { signupToken, email } = await verifiedEmail(client);
  const results = await Promise.all([completeSignup(client, signupToken), completeSignup(client, signupToken), completeSignup(client, signupToken)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 401, 401]);
  assert.equal(await User.countDocuments({ email }), 1);
});

test('a failure that is not the client\'s fault gives the token back, so the request can be repeated', async () => {
  let failures = 1;
  const flaky = { ...defaultPasswords, hash: async (password) => { if (failures-- > 0) throw new Error('hashing broke'); return defaultPasswords.hash(password); } };
  const flakyApp = buildApp({ passwords: flaky });
  const client = newClient();
  const email = uniqueEmail();
  const start = await startSignup(client, email, {}, flakyApp);
  const verify = await verifyCode(client, start.body.id, mail.lastCodeFor(email));
  const first = await completeSignup(client, verify.body.signupToken, PASSWORD, {}, {}, flakyApp);
  assertProblem(first, 500, 'INTERNAL_ERROR');
  assert.equal(await User.countDocuments(), 0);
  const second = await completeSignup(client, verify.body.signupToken, PASSWORD, {}, {}, flakyApp);
  assert.equal(second.status, 201, second.text);
});

// ---------------------------------------------------------------------------
// Completing sign-up: duplicates, passwords, idempotency
// ---------------------------------------------------------------------------

test('complete: someone took the address since the code was sent: 409 EMAIL_TAKEN', async () => {
  const client = newClient();
  const { signupToken, email } = await verifiedEmail(client);
  await User.create({ email, password: 'x' });
  assertProblem(await completeSignup(client, signupToken), 409, 'EMAIL_TAKEN');
  assert.equal(await User.countDocuments({ email }), 1);
});

test('complete: two installs finish sign-up for the same address at once: one 201 and one 409 EMAIL_TAKEN', async () => {
  const email = uniqueEmail();
  const a = newClient();
  const b = newClient();
  const first = await verifiedEmail(a, email);
  const second = await verifiedEmail(b, email);
  const results = await Promise.all([completeSignup(a, first.signupToken), completeSignup(b, second.signupToken)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assertProblem(results.find((r) => r.status === 409), 409, 'EMAIL_TAKEN');
  assert.equal(await User.countDocuments({ email }), 1);
  assert.equal(await Session.countDocuments(), 1);
});

test('complete: a weak password is VALIDATION_FAILED with PASSWORD_POLICY_VIOLATION and the rules it breaks', async () => {
  const client = newClient();
  const { signupToken } = await verifiedEmail(client);
  const cases = [
    ['short', ['min_length', 'uppercase', 'digit', 'symbol']], // the spec check sees the length first
    ['alllowercase1!', ['uppercase']],
    ['NoDigitsHere!!', ['digit']],
    ['NoSymbolHere12', ['symbol']],
    ['nodigitsnosymbol', ['uppercase', 'digit', 'symbol']],
    ['a'.repeat(200), ['max_length', 'uppercase', 'digit', 'symbol']],
  ];
  for (const [password, unmet] of cases) {
    const res = await completeSignup(client, signupToken, password);
    assertProblem(res, 422, 'VALIDATION_FAILED');
    assert.equal(res.body.errors.length, 1, password);
    assert.equal(res.body.errors[0].field, '/password');
    assert.equal(res.body.errors[0].code, 'PASSWORD_POLICY_VIOLATION');
    assert.deepEqual(res.body.errors[0].meta.unmetRules, unmet, password);
    assert.ok(res.body.errors[0].message.length > 0);
    assert.ok(!res.text.includes(password), 'the password is not echoed');
  }
  assert.equal(await User.countDocuments(), 0);
});

test('complete: a password with no lowercase letter is fine, and any language works', async () => {
  const client = newClient();
  assert.equal((await signUp(client, { password: 'ALLUPPERCASE-123' })).res.status, 201);
  assert.equal((await signUp(newClient(), { password: 'Пароль-Длинный-1' })).res.status, 201);
});

test('complete: the device must be the install that sent the request', async () => {
  const client = newClient();
  const { signupToken } = await verifiedEmail(client);
  const res = await completeSignup(client, signupToken, PASSWORD, { device: { ...client.device, installationId: crypto.randomUUID() } });
  assertProblem(res, 422, 'VALIDATION_FAILED');
  assert.equal(res.body.errors[0].field, '/device/installationId');
  assert.equal(await SignupToken.countDocuments({ usedAt: { $ne: null } }), 0, 'the token was not used up');
});

test('complete: the preferred language is kept; a bad tag is a validation error', async () => {
  const client = newClient();
  const { signupToken, email } = await verifiedEmail(client);
  assert.equal((await completeSignup(client, signupToken, PASSWORD, { preferredLanguage: 'Not A Tag' })).status, 422);
  const res = await completeSignup(client, signupToken, PASSWORD, { preferredLanguage: 'hi' });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.user.preferredLanguage, 'hi');
  assert.equal((await User.findOne({ email }).lean()).preferredLanguage, 'hi');
});

test('complete: an Idempotency-Key replays the same Session without a second user or session', async () => {
  const client = newClient();
  const { signupToken, email } = await verifiedEmail(client);
  const key = { 'Idempotency-Key': crypto.randomUUID() };
  const first = await completeSignup(client, signupToken, PASSWORD, {}, key);
  const second = await completeSignup(client, signupToken, PASSWORD, {}, key);
  assert.equal(first.status, 201, first.text);
  assert.equal(second.status, 201, second.text);
  assert.deepEqual(second.body, first.body, 'the same tokens, not new ones');
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(await User.countDocuments({ email }), 1);
  assert.equal(await Session.countDocuments(), 1);
  // The same key with another body is not a retry.
  assertProblem(await completeSignup(client, signupToken, `${PASSWORD}x`, {}, key), 422, 'IDEMPOTENCY_KEY_REUSED');
});

test('complete: the token and the replayed tokens are not stored in plain text (the idempotency record is encrypted)', async () => {
  const client = newClient();
  const { signupToken } = await verifiedEmail(client);
  const res = await completeSignup(client, signupToken, PASSWORD, {}, { 'Idempotency-Key': crypto.randomUUID() });
  const everything = await wholeDatabase();
  assert.ok(!everything.includes(res.body.tokens.accessToken));
  assert.ok(!everything.includes(res.body.tokens.refreshToken));
  assert.ok(!everything.includes(signupToken));
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test('login: the right password signs in with a new session; the email is not case-sensitive', async () => {
  const { email, session } = await signUp();
  const client = newClient();
  const res = await login(client, email.toUpperCase());
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Session', res.body);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.isNewUser, false);
  assert.equal(res.body.user.id, session.user.id);
  assert.equal(res.body.session.signInMethod, 'password');
  assert.notEqual(res.body.session.id, session.session.id);
  assert.notEqual(res.body.tokens.refreshToken, session.tokens.refreshToken);
  assert.equal(await Session.countDocuments(), 2);
  const sessions = await get(client, '/v1/me/sessions', { Authorization: `Bearer ${res.body.tokens.accessToken}` });
  assert.equal(sessions.body.data.length, 2);
});

test('login: an unknown email and a wrong password give exactly the same answer', async () => {
  const { email } = await signUp();
  const client = newClient();
  const unknown = await login(client, 'nobody-here@example.com');
  const wrong = await login(client, email, wrongPassword);
  assertProblem(unknown, 401, 'INVALID_CREDENTIALS');
  assertProblem(wrong, 401, 'INVALID_CREDENTIALS');
  assert.deepEqual(withoutRequestId(unknown.body), withoutRequestId(wrong.body));
  assert.equal(unknown.headers['content-type'], wrong.headers['content-type']);
  assert.equal(unknown.headers['www-authenticate'], wrong.headers['www-authenticate']);
});

test('login: an unknown email still costs a real password check (the dummy hash), so it is not faster', async () => {
  const checks = [];
  const spy = { ...defaultPasswords, verify: async (stored, password) => { checks.push(stored); return defaultPasswords.verify(stored, password); } };
  const spyApp = buildApp({ passwords: spy });
  const client = newClient();
  await signUp(newClient(), { email: 'known@example.com' });
  await login(client, 'known@example.com', wrongPassword, spyApp);
  await login(client, 'unknown@example.com', wrongPassword, spyApp);
  assert.equal(checks.length, 2);
  assert.match(checks[0], /^\$argon2id\$/);
  assert.match(checks[1], /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/, 'a dummy with the same cost');
  assert.equal(checks[1], await defaultPasswords.dummyHash());
  assert.notEqual(checks[0], checks[1]);
});

test('login: bad input is a validation error; the device must match the install', async () => {
  const client = newClient();
  assertProblem(await post(client, '/v1/auth/login', { email: 'a@example.com', device: client.device }), 422, 'VALIDATION_FAILED');
  const res = await post(client, '/v1/auth/login', { email: 'a@example.com', password: PASSWORD, device: { ...client.device, installationId: crypto.randomUUID() } });
  assertProblem(res, 422, 'VALIDATION_FAILED');
  assert.equal(res.body.errors[0].field, '/device/installationId');
});

// ---------------------------------------------------------------------------
// Login lockout
// ---------------------------------------------------------------------------

test('lockout: the 5th failure in 15 minutes locks the account for 15 minutes, even for the right password; then it unlocks', async () => {
  const { email } = await signUp();
  const client = newClient();
  for (let i = 1; i <= 4; i += 1) assertProblem(await login(client, email, wrongPassword), 401, 'INVALID_CREDENTIALS');

  const locking = await login(client, email, wrongPassword);
  assertProblem(locking, 423, 'ACCOUNT_LOCKED');
  assert.equal(locking.body.retryAfterSeconds, 900);
  assert.equal(locking.headers['retry-after'], '900');
  assert.equal(LOGIN_RULES.lockMs, 15 * MINUTE);

  // Locked: the right password is refused too, and the wait counts down.
  clock.advance(5 * MINUTE);
  const stillLocked = await login(client, email, PASSWORD);
  assertProblem(stillLocked, 423, 'ACCOUNT_LOCKED');
  assert.equal(stillLocked.body.retryAfterSeconds, 600);
  assert.equal(stillLocked.headers['retry-after'], '600');
  assert.equal(await Session.countDocuments(), 1, 'no session was made');

  // Just before the end of the lock: still locked. A wrong password while locked does not extend it.
  clock.advance(10 * MINUTE - 5 * SECOND);
  const almost = await login(client, email, wrongPassword);
  assertProblem(almost, 423, 'ACCOUNT_LOCKED');
  assert.equal(almost.body.retryAfterSeconds, 5);

  clock.advance(5 * SECOND);
  const open = await login(client, email, PASSWORD);
  assert.equal(open.status, 200, open.text);
  const stored = await User.findOne({ email }).lean();
  assert.equal(stored.loginFailedCount, 0, 'a good login clears the count');
  assert.equal(stored.loginLockedUntil, null);
});

test('lockout: the lock is per account: other accounts, and a fresh start after unlocking, are unaffected', async () => {
  const a = await signUp();
  const b = await signUp();
  const client = newClient();
  for (let i = 1; i <= 5; i += 1) await login(client, a.email, wrongPassword);
  assertProblem(await login(client, a.email, PASSWORD), 423, 'ACCOUNT_LOCKED');
  assert.equal((await login(client, b.email, PASSWORD)).status, 200);
  // After the lock the count starts again: four more failures do not lock.
  clock.advance(15 * MINUTE + SECOND);
  for (let i = 1; i <= 4; i += 1) assertProblem(await login(client, a.email, wrongPassword), 401, 'INVALID_CREDENTIALS');
  assert.equal((await login(client, a.email, PASSWORD)).status, 200);
});

test('lockout: the right password on the 5th try still works, and clears the count', async () => {
  const { email } = await signUp();
  const client = newClient();
  for (let i = 1; i <= 4; i += 1) await login(client, email, wrongPassword);
  assert.equal((await login(client, email, PASSWORD)).status, 200);
  for (let i = 1; i <= 4; i += 1) assertProblem(await login(client, email, wrongPassword), 401, 'INVALID_CREDENTIALS');
});

test('lockout: failures more than 15 minutes apart do not add up', async () => {
  const { email } = await signUp();
  const client = newClient();
  for (let i = 1; i <= 4; i += 1) assertProblem(await login(client, email, wrongPassword), 401, 'INVALID_CREDENTIALS');
  clock.advance(15 * MINUTE + SECOND);
  for (let i = 1; i <= 4; i += 1) assertProblem(await login(client, email, wrongPassword), 401, 'INVALID_CREDENTIALS');
  const stored = await User.findOne({ email }).lean();
  assert.equal(stored.loginFailedCount, 4);
  assert.equal(stored.loginLockedUntil, null);
});

test('lockout: guesses sent at the same moment cannot get past the limit', async () => {
  const { email } = await signUp();
  let checked = 0;
  const counting = { ...defaultPasswords, verify: async (stored, password) => { checked += 1; return defaultPasswords.verify(stored, password); } };
  const countingApp = buildApp({ passwords: counting });
  const client = newClient();
  const results = await Promise.all(Array.from({ length: 12 }, () => login(client, email, wrongPassword, countingApp)));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 4, statuses.join());
  assert.equal(statuses.filter((s) => s === 423).length, 8, statuses.join());
  assert.equal(checked, 5, 'only five of the twelve guesses were ever checked');
});

test('lockout is kept apart from the admin panel\'s block: the old fields are not touched', async () => {
  const { email } = await signUp();
  const client = newClient();
  for (let i = 1; i <= 5; i += 1) await login(client, email, wrongPassword);
  const stored = await User.findOne({ email }).lean();
  assert.ok(stored.loginLockedUntil instanceof Date);
  assert.equal(stored.isBlocked, false);
  assert.equal(stored.blockedUntil, null);
  assert.equal(stored.failedLoginAttempts, 0);
});

test('lockout does not reveal accounts: an unknown email gets the same answers as a real one, attempt for attempt', async () => {
  const { email } = await signUp();
  const unknown = 'nobody-at-all@example.com';
  const realClient = newClient();
  const unknownClient = newClient();
  const strip = (res) => ({
    status: res.status,
    body: withoutRequestId(res.body),
    retryAfter: res.headers['retry-after'],
    contentType: res.headers['content-type'],
    authenticate: res.headers['www-authenticate'],
  });
  const statuses = [];
  for (let i = 1; i <= 6; i += 1) {
    const real = await login(realClient, email, wrongPassword);
    const fake = await login(unknownClient, unknown, wrongPassword);
    assert.deepEqual(strip(fake), strip(real), `attempt ${i}`);
    statuses.push(fake.status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 423, 423]);
  assert.equal((await login(unknownClient, unknown, wrongPassword)).headers['retry-after'], '900');

  // The same wait counts down the same way, and the lock ends after the same 15 minutes.
  clock.advance(5 * MINUTE);
  const realLater = await login(realClient, email, wrongPassword);
  const fakeLater = await login(unknownClient, unknown, wrongPassword);
  assert.equal(fakeLater.body.retryAfterSeconds, 600);
  assert.deepEqual(strip(fakeLater), strip(realLater));
  clock.advance(10 * MINUTE + SECOND);
  assertProblem(await login(unknownClient, unknown, wrongPassword), 401, 'INVALID_CREDENTIALS');
  assert.equal((await login(realClient, email, PASSWORD)).status, 200);
});

test('lockout for an unknown email is kept in a small hashed record that cleans itself up, never on a user', async () => {
  const unknown = 'Nobody.Here@Example.com';
  const client = newClient();
  const usersBefore = JSON.stringify(await User.find({}).lean());
  for (let i = 1; i <= 5; i += 1) await login(client, unknown, wrongPassword);

  const records = await LoginAttempt.find({}).lean();
  assert.equal(records.length, 1);
  const [record] = records;
  assert.match(record._id, /^[0-9a-f]{64}$/, 'a SHA-256 of the normalised address');
  assert.equal(record._id, crypto.createHash('sha256').update('nobody.here@example.com').digest('hex'), 'the case of the address does not matter');
  assert.equal(record.loginFailedCount, 5);
  assert.ok(record.loginLockedUntil instanceof Date);
  assert.ok(record.purgeAt.getTime() > record.loginLockedUntil.getTime(), 'it is deleted after the lock is over');
  assert.ok(!JSON.stringify(record).toLowerCase().includes('nobody'), 'the address is not stored');
  assert.equal(JSON.stringify(await User.find({}).lean()), usersBefore, 'no user was touched');
  const indexes = await LoginAttempt.collection.indexes();
  assert.ok(indexes.some((i) => i.key.purgeAt === 1 && i.expireAfterSeconds === 0), 'a TTL index');
});

test('lockout: guesses at an unknown email sent at the same moment are counted exactly, too', async () => {
  const client = newClient();
  const results = await Promise.all(Array.from({ length: 12 }, () => login(client, 'ghost@example.com', wrongPassword)));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 4, statuses.join());
  assert.equal(statuses.filter((s) => s === 423).length, 8, statuses.join());
  assert.equal((await LoginAttempt.countDocuments()), 1);
});

test('an account with no password hash this API can read is checked against the dummy hash, and refused like any wrong password', async () => {
  const checks = [];
  const spy = { ...defaultPasswords, verify: async (stored, password) => { checks.push(stored); return defaultPasswords.verify(stored, password); } };
  const spyApp = buildApp({ passwords: spy });
  const dummy = await defaultPasswords.dummyHash();
  const unreadable = [
    ['no password at all', {}],
    ['an empty password', { password: '' }],
    ['plain text', { password: 'not-a-hash-it-is-the-password' }],
    ['an unknown scheme', { password: '$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA' }],
  ];
  const client = newClient();
  const wrong = await login(client, 'someone-else@example.com', PASSWORD, spyApp); // for comparison: no account
  checks.length = 0;
  for (const [label, extra] of unreadable) {
    const email = `unreadable-${(counter += 1)}@example.com`;
    await User.collection.insertOne({ email, createdAt: new Date(), ...extra });
    const res = await login(client, email, label === 'plain text' ? 'not-a-hash-it-is-the-password' : PASSWORD, spyApp);
    assertProblem(res, 401, 'INVALID_CREDENTIALS');
    assert.deepEqual(withoutRequestId(res.body), withoutRequestId(wrong.body), label);
    assert.deepEqual(checks, [dummy], `${label}: one real hash check, against the dummy`);
    checks.length = 0;
  }
  // And such an account locks like every other.
  const email = `unreadable-${(counter += 1)}@example.com`;
  await User.collection.insertOne({ email, createdAt: new Date() });
  for (let i = 1; i <= 4; i += 1) assertProblem(await login(client, email, PASSWORD, spyApp), 401, 'INVALID_CREDENTIALS');
  assertProblem(await login(client, email, PASSWORD, spyApp), 423, 'ACCOUNT_LOCKED');
});

test('verify: an argon2id hash that is damaged is refused after the work of a real check, so it is not faster either', async () => {
  const started = process.hrtime.bigint();
  assert.equal(await defaultPasswords.verify('$argon2id$v=19$m=19456,t=2,p=1$damaged$damaged', PASSWORD), false);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms >= 10, `a damaged hash took only ${ms.toFixed(1)} ms`);
});

// ---------------------------------------------------------------------------
// Login: suspended accounts
// ---------------------------------------------------------------------------

test('suspended: an account an admin blocked is 403 ACCOUNT_SUSPENDED, but only after the right password', async () => {
  const { email } = await signUp();
  const client = newClient();
  await User.updateOne({ email }, { $set: { isBlocked: true, blockedUntil: null } });
  assertProblem(await login(client, email, wrongPassword), 401, 'INVALID_CREDENTIALS');
  assertProblem(await login(client, email, PASSWORD), 403, 'ACCOUNT_SUSPENDED');
  assert.equal(await Session.countDocuments(), 1, 'no new session');

  await User.updateOne({ email }, { $set: { blockedUntil: new Date(clock.t + 60 * MINUTE) } });
  assertProblem(await login(client, email, PASSWORD), 403, 'ACCOUNT_SUSPENDED');
  // A block that has ended no longer counts (the old API treats it the same way).
  await User.updateOne({ email }, { $set: { blockedUntil: new Date(clock.t - SECOND) } });
  assert.equal((await login(client, email, PASSWORD)).status, 200);
});

// ---------------------------------------------------------------------------
// Login: accounts made by the old API
// ---------------------------------------------------------------------------

test('legacy: a bcrypt user signs in and the hash is replaced by argon2id; the next login works the same', async () => {
  const oldHash = await bcrypt.hash('OldPass123!', 10);
  const { insertedId } = await User.collection.insertOne({
    email: 'Old.Timer@Example.com', password: oldHash, name: 'Old Timer', gender: 'other', preferredLanguage: 'English',
    dateOfBirth: '1990-05-17', phone: '12345', createdAt: new Date('2025-01-01T00:00:00Z'),
  });
  const client = newClient();

  assertProblem(await login(client, 'old.timer@example.com', 'OldPass123'), 401, 'INVALID_CREDENTIALS');
  assert.equal((await User.findById(insertedId).lean()).password, oldHash, 'a failed login changes nothing');

  const res = await login(client, 'old.timer@example.com', 'OldPass123!');
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Session', res.body);
  assert.equal(res.body.isNewUser, false);

  const stored = await User.findById(insertedId).lean();
  assert.match(stored.password, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(stored.passwordAlgo, 'argon2id');
  assert.ok(!('emailNormalized' in stored), 'nothing is written to the user but the new hash');
  assert.equal(stored.email, 'Old.Timer@Example.com', 'the stored email is not rewritten');
  assert.equal(await defaultPasswords.verify(stored.password, 'OldPass123!'), true);

  assert.equal((await login(client, 'OLD.TIMER@example.com', 'OldPass123!')).status, 200);
  assert.equal((await User.findById(insertedId).lean()).password, stored.password, 'no second upgrade');
});

test('legacy: values the spec does not allow are reported as null, so the response still matches the spec', async () => {
  await User.collection.insertOne({
    email: 'odd@example.com', password: await bcrypt.hash('OldPass123!', 4), name: '   ', gender: 'other', preferredLanguage: 'English',
    dateOfBirth: '17/05/1990', phone: '12345', profileImage: '/uploads/me.png', createdAt: new Date('2025-01-01T00:00:00Z'),
  });
  const res = await login(newClient(), 'odd@example.com', 'OldPass123!');
  assert.equal(res.status, 200, res.text);
  const { user } = res.body;
  assertMatchesSpec('User', user);
  assert.equal(user.name, null);
  assert.equal(user.gender, 'prefer_not_to_say');
  assert.equal(user.preferredLanguage, null);
  assert.equal(user.dateOfBirth, null);
  assert.equal(user.phoneNumber, null);
  assert.equal(user.avatar, null);
  assert.equal(user.updatedAt, user.createdAt, 'no updatedAt stored: the creation time stands in');
});

test('legacy: a failure while upgrading the stored credentials never fails the login, and nothing secret is logged', async () => {
  const oldPassword = 'OldPass123!';
  const oldHash = await bcrypt.hash(oldPassword, 4);
  await User.collection.insertOne({ email: 'upgrade@example.com', password: oldHash, createdAt: new Date() });
  const logged = [];
  const recording = { debug: (...a) => logged.push(a), info: (...a) => logged.push(a), warn: (...a) => logged.push(a), error: (...a) => logged.push(a) };
  const brokenUsers = { ...usersRepo, replacePasswordHash: async () => { throw new Error(`the database said no (${oldPassword})`); } };
  const brokenApp = buildApp({ users: brokenUsers, logger: recording });
  const res = await login(newClient(), 'upgrade@example.com', oldPassword, brokenApp);
  assert.equal(res.status, 200, res.text);
  assert.equal((await User.findOne({ email: 'upgrade@example.com' }).lean()).password, oldHash, 'still the old hash');
  assert.equal(logged.length, 1);
  const text = JSON.stringify(logged);
  for (const secret of [oldPassword, oldHash, res.body.tokens.accessToken, res.body.tokens.refreshToken]) {
    assert.ok(!text.includes(secret), 'a secret was logged');
  }
});

// ---------------------------------------------------------------------------
// Rate limits (x-rate-limit in docs/api/paths/auth.yaml)
// ---------------------------------------------------------------------------

const assertRateLimited = (res) => {
  assertProblem(res, 429, 'RATE_LIMITED');
  assert.ok(Number(res.headers['retry-after']) >= 1);
  assert.equal(res.headers['retry-after'], String(res.body.retryAfterSeconds));
  assert.match(res.headers.ratelimit, /remaining=0/);
};

test('rate limit: availability allows 30 an hour per IP address, then 429', async () => {
  const ip = ipFor((counter += 1));
  for (let i = 0; i < 30; i += 1) {
    const res = await post(newClient(), '/v1/auth/email/availability', { email: uniqueEmail() }, { 'X-Forwarded-For': ip });
    assert.equal(res.status, 200, `request ${i + 1}: ${res.text}`);
  }
  assertRateLimited(await post(newClient(), '/v1/auth/email/availability', { email: uniqueEmail() }, { 'X-Forwarded-For': ip }));
});

test('rate limit: availability allows 20 an hour per install, then 429', async () => {
  const client = newClient();
  for (let i = 0; i < 20; i += 1) {
    const res = await post(client, '/v1/auth/email/availability', { email: uniqueEmail() }, { 'X-Forwarded-For': ipFor((counter += 1)) });
    assert.equal(res.status, 200, `request ${i + 1}: ${res.text}`);
  }
  assertRateLimited(await post(client, '/v1/auth/email/availability', { email: uniqueEmail() }, { 'X-Forwarded-For': ipFor((counter += 1)) }));
});

test('rate limit: starting sign-up allows 10 an hour per install, then 429 and nothing is sent', async () => {
  const client = newClient();
  for (let i = 0; i < 10; i += 1) {
    const res = await startSignup(client, uniqueEmail(), { 'X-Forwarded-For': ipFor((counter += 1)) });
    assert.equal(res.status, 202, `request ${i + 1}: ${res.text}`);
  }
  mail.clear();
  assertRateLimited(await startSignup(client, uniqueEmail(), { 'X-Forwarded-For': ipFor((counter += 1)) }));
  assert.equal(mail.sent.length, 0);
});

test('rate limit: starting sign-up allows 20 an hour per IP address, then 429', async () => {
  const ip = ipFor((counter += 1));
  for (let i = 0; i < 20; i += 1) {
    const res = await startSignup(newClient(), uniqueEmail(), { 'X-Forwarded-For': ip });
    assert.equal(res.status, 202, `request ${i + 1}: ${res.text}`);
  }
  assertRateLimited(await startSignup(newClient(), uniqueEmail(), { 'X-Forwarded-For': ip }));
});

test('rate limit: checking codes allows 60 an hour per IP address, then 429', async () => {
  const client = newClient();
  const ghost = 'a'.repeat(24);
  for (let i = 0; i < 60; i += 1) {
    assertProblem(await verifyCode(client, ghost, '123456'), 404, 'CHALLENGE_NOT_FOUND');
  }
  assertRateLimited(await verifyCode(client, ghost, '123456'));
});

test('rate limit: login allows 50 an hour per IP address, then 429', async () => {
  const client = newClient();
  for (let i = 0; i < 50; i += 1) {
    assertProblem(await login(client, `nobody${i}@example.com`), 401, 'INVALID_CREDENTIALS');
  }
  assertRateLimited(await login(client, 'nobody@example.com'));
});

// ---------------------------------------------------------------------------
// The old routes are still there
// ---------------------------------------------------------------------------

test('the old /user routes are still mounted (the app uses them until it moves to /v1)', async () => {
  // Routed, not 404: the old API answers a missing body with its own 400.
  const res = await request(app).post('/user/send-otp').send({});
  assert.notEqual(res.status, 404);
});
