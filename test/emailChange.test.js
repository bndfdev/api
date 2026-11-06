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
const { createChallengeService } = require('../src/modules/challenges/service');
const { createAuthService } = require('../src/modules/auth/service');
const { createAuthRouter } = require('../src/modules/auth/routes');
const { createEmailChangeService } = require('../src/modules/email/service');
const { createEmailRouter, LIMITS } = require('../src/modules/email/routes');
const { createCredentialsService } = require('../src/modules/credentials/service');
const { createCredentialsRouter } = require('../src/modules/credentials/routes');
const { createReauthTokenService } = require('../src/modules/reauthTokens/service');
const { createReauthCheck } = require('../src/modules/reauthTokens/check');
const { maskDestination } = require('../src/lib/destination');
const { emailMessage, noticeEmail } = require('../src/providers/messages');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { createMemorySmsProvider } = require('../src/providers/sms/memory');
const passwords = require('../src/lib/passwords');
const User = require('../models/User');
const Challenge = require('../models/Challenge');
const ReauthToken = require('../models/ReauthToken');
const { sha256 } = require('../src/lib/secrets');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PASSWORD = 'Correct-Horse-9';
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mail = createMemoryEmailProvider();
const sms = createMemorySmsProvider();

// The clock of the reauth tokens (issued and checked): the real time, unless a test sets `at` (epoch ms).
const clock = { at: null, now: () => clock.at ?? Date.now() };
const reauthTokens = createReauthTokenService({ now: clock.now });

