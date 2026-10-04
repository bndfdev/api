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
const { createPhoneService } = require('../src/modules/phone/service');
const { createPhoneRouter } = require('../src/modules/phone/routes');
const { parsePhone, typeAllowed } = require('../src/lib/phone');
const { maskDestination } = require('../src/lib/destination');
const { buildOnboarding } = require('../src/modules/users/service');
const { config } = require('../src/config');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { createMemorySmsProvider } = require('../src/providers/sms/memory');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const US = '+14155550123';
const US_2 = '+12025550143';
const INDIA = '+919876543210';
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mail = createMemoryEmailProvider();
const sms = createMemorySmsProvider();

/** An app whose phone rules come from `phoneConfig` (regions, VoIP). */
function buildApp(phoneConfig = { regions: [], refuseVoip: false }) {
  const challenges = createChallengeService({ emailProvider: mail, smsProvider: sms, logger: silent });
  const phone = createPhoneService({ challenges, config: { ...config, phone: phoneConfig } });
  const auth = createAuthService({ challenges, phone, emailProvider: mail, logger: silent });
  return createApp({ trustProxy: 1, authRouter: createAuthRouter({ service: auth }), phoneRouter: createPhoneRouter({ service: phone }) });
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
  sms.clear();
  mail.clear();
});
after(db.disconnect);

let counter = 0;
/** A signed-in account on its own install and IP. */
async function account(extra = {}) {
  counter += 1;
  const user = await makeUser(extra);
  const signedIn = await signIn(user);
  signedIn.headers['X-Forwarded-For'] = `10.9.${(counter >> 8) & 255}.${counter & 255}`;
  return signedIn;
}

const startPhone = (who, phoneNumber, target = app) =>
  request(target).post('/v1/me/phone/verification').set(who.headers).send({ phoneNumber });
const verify = (headers, challengeId, code) =>
  request(app).post(`/v1/auth/challenges/${challengeId}/verify`).set(headers).send({ code });

/** Start and verify a number for `who`. */
async function addPhone(who, phoneNumber) {
  const start = await startPhone(who, phoneNumber);
  assert.equal(start.status, 202, start.text);
  const res = await verify(who.headers, start.body.id, sms.lastCodeFor(phoneNumber));
  assert.equal(res.status, 200, res.text);
  return res;
}

// ---------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------

test('add a phone: code by SMS, verified with the owner\'s token, saved on the account', async () => {
  const me = await account();
  const start = await startPhone(me, US);
  assert.equal(start.status, 202, start.text);
  assertMatchesSpec('Challenge', start.body);
  assert.equal(start.body.purpose, 'phone_verification');
  assert.equal(start.body.channel, 'sms');
  assert.equal(start.body.destination, '+1 ••• ••• 0123');
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].to, US);
  assert.equal(sms.sent[0].purpose, 'phone_verification');
  assert.equal((await User.findById(me.user._id).lean()).phone, undefined, 'nothing saved before the code');

  const res = await verify(me.headers, start.body.id, sms.lastCodeFor(US));
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('ChallengeVerification', res.body);
  assert.equal(res.body.purpose, 'phone_verification');
  assert.equal(res.body.phoneNumber, US);

  const stored = await User.findById(me.user._id).lean();
  assert.equal(stored.phone, US);
  assert.equal(stored.mobileNumberVerified, true);
  assert.ok(stored.phoneVerifiedAt instanceof Date);
  const step = buildOnboarding(stored).steps.find((s) => s.step === 'phone_verified');
  assert.equal(step.status, 'completed');
});

