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
const { createAuthService, LOGIN_RULES } = require('../src/modules/auth/service');
const { createAuthRouter } = require('../src/modules/auth/routes');
const passwords = require('../src/lib/passwords');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { createMemorySmsProvider } = require('../src/providers/sms/memory');
const ResetToken = require('../models/ResetToken');
const Session = require('../models/Session');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem } = require('./support/api');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const OLD_PASSWORD = 'Correct-Horse-9';
const NEW_PASSWORD = 'Battery-Staple-7!';

// A fake clock for the services (challenges, reset tokens, login lockout). Sessions use the real clock.
const clock = { t: 0, now: () => clock.t, advance(ms) { clock.t += ms; } };
const mail = createMemoryEmailProvider();
const notices = createMemoryEmailProvider();
const sms = createMemorySmsProvider();
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function buildApp(deps = {}) {
  const challenges = createChallengeService({ now: clock.now, emailProvider: mail, smsProvider: sms, logger: silent });
  const service = createAuthService({ now: clock.now, challenges, emailProvider: notices, logger: silent, ...deps });
  return createApp({ trustProxy: 1, authRouter: createAuthRouter({ service }) });
}
const app = buildApp();

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
  notices.clear();
  sms.clear();
  clock.t = Date.now();
});
after(db.disconnect);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
const uniqueEmail = () => `reset${(counter += 1)}@example.com`;
const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

function newClient() {
  counter += 1;
  const installationId = crypto.randomUUID();
  return {
    installationId,
    headers: {
      'X-Client-Platform': 'android',
      'X-Client-Version': '1.4.0',
      'X-Installation-Id': installationId,
      'X-Forwarded-For': ipFor(counter),
    },
    device: { installationId, platform: 'android', appVersion: '1.4.0+42', model: 'Pixel 9' },
  };
}

const post = (client, path, body, extra = {}) => request(app).post(path).set({ ...client.headers, ...extra }).send(body);
const startReset = (client, email, extra) => post(client, '/v1/auth/password-reset', { email }, extra);
const verify = (client, challengeId, code) => post(client, `/v1/auth/challenges/${challengeId}/verify`, { code });
const complete = (client, resetToken, newPassword = NEW_PASSWORD, extra) =>
  post(client, '/v1/auth/password-reset/complete', { resetToken, newPassword, device: client.device }, extra);
const login = (client, email, password) => post(client, '/v1/auth/login', { email, password, device: client.device });

/** An account with a password, straight in the database. */
async function makeAccount({ email = uniqueEmail(), password = OLD_PASSWORD, hash, ...extra } = {}) {
  const stored = hash ?? await passwords.hash(password);
  const user = await User.create({ email, password: stored, passwordAlgo: stored.startsWith('$argon2id$') ? 'argon2id' : 'bcrypt', ...extra });
  return { user, email, password };
}

/** Start a reset and verify the code that arrived: returns the reset token. */
async function resetTokenFor(client, email) {
  const start = await startReset(client, email);
  assert.equal(start.status, 202, start.text);
  const code = mail.lastCodeFor(email);
  assert.match(code, /^\d{6}$/, 'a code was emailed');
  const verified = await verify(client, start.body.id, code);
  assert.equal(verified.status, 200, verified.text);
  return { start, verified, resetToken: verified.body.resetToken };
}

// ---------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------