/** An app with memory providers, and the real reauth tokens on `clock`. */
function buildApp({ codesConfig } = {}) {
  const cfg = codesConfig ? { ...config, codes: { ...config.codes, ...codesConfig } } : config;
  const challenges = createChallengeService({ config: cfg, emailProvider: mail, smsProvider: sms, logger: silent });
  const emailChange = createEmailChangeService({ challenges, emailProvider: mail, logger: silent });
  const auth = createAuthService({ challenges, emailChange, emailProvider: mail, logger: silent });
  const credentials = createCredentialsService({ now: clock.now, reauthTokens, emailProvider: mail, logger: silent });
  return createApp({
    trustProxy: 1,
    authRouter: createAuthRouter({ service: auth }),
    emailRouter: createEmailRouter({ service: emailChange, reauth: createReauthCheck({ tokens: reauthTokens, logger: silent }) }),
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

before(async () => {
  await db.connect();
  await passwords.dummyHash();
});
beforeEach(async () => {
  await db.clear();
  mail.clear();
  sms.clear();
  clock.at = null;
});
after(db.disconnect);

let counter = 0;
const uniqueEmail = (prefix = 'user') => `${prefix}${(counter += 1)}@example.com`;
const ipFor = (n) => `10.7.${(n >> 8) & 255}.${n & 255}`;

/** A user with the password PASSWORD. */
const passwordUser = async (extra = {}) =>
  makeUser({ email: uniqueEmail('old'), password: await passwords.hash(PASSWORD), passwordAlgo: 'argon2id', ...extra });
/** A signed-in account (its own install and IP) with a password. */
async function account(extra = {}) {
  counter += 1;
  return session(await passwordUser(extra));
}
/** Another session (install) of the same user. */
async function session(user) {
  counter += 1;
  const signedIn = await signIn(user);
  signedIn.headers['X-Forwarded-For'] = ipFor(counter);
  return signedIn;
}

/** A real reauth token for this signed-in device: POST /v1/auth/reauthenticate with the account's password. */
async function reauthFor(who) {
  const res = await request(app).post('/v1/auth/reauthenticate').set(who.headers).send({ password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return res.body.reauthToken;
}
const withReauth = async (who, token) => ({ ...who.headers, 'X-Reauth-Token': token ?? await reauthFor(who) });
/** POST /v1/me/email/verification; with a fresh reauth token unless `headers` are given. */
const startChange = async (who, email, { headers, target = app } = {}) =>
  request(target).post('/v1/me/email/verification').set(headers ?? await withReauth(who)).send({ email });
const usedAt = async (token) => (await ReauthToken.findOne({ tokenHash: sha256(token) }).lean()).usedAt;
const verify = (headers, challengeId, code, target = app) =>
  request(target).post(`/v1/auth/challenges/${challengeId}/verify`).set(headers).send({ code });
const login = (email, password = PASSWORD) => {
  const installationId = crypto.randomUUID();
  return request(app).post('/v1/auth/login')
    .set({ ...CLIENT, 'X-Installation-Id': installationId, 'X-Forwarded-For': ipFor((counter += 1)) })
    .send({ email, password, device: { installationId, platform: 'ios', appVersion: '1.4.0+42' } });
};
const stored = async (who) => User.findById(who.user._id).lean();

/** Start and verify a change for `who`; returns the verify response. */
async function changeEmail(who, email) {
  const start = await startChange(who, email);
  assert.equal(start.status, 202, start.text);
  const res = await verify(who.headers, start.body.id, mail.lastCodeFor(email));
  assert.equal(res.status, 200, res.text);
  return res;
}

// ---------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------

test('change email: code to the new address, verified with the owner\'s token, saved verified, notice to the old one', async () => {
  const me = await account({ emailVerified: true });
  const oldEmail = me.user.email;
  const newEmail = uniqueEmail('new');

  const start = await startChange(me, newEmail);
  assert.equal(start.status, 202, start.text);
  assertMatchesSpec('Challenge', start.body);
  assert.equal(start.body.purpose, 'change_email');
  assert.equal(start.body.channel, 'email');
  assert.equal(start.body.destination, maskDestination('email', newEmail));
  assert.equal(start.body.attemptsRemaining, 5);
  assert.equal(start.body.sendsRemaining, 4);
  assert.deepEqual(mail.sent.map((m) => [m.to, m.purpose]), [[newEmail, 'change_email']]);
  assert.equal((await stored(me)).email, oldEmail, 'nothing changes before the code');
  assert.equal(mail.notices.length, 0);

  const res = await verify(me.headers, start.body.id, mail.lastCodeFor(newEmail));
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('ChallengeVerification', res.body);
  assertMatchesSpec('EmailChanged', res.body);
  assert.deepEqual(Object.keys(res.body).sort(), ['email', 'purpose', 'verifiedAt']);
  assert.equal(res.body.purpose, 'change_email');
  assert.equal(res.body.email, newEmail);
  assert.equal(res.headers['cache-control'], 'no-store');

  const after = await stored(me);
  assert.equal(after.email, newEmail);
  assert.equal(after.emailVerified, true);
  assert.deepEqual(mail.notices, [{ to: oldEmail, notice: 'email_changed' }]);

  const profile = await request(app).get('/v1/me').set(me.headers);
  assert.equal(profile.status, 200, profile.text);
  assert.equal(profile.body.email, newEmail);
  assert.equal(profile.body.emailVerified, true);

  // The code is used up.
  assertProblem(await verify(me.headers, start.body.id, mail.lastCodeFor(newEmail)), 409, 'CHALLENGE_ALREADY_USED');
});

test('password login uses the new address from then on; the old one no longer signs in', async () => {
  const me = await account();
  const oldEmail = me.user.email;
  const newEmail = uniqueEmail('new');
  await changeEmail(me, newEmail);
  assert.equal((await login(newEmail)).status, 200);
  assertProblem(await login(oldEmail), 401, 'INVALID_CREDENTIALS');
});

test('an account whose email was never marked verified (older account) ends up verified', async () => {
  const me = await account({ emailVerified: false });
  await changeEmail(me, uniqueEmail('new'));
  assert.equal((await stored(me)).emailVerified, true);
});

test('sessions are left alone: the spec signs nobody out on an email change', async () => {
  const me = await account();
  const otherDevice = await session(me.user);
  await changeEmail(me, uniqueEmail('new'));
  assert.equal((await request(app).get('/v1/me').set(otherDevice.headers)).status, 200);
  assert.equal((await request(app).get('/v1/me').set(me.headers)).status, 200);
});

// ---------------------------------------------------------------------------
// Only the owner
// ---------------------------------------------------------------------------

test('only the owner\'s token reaches the challenge (verify, get, resend); a stranger\'s attempt spends nothing', async () => {
  const me = await account();
  const stranger = await account();
  const newEmail = uniqueEmail('new');
  const start = await startChange(me, newEmail);
  const code = mail.lastCodeFor(newEmail);
  const id = start.body.id;
  const noToken = { ...CLIENT, 'X-Installation-Id': me.installationId };
  const strangerHere = { ...stranger.headers, 'X-Installation-Id': me.installationId };

  assertProblem(await verify(noToken, id, code), 404, 'CHALLENGE_NOT_FOUND');
  assertProblem(await verify(strangerHere, id, code), 404, 'CHALLENGE_NOT_FOUND');
  assertProblem(await verify({ ...noToken, Authorization: 'Bearer not-a-token' }, id, code), 404, 'CHALLENGE_NOT_FOUND');
  assertProblem(await request(app).get(`/v1/auth/challenges/${id}`).set(noToken), 404, 'CHALLENGE_NOT_FOUND');
  assertProblem(await request(app).get(`/v1/auth/challenges/${id}`).set(strangerHere), 404, 'CHALLENGE_NOT_FOUND');
  assertProblem(await request(app).post(`/v1/auth/challenges/${id}/resend`).set(noToken), 404, 'CHALLENGE_NOT_FOUND');
  // The owner from another install does not reach it either: a challenge answers to the install that asked for it.
  const myOtherDevice = await session(me.user);
  assertProblem(await verify(myOtherDevice.headers, id, code), 404, 'CHALLENGE_NOT_FOUND');

  const own = await request(app).get(`/v1/auth/challenges/${id}`).set(me.headers);
  assert.equal(own.status, 200, own.text);
  assertMatchesSpec('Challenge', own.body);
  assert.equal(own.body.attemptsRemaining, 5, 'nobody else used up an attempt');
  assert.equal((await verify(me.headers, id, code)).status, 200);
  assert.equal((await stored(stranger)).email, stranger.user.email);
});

test('wrong codes count, and the change only happens with the right one', async () => {
  const me = await account();
  const newEmail = uniqueEmail('new');
  const start = await startChange(me, newEmail);
  const code = mail.lastCodeFor(newEmail);
  const wrong = code === '000000' ? '111111' : '000000';
  const res = await verify(me.headers, start.body.id, wrong);
  assertProblem(res, 422, 'CODE_INCORRECT');
  assert.equal(res.body.meta.attemptsRemaining, 4);
  assert.equal((await verify(me.headers, start.body.id, '12ab')).status, 422);
  assert.equal((await stored(me)).email, me.user.email);
  assert.equal(mail.notices.length, 0);
  assert.equal((await verify(me.headers, start.body.id, code)).status, 200);
});

test('resend needs the owner\'s token but no reauth token, and sends a new code to the new address', async () => {
  const me = await account();
  const newEmail = uniqueEmail('new');
  const start = await startChange(me, newEmail);
  // Past the 30-second cooldown.
  await Challenge.updateOne({ _id: start.body.id }, { $set: { lastSentAt: new Date(Date.now() - MINUTE) } });
  const resent = await request(app).post(`/v1/auth/challenges/${start.body.id}/resend`).set(me.headers);
  assert.equal(resent.status, 202, resent.text);
  assertMatchesSpec('Challenge', resent.body);
  assert.equal(resent.body.purpose, 'change_email');
  assert.equal(mail.sent.length, 2);
  assert.equal(mail.sent[1].to, newEmail);
  assert.equal((await verify(me.headers, start.body.id, mail.lastCodeFor(newEmail))).status, 200);
});

// ---------------------------------------------------------------------------
// Re-authentication
// ---------------------------------------------------------------------------

test('without a valid reauth token it is 401 REAUTH_REQUIRED and nothing is sent', async () => {
  const me = await account();
  const other = await account();
  const myOtherDevice = await session(me.user);
  const newEmail = uniqueEmail('new');
  const theirs = await reauthFor(other);
  // A token from another session of the same user is not this session's.
  const otherDevices = await reauthFor(myOtherDevice);
  const cases = {
    missing: me.headers,
    empty: { ...me.headers, 'X-Reauth-Token': '' },
    unknown: { ...me.headers, 'X-Reauth-Token': 'rat_made-up' },
    'another account\'s': { ...me.headers, 'X-Reauth-Token': theirs },
    'another session\'s': { ...me.headers, 'X-Reauth-Token': otherDevices },
    'too long': { ...me.headers, 'X-Reauth-Token': 'x'.repeat(5000) },
    'sent under another name': { ...me.headers, 'X-Reauth': await reauthFor(me) },
  };
  for (const [name, headers] of Object.entries(cases)) {
    const res = await startChange(me, newEmail, { headers });
    assertProblem(res, 401, 'REAUTH_REQUIRED');
    assert.equal(res.headers['www-authenticate'], undefined, `${name}: not a bearer-token problem, so the app does not sign out`);
  }
  assert.equal(mail.sent.length, 0);
  // The refusals used up nobody's token: each still works for its own session.
  assert.equal((await startChange(other, uniqueEmail('new'), { headers: await withReauth(other, theirs) })).status, 202);
  assert.equal((await startChange(myOtherDevice, uniqueEmail('new'), { headers: await withReauth(myOtherDevice, otherDevices) })).status, 202);
});

test('a token issued to another user is refused, even with that user\'s session id on it', async () => {
  const me = await account();
  const other = await account();
  // Issued to the other user for this very session: only the user it names may use it.
  const { reauthToken } = await reauthTokens.issue({ userId: String(other.user._id), sessionId: me.session.id });
  assertProblem(await startChange(me, uniqueEmail('new'), { headers: await withReauth(me, reauthToken) }), 401, 'REAUTH_REQUIRED');
  assert.equal(await usedAt(reauthToken), null);
  assert.equal(mail.sent.length, 0);
});

test('a token is good for 5 minutes after POST /auth/reauthenticate and refused from then on', async () => {
  const me = await account();
  clock.at = Math.floor(Date.now() / SECOND) * SECOND;
  const late = await reauthFor(me);
  const inTime = await reauthFor(me);
  clock.at += 5 * MINUTE;
  assertProblem(await startChange(me, uniqueEmail('new'), { headers: await withReauth(me, late) }), 401, 'REAUTH_REQUIRED');
  assert.equal(mail.sent.length, 0);
  clock.at -= SECOND;
  assert.equal((await startChange(me, uniqueEmail('new'), { headers: await withReauth(me, inTime) })).status, 202);
});

test('single-use: the token from POST /auth/reauthenticate is used up by the code being sent', async () => {
  const me = await account();
  const token = await reauthFor(me);
  const first = await startChange(me, uniqueEmail('new'), { headers: await withReauth(me, token) });
  assert.equal(first.status, 202, first.text);
  assert.ok(await usedAt(token), 'the token is used up');
  assertProblem(await startChange(me, uniqueEmail('new'), { headers: await withReauth(me, token) }), 401, 'REAUTH_REQUIRED');
  assert.equal(mail.sent.length, 1);
});

test('single-use: two requests at once with one token, only one gets through', async () => {
  const me = await account();
  const headers = await withReauth(me);
  const results = await Promise.all([startChange(me, uniqueEmail('new'), { headers }), startChange(me, uniqueEmail('new'), { headers })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 401]);
  assert.equal(mail.sent.length, 1);
});

test('single-use, shared with PUT /me/password: a token used by one is refused by the other', async () => {
  // An account without a usable password (social-only), so PUT /me/password takes a reauth token too.
  const me = await session(await makeUser({ email: uniqueEmail('old') }));
  const changePassword = (token) => request(app).put('/v1/me/password').set({ ...me.headers, 'X-Reauth-Token': token })
    .send({ newPassword: 'Another-Pass-42!' });

  const usedHere = (await reauthTokens.issue({ userId: String(me.user._id), sessionId: me.session.id })).reauthToken;
  assert.equal((await startChange(me, uniqueEmail('new'), { headers: await withReauth(me, usedHere) })).status, 202);
  assertProblem(await changePassword(usedHere), 401, 'REAUTH_REQUIRED');

  const usedThere = (await reauthTokens.issue({ userId: String(me.user._id), sessionId: me.session.id })).reauthToken;
  assert.equal((await changePassword(usedThere)).status, 204);
  assertProblem(await startChange(me, uniqueEmail('new'), { headers: await withReauth(me, usedThere) }), 401, 'REAUTH_REQUIRED');
  assert.equal(mail.sent.length, 1);
});

test('a request that fails after the check gives its token back: the user fixes the address without the password', async () => {
  const me = await account();
  const other = await account();
  const token = await reauthFor(me);
  const headers = await withReauth(me, token);
  assertProblem(await startChange(me, me.user.email, { headers }), 409, 'CONFLICT');
  assertProblem(await startChange(me, other.user.email, { headers }), 409, 'EMAIL_TAKEN');
  assertProblem(await startChange(me, 'a..b@example.com', { headers }), 422, 'EMAIL_INVALID');
  mail.failNext();
  assertProblem(await startChange(me, uniqueEmail('new'), { headers }), 503, 'EMAIL_DELIVERY_FAILED');
  assert.equal(await usedAt(token), null, 'still unused');
  assert.equal((await startChange(me, uniqueEmail('new'), { headers })).status, 202);
  assert.ok(await usedAt(token));
});

test('signed out is 401 UNAUTHENTICATED; a guest is 403 GUEST_NOT_ALLOWED, before the reauth check', async () => {
  assertProblem(await request(app).post('/v1/me/email/verification').set({ ...CLIENT }).send({ email: uniqueEmail('new') }), 401, 'UNAUTHENTICATED');

  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId, 'X-Forwarded-For': '10.6.0.1' };
  const guest = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(guest.status, 201, guest.text);
  const asGuest = { ...headers, Authorization: `Bearer ${guest.body.tokens.accessToken}` };
  assertProblem(await request(app).post('/v1/me/email/verification').set(asGuest).send({ email: uniqueEmail('new') }), 403, 'GUEST_NOT_ALLOWED');
  assertProblem(await request(app).post('/v1/me/email/verification').set({ ...asGuest, 'X-Reauth-Token': 'rat_x' }).send({ email: uniqueEmail('new') }), 403, 'GUEST_NOT_ALLOWED');
  assert.equal(mail.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Which addresses
// ---------------------------------------------------------------------------

test('the account\'s current address is 409 CONFLICT, in any case and with spaces', async () => {
  const me = await account();
  for (const email of [me.user.email, me.user.email.toUpperCase(), `  ${me.user.email}  `]) {
    assertProblem(await startChange(me, email), 409, 'CONFLICT');
  }
  // An older account whose stored email has capitals.
  const legacy = await account({ email: `Old.Mixed${(counter += 1)}@Example.COM` });
  assertProblem(await startChange(legacy, legacy.user.email.toLowerCase()), 409, 'CONFLICT');
  assert.equal(mail.sent.length, 0);
});

test('an address another account has is 409 EMAIL_TAKEN, in any case, and nothing is sent', async () => {
  const me = await account();
  const other = await account();
  assertProblem(await startChange(me, other.user.email), 409, 'EMAIL_TAKEN');
  assertProblem(await startChange(me, other.user.email.toUpperCase()), 409, 'EMAIL_TAKEN');
  // An older account stored with capitals still holds the address.
  const legacyEmail = `Taken.Mixed${(counter += 1)}@Example.com`;
  await makeUser({ email: legacyEmail });
  assertProblem(await startChange(me, legacyEmail.toLowerCase()), 409, 'EMAIL_TAKEN');
  assert.equal(mail.sent.length, 0);
});

test('the address is normalised like at sign-up: trimmed and lowercased, and stored that way', async () => {
  const me = await account();
  const typed = `  New.Person${(counter += 1)}@Example.COM `;
  const normalised = typed.trim().toLowerCase();
  const start = await startChange(me, typed);
  assert.equal(start.status, 202, start.text);
  assert.equal(mail.sent[0].to, normalised);
  assert.equal(start.body.destination, maskDestination('email', normalised));
  const res = await verify(me.headers, start.body.id, mail.lastCodeFor(normalised));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.email, normalised);
  assert.equal((await stored(me)).email, normalised);
});

test('an address that is not an address is 422 with an EMAIL_INVALID field error', async () => {
  const me = await account();
  for (const email of ['nope', 'a@', '@example.com', '']) {
    const res = await startChange(me, email);
    assertProblem(res, 422, 'VALIDATION_FAILED');
    assert.equal(res.body.errors[0].field, '/email', email);
    assert.equal(res.body.errors[0].code, 'EMAIL_INVALID', email);
  }
  // One the spec's format check lets through but the API's stricter check does not.
  const doubleDot = await startChange(me, 'a..b@example.com');
  assertProblem(doubleDot, 422, 'EMAIL_INVALID');
  assert.equal(doubleDot.body.errors[0].field, '/email');
  assert.equal(mail.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Taken in the meantime
// ---------------------------------------------------------------------------

test('if another account signs up with the address while the code is pending, verifying is 409 EMAIL_TAKEN', async () => {
  const me = await account();
  const newEmail = uniqueEmail('new');
  const start = await startChange(me, newEmail);
  await makeUser({ email: newEmail });
  assertProblem(await verify(me.headers, start.body.id, mail.lastCodeFor(newEmail)), 409, 'EMAIL_TAKEN');
  const after = await stored(me);
  assert.equal(after.email, me.user.email);
  assert.equal(mail.notices.length, 0);
});

test('two accounts after the same address: the first code accepted wins, the other gets EMAIL_TAKEN', async () => {
  const a = await account();
  const b = await account();
  const target = uniqueEmail('wanted');
  const startA = await startChange(a, target);
  const codeA = mail.lastCodeFor(target);
  const startB = await startChange(b, target);
  const codeB = mail.lastCodeFor(target);
  assert.notEqual(startA.body.id, startB.body.id);
  assert.equal((await verify(b.headers, startB.body.id, codeB)).status, 200);
  assertProblem(await verify(a.headers, startA.body.id, codeA), 409, 'EMAIL_TAKEN');
  assert.equal((await stored(b)).email, target);
  assert.equal((await stored(a)).email, a.user.email);
  assert.deepEqual(mail.notices, [{ to: b.user.email, notice: 'email_changed' }]);
});

test('taken in a different case in the meantime (an older account) is EMAIL_TAKEN too', async () => {
  const me = await account();
  const newEmail = uniqueEmail('new');
  const start = await startChange(me, newEmail);
  await makeUser({ email: newEmail.toUpperCase() });
  assertProblem(await verify(me.headers, start.body.id, mail.lastCodeFor(newEmail)), 409, 'EMAIL_TAKEN');
});

test('a second code for the address the account already moved to changes nothing and sends no second notice', async () => {
  const me = await account();
  const otherDevice = await session(me.user);
  const newEmail = uniqueEmail('new');
  const startHere = await startChange(me, newEmail);
  const codeHere = mail.lastCodeFor(newEmail);
  const startThere = await startChange(otherDevice, newEmail);
  const codeThere = mail.lastCodeFor(newEmail);
  assert.equal((await verify(me.headers, startHere.body.id, codeHere)).status, 200);
  const again = await verify(otherDevice.headers, startThere.body.id, codeThere);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.email, newEmail);
  assert.equal(mail.notices.length, 1);
});

// ---------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------

test('a failing notice does not undo or fail the change', async () => {
  const me = await account();
  const newEmail = uniqueEmail('new');
  const start = await startChange(me, newEmail);
  mail.failNext();
  const res = await verify(me.headers, start.body.id, mail.lastCodeFor(newEmail));
  assert.equal(res.status, 200, res.text);
  assert.equal((await stored(me)).email, newEmail);
  assert.equal(mail.notices.length, 0);
});

test('the notice goes to the old address normalised, as stored addresses with capitals are', async () => {
  const me = await account({ email: `Old.Caps${(counter += 1)}@Example.com` });
  await changeEmail(me, uniqueEmail('new'));
  assert.deepEqual(mail.notices, [{ to: me.user.email.toLowerCase(), notice: 'email_changed' }]);
});

test('the messages: a code email for change_email, and a fixed-text notice that names no address', () => {
  const code = emailMessage({ purpose: 'change_email', code: '048213', expiresInMinutes: 10 });
  assert.match(code.text, /048213/);
  assert.match(code.text, /email address of your Bondfire account/);
  const notice = noticeEmail('email_changed');
  assert.match(notice.subject, /email address .* was changed/);
  assert.doesNotMatch(notice.text, /@/);
  assert.notDeepEqual(notice, noticeEmail('password_changed'));
});

// ---------------------------------------------------------------------------
// Limits, repeats, delivery
// ---------------------------------------------------------------------------

test('asking again for the same address from the same install returns the same challenge and sends nothing', async () => {
  const me = await account();
  const newEmail = uniqueEmail('new');
  const first = await startChange(me, newEmail);
  const second = await startChange(me, newEmail);
  assert.equal(second.status, 202);
  assert.equal(second.body.id, first.body.id);
  assert.equal(mail.sent.length, 1);
});

test('Idempotency-Key: a repeat gets the same answer, replayed', async () => {
  const me = await account();
  const newEmail = uniqueEmail('new');
  const key = crypto.randomUUID();
  // The repeat comes with a new reauth token: the first one was used up by the first request.
  const first = await startChange(me, newEmail, { headers: { ...(await withReauth(me)), 'Idempotency-Key': key } });
  const repeat = await startChange(me, newEmail, { headers: { ...(await withReauth(me)), 'Idempotency-Key': key } });
  assert.equal(first.status, 202);
  assert.equal(repeat.status, 202);
  assert.deepEqual(repeat.body, first.body);
  assert.equal(repeat.headers['idempotent-replayed'], 'true');
  assert.equal(mail.sent.length, 1);
  assertProblem(await startChange(me, uniqueEmail('other'), { headers: { ...(await withReauth(me)), 'Idempotency-Key': key } }), 422, 'IDEMPOTENCY_KEY_REUSED');
});

test('5 codes per address per 24 h: the sixth is 429 SEND_LIMIT_REACHED', async () => {
  const user = await passwordUser();
  const newEmail = uniqueEmail('new');
  for (let i = 0; i < 5; i += 1) {
    const res = await startChange(await session(user), newEmail);
    assert.equal(res.status, 202, res.text);
    assert.equal(res.body.sendsRemaining, 4 - i);
  }
  const sixth = await startChange(await session(user), newEmail);
  assertProblem(sixth, 429, 'SEND_LIMIT_REACHED');
  assert.ok(Number(sixth.headers['retry-after']) > 0);
  assert.equal(mail.sent.length, 5);
});

test('10 per account per 24 h: the eleventh is 429 RATE_LIMITED; refused reauth does not count', async () => {
  assert.deepEqual([LIMITS.perAccount.points, LIMITS.perAccount.durationSeconds], [10, 24 * 60 * 60]);
  const me = await account();
  for (let i = 0; i < 3; i += 1) assertProblem(await startChange(me, uniqueEmail('new'), { headers: me.headers }), 401, 'REAUTH_REQUIRED');
  for (let i = 0; i < 10; i += 1) {
    const res = await startChange(me, uniqueEmail('new'));
    assert.equal(res.status, 202, `request ${i + 1}: ${res.text}`);
  }
  const eleventh = await startChange(me, uniqueEmail('new'));
  assertProblem(eleventh, 429, 'RATE_LIMITED');
  assert.ok(Number(eleventh.headers['retry-after']) > 0);
  // Another account is not affected.
  assert.equal((await startChange(await account(), uniqueEmail('new'))).status, 202);
});

test('a provider failure is 503 EMAIL_DELIVERY_FAILED, and the send does not count', async () => {
  const me = await account();
  const newEmail = uniqueEmail('new');
  mail.failNext();
  assertProblem(await startChange(me, newEmail), 503, 'EMAIL_DELIVERY_FAILED');
  const retry = await startChange(me, newEmail);
  assert.equal(retry.status, 202, retry.text);
  assert.equal(retry.body.sendsRemaining, 4);
});

test('test mode: a listed address gets the fixed code and no email', async () => {
  const listed = uniqueEmail('tester');
  const testApp = buildApp({ codesConfig: { testMode: true, testRecipients: [listed], testValue: '246810' } });
  const me = await account();
  const start = await startChange(me, listed, { target: testApp });
  assert.equal(start.status, 202, start.text);
  assert.equal(mail.sent.length, 0);
  const res = await verify(me.headers, start.body.id, '246810', testApp);
  assert.equal(res.status, 200, res.text);
  assert.equal((await stored(me)).email, listed);
});

test('a change made elsewhere at the same moment is never overwritten: the save only applies to the email it read', async () => {
  const users = require('../src/modules/users/repo');
  const me = await account();
  const at = Date.now();
  assert.equal(await users.setEmail(me.user._id, { from: 'someone.else@example.com', email: 'x1@example.com', at }), 'stale');
  assert.equal((await stored(me)).email, me.user.email);
  assert.equal(await users.setEmail('0123456789abcdef01234567', { from: me.user.email, email: 'x2@example.com', at }), 'missing');
  const other = await account();
  assert.equal(await users.setEmail(me.user._id, { from: me.user.email, email: other.user.email, at }), 'taken');

  // The service reads the account again and tells the address it read the second time.
  let reads = 0;
  const fakeUsers = {
    findByEmail: async () => null,
    findById: async () => ({ _id: me.user._id, email: (reads += 1) === 1 ? 'first@example.com' : 'second@example.com' }),
    setEmail: async (userId, { from }) => (from === 'second@example.com' ? 'saved' : 'stale'),
  };
  const notices = createMemoryEmailProvider();
  const service = createEmailChangeService({ users: fakeUsers, challenges: {}, emailProvider: notices, logger: silent });
  const res = await service.applyVerified({ userId: String(me.user._id), email: 'new@example.com' });
  assert.equal(res.email, 'new@example.com');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices.notices, [{ to: 'second@example.com', notice: 'email_changed' }]);
});

test('the challenge service: change_email is sent by email and belongs to a user', async () => {
  const challenges = createChallengeService({ emailProvider: mail, smsProvider: sms, logger: silent });
  const base = { purpose: 'change_email', channel: 'email', destination: 'a@example.com', installationId: crypto.randomUUID() };
  await assert.rejects(challenges.start(base), /needs the userId/);
  await assert.rejects(challenges.start({ ...base, channel: 'sms', userId: '0123456789abcdef01234567' }), /sent by email/);
});