test('only the owner can verify or see a phone challenge; a stranger\'s attempt spends nothing', async () => {
  const me = await account();
  const stranger = await account();
  const start = await startPhone(me, US);
  const code = sms.lastCodeFor(US);
  const noToken = { ...CLIENT, 'X-Installation-Id': me.installationId };

  assertProblem(await verify(noToken, start.body.id, code), 404, 'CHALLENGE_NOT_FOUND');
  assertProblem(await verify({ ...stranger.headers, 'X-Installation-Id': me.installationId }, start.body.id, code), 404, 'CHALLENGE_NOT_FOUND');
  assertProblem(await request(app).get(`/v1/auth/challenges/${start.body.id}`).set(noToken), 404, 'CHALLENGE_NOT_FOUND');
  assert.equal((await request(app).get(`/v1/auth/challenges/${start.body.id}`).set(me.headers)).status, 200);
  assert.equal((await verify(me.headers, start.body.id, code)).status, 200);
});

test('changing the number keeps the old one until the new code is accepted', async () => {
  const me = await account();
  await addPhone(me, US);
  const start = await startPhone(me, US_2);
  assert.equal(start.status, 202);
  assert.equal((await User.findById(me.user._id).lean()).phone, US);
  await verify(me.headers, start.body.id, sms.lastCodeFor(US_2));
  assert.equal((await User.findById(me.user._id).lean()).phone, US_2);
});

// ---------------------------------------------------------------------------
// Which numbers
// ---------------------------------------------------------------------------

test('invalid numbers are refused', async () => {
  const me = await account();
  assertProblem(await startPhone(me, '+11234567890'), 422, 'PHONE_INVALID', 'not a real US number');
  const notE164 = await startPhone(me, '415 555 0123');
  assert.equal(notE164.status, 422);
  assert.equal(notE164.body.code, 'VALIDATION_FAILED');
  assert.equal(sms.sent.length, 0);
});

test('numbers that cannot get a text, or cost money to text, are refused', async () => {
  const me = await account();
  assertProblem(await startPhone(me, '+19005550123'), 422, 'PHONE_TYPE_NOT_ALLOWED', 'premium rate');
  assertProblem(await startPhone(me, '+442071838750'), 422, 'PHONE_TYPE_NOT_ALLOWED', 'a UK landline');
  assert.equal(sms.sent.length, 0);
  assert.equal(typeAllowed('VOIP', { refuseVoip: false }), true);
  assert.equal(typeAllowed('VOIP', { refuseVoip: true }), false);
  assert.equal(typeAllowed('MOBILE', { refuseVoip: true }), true);
});

test('PHONE_REGIONS limits the countries', async () => {
  const usOnly = buildApp({ regions: ['US'], refuseVoip: false });
  const me = await account();
  assertProblem(await startPhone(me, INDIA, usOnly), 422, 'PHONE_REGION_UNSUPPORTED');
  assert.equal((await startPhone(me, US, usOnly)).status, 202);
});

test('the number parser and the masked form', () => {
  assert.deepEqual(parsePhone(INDIA), { e164: INDIA, region: 'IN', callingCode: '91', type: 'MOBILE' });
  assert.equal(parsePhone('+1415555'), null);
  assert.equal(parsePhone(42), null);
  assert.equal(maskDestination('sms', INDIA), '+91 ••• ••• 3210');
});

// ---------------------------------------------------------------------------
// One number, one account
// ---------------------------------------------------------------------------

test('a number another account verified is PHONE_TAKEN', async () => {
  const a = await account();
  const b = await account();
  await addPhone(a, US);
  assertProblem(await startPhone(b, US), 409, 'PHONE_TAKEN');
});

test('verifying your own number again is CONFLICT', async () => {
  const me = await account();
  await addPhone(me, US);
  assertProblem(await startPhone(me, US), 409, 'CONFLICT');
});

test('if someone else verifies the number first, the later code is PHONE_TAKEN', async () => {
  const a = await account();
  const b = await account();
  const startA = await startPhone(a, US);
  const codeA = sms.lastCodeFor(US);
  const startB = await startPhone(b, US);
  const codeB = sms.lastCodeFor(US);
  assert.equal((await verify(b.headers, startB.body.id, codeB)).status, 200);
  assertProblem(await verify(a.headers, startA.body.id, codeA), 409, 'PHONE_TAKEN');
  assert.equal((await User.findById(b.user._id).lean()).phone, US);
  assert.equal((await User.findById(a.user._id).lean()).phone, undefined);
});

