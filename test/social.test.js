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
const { loadConfig } = require('../src/config');
const { createSocialService } = require('../src/modules/social/service');
const { createSocialRouter } = require('../src/modules/social/routes');
const { createSocialVerifier } = require('../src/providers/social');
const { createCredentialsService } = require('../src/modules/credentials/service');
const { createCredentialsRouter } = require('../src/modules/credentials/routes');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { invalidToken } = require('../src/providers/social/errors');
const passwords = require('../src/lib/passwords');
const LinkToken = require('../models/LinkToken');
const User = require('../models/User');
const db = require('./support/db');
const { CLIENT, signIn, assertProblem } = require('./support/api');

/**
 * A fake provider check. Credentials are `<provider>:<sub>[:<email>[:unverified]]` in `idToken` (Google) or
 * `accessToken` (Facebook); `bad` is refused like an invalid token.
 */
async function fakeVerify(credential) {
  const raw = credential.idToken ?? credential.accessToken;
  if (raw === 'bad') throw invalidToken();
  const [provider, sub, email, flag] = raw.split(':');
  assert.equal(provider, credential.provider, 'the fake credential names its provider');
  return { provider, providerUserId: sub, ...(email ? { email, emailVerified: flag !== 'unverified' } : {}) };
}

const ON = loadConfig({ NODE_ENV: 'test', GOOGLE_CLIENT_IDS: 'web.apps.googleusercontent.com', FACEBOOK_APP_ID: '123', FACEBOOK_APP_SECRET: 'sh' }, { validate: false });
const OFF = loadConfig({ NODE_ENV: 'test' }, { validate: false });
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function buildApp({ config = ON } = {}) {
  const verify = createSocialVerifier({ config, google: fakeVerify, facebook: fakeVerify });
  return createApp({
    trustProxy: 1,
    socialRouter: createSocialRouter({ service: createSocialService({ config, verify }) }),
    credentialsRouter: createCredentialsRouter({
      service: createCredentialsService({ verifySocial: verify, emailProvider: createMemoryEmailProvider(), logger: silent }),
    }),
  });
}
const app = buildApp();

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
const ajv = new Ajv2020({ strict: false, logger: false });
const assertMatchesSpec = (name, value) => assert.equal(
  ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value), true,
  `${name}: ${JSON.stringify(ajv.errors)}`,
);

before(async () => {
  await db.connect();
  await User.syncIndexes();
  await passwords.dummyHash();
});
beforeEach(db.clear);
after(db.disconnect);

/** POST /v1/auth/social from a fresh install. */
function social(credential, { installationId = crypto.randomUUID(), on = app } = {}) {
  return request(on).post('/v1/auth/social')
    .set({ ...CLIENT, 'X-Installation-Id': installationId, 'Idempotency-Key': crypto.randomUUID() })
    .send({ credential, device: { installationId, platform: 'ios', model: 'iPhone 16', appVersion: '1.4.0+42' } });
}
const google = (token) => ({ provider: 'google', idToken: token });
const facebook = (token) => ({ provider: 'facebook', accessToken: token });