test('reset end to end: code, verify, new password; every other device is signed out', async () => {
  const { user, email } = await makeAccount();
  const elsewhere = newClient();
  const other = await login(elsewhere, email, OLD_PASSWORD);
  assert.equal(other.status, 200, other.text);

  const client = newClient();
  const { start, verified, resetToken } = await resetTokenFor(client, email);
  assertMatchesSpec('Challenge', start.body);
  assert.equal(start.body.purpose, 'password_reset');
  assert.equal(start.body.channel, 'email');
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].purpose, 'password_reset');

  assertMatchesSpec('ChallengeVerification', verified.body);
  assert.deepEqual(Object.keys(verified.body).sort(), ['purpose', 'resetToken', 'resetTokenExpiresAt']);
  assert.equal(verified.body.purpose, 'password_reset');
  assert.match(resetToken, /^rst_[A-Za-z0-9_-]{43}$/);
  const expected = new Date(Math.floor(clock.t / SECOND) * SECOND + 15 * MINUTE).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.equal(verified.body.resetTokenExpiresAt, expected, 'valid for 15 minutes');
  assert.equal(verified.headers['cache-control'], 'no-store');

  const done = await complete(client, resetToken);
  assert.equal(done.status, 200, done.text);
  assertMatchesSpec('Session', done.body);
  assert.equal(done.headers['cache-control'], 'no-store');
  assert.equal(done.body.isNewUser, false);
  assert.equal(done.body.user.id, String(user._id));
  assert.equal(done.body.session.signInMethod, 'password_reset');

  // The device that knew the old password is signed out; this one is not.
  const sessions = await Session.find({ userId: user._id }).lean();
  const revoked = sessions.filter((s) => s.revokedAt);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].revokeReason, 'password_reset');
  assert.equal(String(sessions.find((s) => !s.revokedAt)._id), done.body.session.id);
  const refreshOld = await post(elsewhere, '/v1/auth/token/refresh', { refreshToken: other.body.tokens.refreshToken });
  assertProblem(refreshOld, 401, 'SESSION_REVOKED');

  // Old password out, new one in; the hash is argon2id.
  assertProblem(await login(newClient(), email, OLD_PASSWORD), 401, 'INVALID_CREDENTIALS');
  assert.equal((await login(newClient(), email, NEW_PASSWORD)).status, 200);
  const stored = await User.findById(user._id).lean();
  assert.match(stored.password, /^\$argon2id\$/);
  assert.equal(stored.passwordAlgo, 'argon2id');

  // The owner is told by email.
  assert.deepEqual(notices.notices, [{ to: email, notice: 'password_changed' }]);
});

test('an old bcrypt account can reset too', async () => {
  const email = uniqueEmail();
  await makeAccount({ email, hash: bcrypt.hashSync(OLD_PASSWORD, 4) });
  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  assert.equal((await complete(client, resetToken)).status, 200);
  assert.equal((await login(newClient(), email, NEW_PASSWORD)).status, 200);
});

test('a mixed-case old email is found, and the code goes to the normalised address', async () => {
  const { user } = await makeAccount({ email: 'Legacy.Person@Example.com' });
  const client = newClient();
  const start = await startReset(client, 'legacy.person@example.com');
  assert.equal(start.status, 202);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, 'legacy.person@example.com');
  const verified = await verify(client, start.body.id, mail.lastCodeFor('legacy.person@example.com'));
  const done = await complete(client, verified.body.resetToken);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.user.id, String(user._id));
});

// ---------------------------------------------------------------------------
// Nothing to learn about which accounts exist
// ---------------------------------------------------------------------------

test('an unknown email gets the same answer, nothing is sent and no code works', async () => {
  const { email: real } = await makeAccount();
  const a = await startReset(newClient(), real);
  const unknownClient = newClient();
  const b = await startReset(unknownClient, 'nobody@example.com');
  assert.equal(b.status, 202, b.text);
  assertMatchesSpec('Challenge', b.body);
  const shape = ({ id, destination, expiresAt, resendAvailableAt, ...rest }) => rest;
  assert.deepEqual(shape(b.body), shape(a.body), 'same fields and values apart from ids, times and the masked address');
  assert.equal(mail.sent.length, 1, 'only the real account got mail');

  for (let i = 1; i < 5; i += 1) {
    const res = await verify(unknownClient, b.body.id, String(100000 + i));
    assertProblem(res, 422, 'CODE_INCORRECT');
  }
  assertProblem(await verify(unknownClient, b.body.id, '123456'), 423, 'CHALLENGE_LOCKED');
});

test('accounts that cannot use a password reset get a decoy as well', async () => {
  // No usable password hash (a social-only or broken account), and an account an admin blocked.
  const { email: noHash } = await makeAccount({ hash: 'not-a-hash' });
  const { email: blocked } = await makeAccount({ isBlocked: true });
  for (const email of [noHash, blocked]) {
    const res = await startReset(newClient(), email);
    assert.equal(res.status, 202, res.text);
  }
  assert.equal(mail.sent.length, 0);
});

test('an invalid email is refused', async () => {
  assertProblem(await startReset(newClient(), 'not an email'), 422, 'VALIDATION_FAILED');
  assertProblem(await startReset(newClient(), 'a@b'), 422, 'EMAIL_INVALID');
});

