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
const { createLegalService } = require('../src/modules/legal/service');
const { createMeService } = require('../src/modules/me/service');
const { createMeRouter } = require('../src/modules/me/routes');
const { createMetaService } = require('../src/modules/meta/service');
const { createMetaRouter } = require('../src/modules/meta/routes');
const { createChallengeService } = require('../src/modules/challenges/service');
const { createAuthService } = require('../src/modules/auth/service');
const { createAuthRouter } = require('../src/modules/auth/routes');
const live = require('../content/legal');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { createMemorySmsProvider } = require('../src/providers/sms/memory');
const Consent = require('../models/Consent');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const mail = createMemoryEmailProvider();
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** An app whose legal documents are `documents` (to publish a new version in a test). */
function buildApp(documents = live) {
  const legal = createLegalService({ documents });
  const me = createMeService({ legal });
  const challenges = createChallengeService({ emailProvider: mail, smsProvider: createMemorySmsProvider(), logger: silent });
  const auth = createAuthService({ challenges, profiles: me, legal, emailProvider: mail, logger: silent });
  return createApp({
    trustProxy: 1,
    meRouter: createMeRouter({ me, legal }),
    metaRouter: createMetaRouter({ legal, meta: createMetaService({ legal }) }),
    authRouter: createAuthRouter({ service: auth }),
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
  mail.clear();
});
after(db.disconnect);

const accept = (who, version = live.terms.version, documentType = 'terms', target = app) =>
  request(target).post('/v1/me/consents').set(who.headers).send({ documentType, version, accepted: true });

test('GET /legal/terms and /legal/privacy serve the live documents, with an ETag', async () => {
  for (const type of ['terms', 'privacy']) {
    const res = await request(app).get(`/v1/legal/${type}`).set(CLIENT);
    assert.equal(res.status, 200, res.text);
    assertMatchesSpec('LegalDocument', res.body);
    assert.equal(res.body.type, type);
    assert.equal(res.body.version, live[type].version);
    assert.equal(res.headers['cache-control'], 'public, max-age=3600');
    const again = await request(app).get(`/v1/legal/${type}`).set({ ...CLIENT, 'If-None-Match': res.headers.etag });
    assert.equal(again.status, 304);
  }
  assert.equal((await request(app).get('/v1/legal/terms').set(CLIENT)).body.requiresAcceptance, true);
  assert.equal((await request(app).get('/v1/legal/privacy').set(CLIENT)).body.requiresAcceptance, false);
  const unknown = await request(app).get('/v1/legal/cookies').set(CLIENT);
  assert.ok([400, 404, 422].includes(unknown.status), unknown.text);
});

test('accepting the terms: 201, then 200 with the same record; the account is up to date', async () => {
  const me = await signIn(await makeUser());
  let res = await accept(me);
  assert.equal(res.status, 201, res.text);
  assertMatchesSpec('Consent', res.body);
  const again = await accept(me);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, res.body);

  const stored = await Consent.find({}).lean();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].installationId, me.installationId);
  assert.equal(stored[0].accountType, 'user');
  assert.ok(stored[0].ip);

  res = await request(app).get('/v1/me/consents').set(me.headers);
  assertMatchesSpec('ConsentList', res.body);
  assert.equal(res.body.data.length, 1);

  const { body } = await request(app).get('/v1/me').set(me.headers);
  assert.deepEqual(body.consents, {
    termsAcceptedVersion: live.terms.version, termsUpToDate: true, privacyAcceptedVersion: null, privacyUpToDate: true,
  });
  assert.equal(body.onboarding.steps.find((s) => s.step === 'terms_accepted').status, 'completed');
});

test('an old version is LEGAL_VERSION_OUTDATED with the current version', async () => {
  const me = await signIn(await makeUser());
  const res = await accept(me, '2020-01-01');
  assertProblem(res, 409, 'LEGAL_VERSION_OUTDATED');
  assert.equal(res.body.meta.currentVersion, live.terms.version);
  assert.equal(await Consent.countDocuments(), 0);
});

test('publishing new terms asks everyone again', async () => {
  const me = await signIn(await makeUser());
  await accept(me);
  const newer = { ...live, terms: { ...live.terms, version: '2027-01-01', effectiveAt: '2027-01-01T00:00:00Z' } };
  const later = buildApp(newer);
  let { body } = await request(later).get('/v1/me').set(me.headers);
  assert.equal(body.consents.termsUpToDate, false);
  assert.equal(body.consents.termsAcceptedVersion, live.terms.version);
  assert.equal(body.onboarding.steps.find((s) => s.step === 'terms_accepted').status, 'pending');
  assert.equal((await request(later).get('/v1/config').set(CLIENT)).body.legal.termsVersion, '2027-01-01');

  assert.equal((await accept(me, '2027-01-01', 'terms', later)).status, 201);
  ({ body } = await request(later).get('/v1/me').set(me.headers));
  assert.equal(body.consents.termsUpToDate, true);
  assert.equal(body.consents.termsAcceptedVersion, '2027-01-01');
});

test('a guest\'s accepted terms move to the account it signs up as; login shows them', async () => {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId, 'X-Forwarded-For': '10.7.0.1' };
  const device = { installationId, platform: 'ios', appVersion: '1.4.0' };
  const g = await request(app).post('/v1/auth/guest').set(headers).send({ device, dateOfBirth: '2000-01-01' });
  const guestHeaders = { ...headers, Authorization: `Bearer ${g.body.tokens.accessToken}` };
  assert.equal((await accept({ headers: guestHeaders })).status, 201);
  assert.equal((await request(app).get('/v1/me').set(guestHeaders)).body.consents.termsUpToDate, true);

  const email = 'from.guest@example.com';
  const start = await request(app).post('/v1/auth/signup/email').set(headers).send({ email });
  const verify = await request(app).post(`/v1/auth/challenges/${start.body.id}/verify`).set(headers).send({ code: mail.lastCodeFor(email) });
  const done = await request(app).post('/v1/auth/signup/complete').set(guestHeaders)
    .send({ signupToken: verify.body.signupToken, password: 'Correct-Horse-9', device });
  assert.equal(done.status, 201, done.text);
  assert.equal(done.body.user.consents.termsUpToDate, true, 'Session.user carries the moved consent');
  const moved = await Consent.find({}).lean();
  assert.equal(moved.length, 1);
  assert.equal(String(moved[0].userId), done.body.user.id);
  assert.equal(moved[0].accountType, 'user');

  const login = await request(app).post('/v1/auth/login').set({ ...headers, 'X-Forwarded-For': '10.7.0.2' })
    .send({ email, password: 'Correct-Horse-9', device });
  assert.equal(login.body.user.consents.termsUpToDate, true);
});