test('a number another account has from the old API (fixed code, no proof) goes to whoever verifies it', async () => {
  // What the old /user/verify-mobile-otp stores: the number, marked verified after the fixed code 123456.
  const legacy = await makeUser({ phone: US, mobileNumberVerified: true });
  const me = await account();
  await addPhone(me, US);
  assert.equal((await User.findById(me.user._id).lean()).phone, US);
  const old = await User.findById(legacy._id).lean();
  assert.equal(old.phone, undefined);
  assert.equal(old.mobileNumberVerified, false);
});

test('an account can verify the number it has from the old API', async () => {
  const me = await account();
  await User.updateOne({ _id: me.user._id }, { $set: { phone: US, mobileNumberVerified: true } });
  await addPhone(me, US);
  const stored = await User.findById(me.user._id).lean();
  assert.equal(stored.phone, US);
  assert.ok(stored.phoneVerifiedAt instanceof Date);
});

// ---------------------------------------------------------------------------
// Removing, guests, limits
// ---------------------------------------------------------------------------

test('DELETE /me/phone removes the number (idempotent) and the step returns to pending', async () => {
  const me = await account();
  await addPhone(me, US);
  for (let i = 0; i < 2; i += 1) {
    const res = await request(app).delete('/v1/me/phone').set(me.headers);
    assert.equal(res.status, 204);
  }
  const stored = await User.findById(me.user._id).lean();
  assert.equal(stored.phone, undefined);
  assert.equal(stored.mobileNumberVerified, false);
  assert.equal(buildOnboarding(stored).steps.find((s) => s.step === 'phone_verified').status, 'pending');
});

test('DELETE /me/phone on an account without a number writes nothing', async () => {
  const me = await account();
  const before = await User.findById(me.user._id).lean();
  assert.equal((await request(app).delete('/v1/me/phone').set(me.headers)).status, 204);
  assert.deepEqual(await User.findById(me.user._id).lean(), before);
});

test('signed out is 401; a guest is 403 GUEST_NOT_ALLOWED', async () => {
  const anonymous = { ...CLIENT };
  assertProblem(await request(app).post('/v1/me/phone/verification').set(anonymous).send({ phoneNumber: US }), 401, 'UNAUTHENTICATED');

  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId, 'X-Forwarded-For': '10.8.0.1' };
  const guest = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(guest.status, 201, guest.text);
  const asGuest = { ...headers, Authorization: `Bearer ${guest.body.tokens.accessToken}` };
  assertProblem(await request(app).post('/v1/me/phone/verification').set(asGuest).send({ phoneNumber: US }), 403, 'GUEST_NOT_ALLOWED');
  assertProblem(await request(app).delete('/v1/me/phone').set(asGuest), 403, 'GUEST_NOT_ALLOWED');
});

test('test mode: a listed number gets the fixed code and no text', async () => {
  const testConfig = {
    ...config,
    codes: { ...config.codes, testMode: true, testRecipients: [US], testValue: '246810' },
    phone: { regions: [], refuseVoip: false },
  };
  const challenges = createChallengeService({ config: testConfig, emailProvider: mail, smsProvider: sms, logger: silent });
  const phone = createPhoneService({ challenges, config: testConfig });
  const auth = createAuthService({ challenges, phone, emailProvider: mail, logger: silent });
  const testApp = createApp({ trustProxy: 1, authRouter: createAuthRouter({ service: auth }), phoneRouter: createPhoneRouter({ service: phone }) });

  const me = await account();
  const start = await startPhone(me, US, testApp);
  assert.equal(start.status, 202, start.text);
  assert.equal(sms.sent.length, 0);
  const res = await request(testApp).post(`/v1/auth/challenges/${start.body.id}/verify`).set(me.headers).send({ code: '246810' });
  assert.equal(res.status, 200, res.text);
});