test('a reset code cannot be used for sign-up, and a sign-up token cannot reset', async () => {
  const { email } = await makeAccount();
  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  const signup = await post(client, '/v1/auth/signup/complete', { signupToken: resetToken, password: NEW_PASSWORD, device: client.device });
  assertProblem(signup, 401, 'SIGNUP_TOKEN_INVALID');
  assertProblem(await complete(client, 'sgt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 401, 'RESET_TOKEN_INVALID');
  // The reset token was not spent by the failed sign-up.
  assert.equal((await complete(client, resetToken)).status, 200);
});

// ---------------------------------------------------------------------------
// The new password and the token
// ---------------------------------------------------------------------------

test('a weak new password is refused and the token still works', async () => {
  const { email } = await makeAccount();
  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  const weak = await complete(client, resetToken, 'weakpass');
  assertProblem(weak, 422, 'VALIDATION_FAILED');
  assert.equal(weak.body.errors[0].field, '/newPassword');
  assert.equal(weak.body.errors[0].code, 'PASSWORD_POLICY_VIOLATION');
  assert.equal((await complete(client, resetToken)).status, 200);
});

test('the current password is refused as the new one, and the token still works', async () => {
  const { email } = await makeAccount();
  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  const same = await complete(client, resetToken, OLD_PASSWORD);
  assertProblem(same, 422, 'VALIDATION_FAILED');
  assert.equal(same.body.errors[0].code, 'PASSWORD_REUSED');
  assert.equal(same.body.errors[0].field, '/newPassword');
  assert.equal((await complete(client, resetToken)).status, 200);
});

test('a reset token works once, only from its install, and only for 15 minutes', async () => {
  const { email } = await makeAccount();
  const client = newClient();
  const first = await resetTokenFor(client, email);
  assertProblem(await complete(newClient(), first.resetToken), 401, 'RESET_TOKEN_INVALID');
  assert.equal((await complete(client, first.resetToken)).status, 200);
  assertProblem(await complete(client, first.resetToken, 'Another-Pass-77!'), 401, 'RESET_TOKEN_INVALID');

  clock.advance(MINUTE); // past the resend cooldown
  const second = await resetTokenFor(client, email);
  clock.advance(15 * MINUTE + SECOND);
  assertProblem(await complete(client, second.resetToken, 'Another-Pass-77!'), 401, 'RESET_TOKEN_EXPIRED');
});

test('only the hash of a reset token is stored', async () => {
  const { email } = await makeAccount();
  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  const stored = JSON.stringify(await ResetToken.find({}).lean());
  assert.ok(!stored.includes(resetToken));
  assert.ok(!stored.includes(resetToken.slice(4)));
  const all = [];
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    all.push(JSON.stringify(await mongoose.connection.db.collection(name).find({}).toArray()));
  }
  assert.ok(!all.join('\n').includes(NEW_PASSWORD));
});

test('a blocked account cannot finish a reset that started before the block', async () => {
  const { user, email } = await makeAccount();
  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  await User.updateOne({ _id: user._id }, { $set: { isBlocked: true } });
  assertProblem(await complete(client, resetToken), 401, 'RESET_TOKEN_INVALID');
});

test('a reset clears the login lock', async () => {
  const { email } = await makeAccount();
  const attacker = newClient();
  for (let i = 0; i < LOGIN_RULES.maxAttempts; i += 1) await login(attacker, email, 'Wrong-Horse-1234!');
  assertProblem(await login(newClient(), email, OLD_PASSWORD), 423, 'ACCOUNT_LOCKED');

  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  assert.equal((await complete(client, resetToken)).status, 200);
  assert.equal((await login(newClient(), email, NEW_PASSWORD)).status, 200);
});

test('repeating the completion with the same Idempotency-Key replays it', async () => {
  const { user, email } = await makeAccount();
  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  const key = crypto.randomUUID();
  const first = await complete(client, resetToken, NEW_PASSWORD, { 'Idempotency-Key': key });
  const again = await complete(client, resetToken, NEW_PASSWORD, { 'Idempotency-Key': key });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.equal(again.body.session.id, first.body.session.id);
  assert.equal(await Session.countDocuments({ userId: user._id, revokedAt: null }), 1);
});

test('a failing "password changed" email does not fail the reset', async () => {
  const { email } = await makeAccount();
  const client = newClient();
  const { resetToken } = await resetTokenFor(client, email);
  notices.failNext();
  assert.equal((await complete(client, resetToken)).status, 200);
});

test('reset codes share the 5-per-24-hours limit per address', async () => {
  const { email } = await makeAccount();
  const client = newClient();
  for (let i = 0; i < 5; i += 1) {
    const res = await startReset(client, email);
    assert.equal(res.status, 202, res.text);
    clock.advance(11 * MINUTE); // expire it, so the next start sends a new code
  }
  assertProblem(await startReset(client, email), 429, 'SEND_LIMIT_REACHED');
});