test('a new Google account: 201, a session, and onboarding starts at date of birth', async () => {
  const res = await social(google('google:g-1:ana@example.com'));
  assert.equal(res.status, 201, res.text);
  assertMatchesSpec('Session', res.body);
  assert.equal(res.body.isNewUser, true);
  assert.equal(res.body.user.email, 'ana@example.com');
  assert.equal(res.body.user.emailVerified, true);
  assert.deepEqual(res.body.user.loginMethods, ['google']);
  assert.equal(res.body.user.onboarding.nextStep, 'date_of_birth');
  const skipped = res.body.user.onboarding.steps.filter((s) => s.status === 'skipped').map((s) => s.step);
  assert.deepEqual(skipped, ['password_set', 'phone_verified'], 'the verified Google email counts as verified');
  assert.equal(res.body.user.onboarding.steps.find((s) => s.step === 'email_verified').status, 'completed');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('the same Google account again signs in to the same Bondfire account (200)', async () => {
  const first = await social(google('google:g-2:ben@example.com'));
  const again = await social(google('google:g-2:ben@example.com'));
  assert.equal(again.status, 200, again.text);
  assertMatchesSpec('Session', again.body);
  assert.equal(again.body.isNewUser, false);
  assert.equal(again.body.user.id, first.body.user.id);
  assert.equal(await User.countDocuments(), 1);
});

test('Facebook without an email: two different people get two accounts with no email', async () => {
  const a = await social(facebook('facebook:f-1'));
  const b = await social(facebook('facebook:f-2'));
  assert.equal(a.status, 201, a.text);
  assert.equal(b.status, 201, b.text);
  assert.equal(a.body.user.email, null);
  assert.notEqual(a.body.user.id, b.body.user.id);
  assert.equal(a.body.user.onboarding.nextStep, 'date_of_birth');
  assert.deepEqual(a.body.user.loginMethods, ['facebook']);
  const skipped = a.body.user.onboarding.steps.filter((s) => s.status === 'skipped').map((s) => s.step);
  assert.deepEqual(skipped, ['email_verified', 'password_set', 'phone_verified'], 'no email: nothing to verify');
});

test('an email that already has a password account: 409 ACCOUNT_LINK_REQUIRED, never linked silently', async () => {
  const owner = await User.create({ email: 'cara@example.com', password: await passwords.hash('Correct-Horse-9'), passwordAlgo: 'argon2id' });
  const res = await social(google('google:g-3:cara@example.com'));
  assertProblem(res, 409, 'ACCOUNT_LINK_REQUIRED');
  assertMatchesSpec('Problem', res.body);
  assert.match(res.body.meta.linkToken, /^lnk_/);
  assert.deepEqual(res.body.meta.existingLoginMethods, ['password']);
  const stored = await User.findById(owner._id).lean();
  assert.equal(stored.socialIdentities, undefined, 'nothing linked yet');
  const token = await LinkToken.findOne().lean();
  assert.notEqual(token.tokenHash, res.body.meta.linkToken, 'only the hash is stored');
});

test('the email match ignores case: an older account stored in capitals still needs linking', async () => {
  await User.collection.insertOne({ email: 'Old.User@Example.com', password: 'x', createdAt: new Date() });
  const res = await social(google('google:g-12:old.user@example.com'));
  assertProblem(res, 409, 'ACCOUNT_LINK_REQUIRED');
  assert.equal(await User.countDocuments(), 1, 'no second account for the same person');
});

test('the link token links Google to the account that signed in with its password, once', async () => {
  const owner = await User.create({ email: 'dev@example.com', password: 'x' });
  const conflict = await social(google('google:g-4:dev@example.com'));
  const { linkToken } = conflict.body.meta;
  const { headers } = await signIn(owner);

  const linked = await request(app).post('/v1/me/identities').set(headers).send({ linkToken });
  assert.equal(linked.status, 201, linked.text);
  assert.equal(linked.body.provider, 'google');

  const reused = await request(app).post('/v1/me/identities').set(headers).send({ linkToken });
  assertProblem(reused, 401, 'LINK_TOKEN_INVALID');

  const after = await social(google('google:g-4:dev@example.com'));
  assert.equal(after.status, 200, after.text);
  assert.equal(after.body.user.id, String(owner._id));
  assert.deepEqual(after.body.user.loginMethods, ['password', 'google']);

  const list = await request(app).get('/v1/me/identities').set(headers);
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.data.map((i) => i.provider), ['password', 'google']);
});

test('a link token only works for the account that owns the email', async () => {
  await User.create({ email: 'eve@example.com', password: 'x' });
  const other = await User.create({ email: 'mallory@example.com', password: 'x' });
  const conflict = await social(google('google:g-5:eve@example.com'));
  const { headers } = await signIn(other);
  const res = await request(app).post('/v1/me/identities').set(headers).send({ linkToken: conflict.body.meta.linkToken });
  assertProblem(res, 401, 'LINK_TOKEN_INVALID');
});

test('an expired link token is refused', async () => {
  const owner = await User.create({ email: 'finn@example.com', password: 'x' });
  const conflict = await social(google('google:g-6:finn@example.com'));
  await LinkToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const { headers } = await signIn(owner);
  const res = await request(app).post('/v1/me/identities').set(headers).send({ linkToken: conflict.body.meta.linkToken });
  assertProblem(res, 401, 'LINK_TOKEN_INVALID');
});

test('linking a provider account that belongs to someone else: 409 IDENTITY_ALREADY_LINKED', async () => {
  await social(google('google:g-7:gil@example.com'));
  const other = await User.create({ email: 'hana@example.com', password: 'x' });
  const { headers } = await signIn(other);
  const res = await request(app).post('/v1/me/identities').set(headers).send({ credential: google('google:g-7:gil@example.com') });
  assertProblem(res, 409, 'IDENTITY_ALREADY_LINKED');
});

test('an unverified provider email: 422 SOCIAL_EMAIL_UNVERIFIED, no account', async () => {
  const res = await social(google('google:g-8:ivy@example.com:unverified'));
  assertProblem(res, 422, 'SOCIAL_EMAIL_UNVERIFIED');
  assert.equal(await User.countDocuments(), 0);
});

test('a credential the provider rejects: 401 SOCIAL_TOKEN_INVALID', async () => {
  assertProblem(await social(google('bad')), 401, 'SOCIAL_TOKEN_INVALID');
  assertProblem(await social(facebook('bad')), 401, 'SOCIAL_TOKEN_INVALID');
});

test('providers that are off, and Apple: 422 SOCIAL_PROVIDER_UNSUPPORTED', async () => {
  const off = buildApp({ config: OFF });
  assertProblem(await social(google('google:g-9:jo@example.com'), { on: off }), 422, 'SOCIAL_PROVIDER_UNSUPPORTED');
  assertProblem(await social(facebook('facebook:f-9'), { on: off }), 422, 'SOCIAL_PROVIDER_UNSUPPORTED');
  assertProblem(await social({ provider: 'apple', idToken: 'x', nonce: 'n' }), 422, 'SOCIAL_PROVIDER_UNSUPPORTED');
  assert.equal(await User.countDocuments(), 0);
});

test('the device must be the install that sends the request', async () => {
  const res = await request(app).post('/v1/auth/social')
    .set({ ...CLIENT, 'Idempotency-Key': crypto.randomUUID() })
    .send({ credential: google('google:g-10'), device: { installationId: crypto.randomUUID(), platform: 'ios', appVersion: '1.4.0+42' } });
  assertProblem(res, 422, 'VALIDATION_FAILED');
});

test('a social-only account confirms who it is with a fresh provider credential (reauthenticate)', async () => {
  const created = await social(google('google:g-11:kim@example.com'));
  const user = await User.findById(created.body.user.id);
  const { headers } = await signIn(user, { signInMethod: 'google' });

  const ok = await request(app).post('/v1/auth/reauthenticate').set(headers).send({ social: google('google:g-11:kim@example.com') });
  assert.equal(ok.status, 200, ok.text);
  assertMatchesSpec('ReauthToken', ok.body);

  const someoneElse = await request(app).post('/v1/auth/reauthenticate').set(headers).send({ social: google('google:g-other') });
  assertProblem(someoneElse, 401, 'SOCIAL_TOKEN_INVALID');
});
