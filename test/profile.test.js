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
const { createMeService, cleanName } = require('../src/modules/me/service');
const { createMeRouter } = require('../src/modules/me/routes');
const User = require('../models/User');
const TERMS = require('../content/legal').terms.version;
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const DAY = 24 * 60 * 60 * 1000;
const clock = { t: Date.now(), now: () => clock.t };

function buildApp({ features = config.features } = {}) {
  const me = createMeService({ now: clock.now, config: { ...config, features } });
  return createApp({ trustProxy: 1, meRouter: createMeRouter({ me }) });
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

/** A signed-in account (password set, email verified), straight in the database. */
async function account(extra = {}) {
  const user = await makeUser({ password: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', emailVerified: true, ...extra });
  return signIn(user);
}

/** A guest, through the real endpoint. */
async function guest(target = app) {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(target).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01', preferredLanguage: 'en' });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.user.id, headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

const getMe = (who, extra = {}, target = app) => request(target).get('/v1/me').set({ ...who.headers, ...extra });
const patchMe = (who, body, extra = {}, target = app) => request(target).patch('/v1/me')
  .set({ ...who.headers, 'Content-Type': 'application/merge-patch+json', ...extra }).send(JSON.stringify(body));
const putStep = (who, step, status, target = app) => request(target).put(`/v1/me/onboarding/steps/${step}`).set(who.headers).send({ status });
const yearsAgo = (years, days = 0) => {
  const d = new Date(clock.t - days * DAY);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

test('GET /me returns the account with an ETag, and 304 when unchanged', async () => {
  const me = await account({ name: 'Amelia', gender: 'female' });
  const res = await getMe(me);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('User', res.body);
  assert.equal(res.body.accountType, 'user');
  assert.equal(res.body.name, 'Amelia');
  assert.equal(res.headers['cache-control'], 'private, no-cache');
  assert.ok(res.headers.etag);
  const again = await getMe(me, { 'If-None-Match': res.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.text, '');
});

test('GET /me for a guest is the guest; without a token it is 401', async () => {
  const g = await guest();
  const res = await getMe(g);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('User', res.body);
  assert.equal(res.body.accountType, 'guest');
  assert.equal(res.body.id, g.id);
  assertProblem(await request(app).get('/v1/me').set(CLIENT), 401, 'UNAUTHENTICATED');
});

test('an old account\'s values that are not in the spec\'s shape come back as null or mapped', async () => {
  const me = await account({ gender: 'other', dateOfBirth: '01/02/2000', preferredLanguage: 'English' });
  const { body } = await getMe(me);
  assert.equal(body.gender, 'prefer_not_to_say');
  assert.equal(body.dateOfBirth, null);
  assert.equal(body.preferredLanguage, null);
});

// ---------------------------------------------------------------------------
// PATCH /me
// ---------------------------------------------------------------------------

test('names are tidied; invisible and control characters are refused; emoji are fine; null removes it', async () => {
  const me = await account();
  let res = await patchMe(me, { name: '  Amelia \t  Jane  ' });
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('User', res.body);
  assert.equal(res.body.name, 'Amelia Jane');
  assert.ok(res.headers.etag);

  for (const bad of ['Ame\u200Blia', 'Amelia\u0007', '\u202EailemA']) {
    assertProblem(await patchMe(me, { name: bad }), 422, 'NAME_INVALID');
  }
  assert.equal((await patchMe(me, { name: 'Ana 👩‍👩‍👧' })).body.name, 'Ana 👩‍👩‍👧');
  res = await patchMe(me, { name: null });
  assert.equal(res.body.name, null);
  assert.equal((await User.findById(me.user._id).lean()).name, undefined);
  assert.equal(cleanName('é'), 'é', 'stored in NFC');
});

test('gender and language: the spec\'s values, null clears gender, other languages are refused', async () => {
  const me = await account();
  assert.equal((await patchMe(me, { gender: 'non_binary' })).body.gender, 'non_binary');
  assert.equal((await User.findById(me.user._id).lean()).gender, 'non_binary');
  assert.equal((await patchMe(me, { gender: null })).body.gender, null);
  assert.equal((await patchMe(me, { preferredLanguage: 'hi' })).body.preferredLanguage, 'hi');
  assertProblem(await patchMe(me, { preferredLanguage: 'it' }), 422, 'LANGUAGE_UNSUPPORTED');
  assertProblem(await patchMe(me, { gender: 'other' }), 422, 'VALIDATION_FAILED');
  assertProblem(await patchMe(me, {}), 422, 'VALIDATION_FAILED');
});

test('plain application/json works as well as merge-patch', async () => {
  const me = await account();
  const res = await request(app).patch('/v1/me').set(me.headers).send({ name: 'Plain' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.name, 'Plain');
});

test('date of birth: set once, one change within 30 days, then locked', async () => {
  const me = await account();
  let res = await patchMe(me, { dateOfBirth: '2000-01-12' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.dateOfBirth, '2000-01-12');
  assert.equal(res.body.onboarding.steps.find((s) => s.step === 'date_of_birth').status, 'completed');

  // The same date again is not a change.
  assert.equal((await patchMe(me, { dateOfBirth: '2000-01-12' })).status, 200);
  res = await patchMe(me, { dateOfBirth: '2000-01-21' });
  assert.equal(res.status, 200, 'one typo fix');
  assertProblem(await patchMe(me, { dateOfBirth: '2000-01-22' }), 409, 'DATE_OF_BIRTH_LOCKED');
  assert.equal((await getMe(me)).body.dateOfBirth, '2000-01-21');
});

test('date of birth: no change at all after 30 days', async () => {
  const me = await account();
  await patchMe(me, { dateOfBirth: '2000-01-12' });
  clock.t += 31 * DAY;
  assertProblem(await patchMe(me, { dateOfBirth: '2000-01-21' }), 409, 'DATE_OF_BIRTH_LOCKED');
});

test('date of birth: two changes at once use the one allowed change once', async () => {
  const me = await account();
  await patchMe(me, { dateOfBirth: '2000-01-12' });
  const results = await Promise.all(['2000-01-13', '2000-01-14', '2000-01-15'].map((d) => patchMe(me, { dateOfBirth: d })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await User.findById(me.user._id).lean()).dateOfBirthChanges, 1);
});

test('under 13 is refused, flagged, and not stored', async () => {
  const me = await account();
  const res = await patchMe(me, { dateOfBirth: yearsAgo(13, -2) });
  assertProblem(res, 422, 'AGE_REQUIREMENT_NOT_MET');
  const stored = await User.findById(me.user._id).lean();
  assert.equal(stored.dateOfBirth, undefined);
  assert.ok(stored.ageCheckFailedAt instanceof Date);
  assertProblem(await patchMe(me, { dateOfBirth: '2001-02-29' }), 422, 'DATE_OF_BIRTH_INVALID');
});

test('If-Match: a stale ETag is 412, the current one goes through', async () => {
  const me = await account();
  const first = await getMe(me);
  await patchMe(me, { name: 'Changed elsewhere' });
  assertProblem(await patchMe(me, { name: 'Mine' }, { 'If-Match': first.headers.etag }), 412, 'PRECONDITION_FAILED');
  const fresh = await getMe(me);
  const res = await patchMe(me, { name: 'Mine' }, { 'If-Match': fresh.headers.etag });
  assert.equal(res.status, 200, res.text);
  assert.notEqual(res.headers.etag, fresh.headers.etag);
});

test('If-Match: three edits at once from the same copy: one is saved, the others are 412', async () => {
  const me = await account();
  const { headers } = await getMe(me);
  const results = await Promise.all(['One', 'Two', 'Three'].map((name) => patchMe(me, { name }, { 'If-Match': headers.etag })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 412, 412]);
});

test('If-Match: accepting the terms or skipping a step does not make the profile stale; weak tags never match', async () => {
  const me = await account();
  const first = await getMe(me);
  assert.equal((await request(app).post('/v1/me/consents').set(me.headers).send({ documentType: 'terms', version: TERMS, accepted: true })).status, 201);
  assert.equal((await putStep(me, 'interests', 'skipped')).status, 200);
  const res = await patchMe(me, { gender: 'female' }, { 'If-Match': first.headers.etag });
  assert.equal(res.status, 200, res.text);
  assertProblem(await patchMe(me, { gender: 'male' }, { 'If-Match': `W/${res.headers.etag}` }), 412, 'PRECONDITION_FAILED');
  assert.equal((await patchMe(me, { gender: 'male' }, { 'If-Match': '*' })).status, 200);
  // A cached GET still gets 304 only when nothing in the body changed.
  assert.equal((await getMe(me, { 'If-None-Match': first.headers.etag })).status, 200);
});

test('a date of birth the old API stored as a date or a number can be replaced', async () => {
  for (const old of [new Date('2000-01-12T00:00:00Z'), 947635200000]) {
    const me = await account();
    await User.collection.updateOne({ _id: me.user._id }, { $set: { dateOfBirth: old } });
    const res = await patchMe(me, { dateOfBirth: '2000-01-12' });
    assert.equal(res.status, 200, res.text);
    assert.equal((await User.findById(me.user._id).lean()).dateOfBirth, '2000-01-12');
  }
});

test('date of birth: the same first date twice at once is saved once, and both answers are 200', async () => {
  const me = await account();
  const results = await Promise.all([1, 2].map(() => patchMe(me, { dateOfBirth: '2000-01-12' })));
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal((await User.findById(me.user._id).lean()).dateOfBirthChanges, 0);
});

test('once onboarding is finished, clearing a field does not send the person back into it', async () => {
  const me = await account({
    phone: '+14155550123', phoneVerifiedAt: new Date(), dateOfBirth: '2000-01-12', dateOfBirthSetAt: new Date(), gender: 'female', name: 'Amelia',
  });
  await request(app).post('/v1/me/consents').set(me.headers).send({ documentType: 'terms', version: TERMS, accepted: true });
  assert.equal((await putStep(me, 'interests', 'skipped')).body.status, 'completed');
  for (const patch of [{ name: null }, { gender: null }]) {
    const res = await patchMe(me, patch);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([res.body.onboarding.status, res.body.onboarding.nextStep], ['completed', null]);
  }
  assert.equal((await getMe(me)).body.onboarding.steps.find((s) => s.step === 'gender').status, 'pending', 'the step itself is honest');
});

test('names: invisible or blank-looking characters are refused and a name needs something visible; flags and joined emoji are fine', () => {
  const refused = [
    '\u200D', '\u3164', '\uFFA0', '\u2800', '\u034F', '\uFE0F', '\u0301',
    'Ana\u200E', 'Ana\u200F', 'Ana\u061C', 'Ana\u00AD', 'Ana\u2061', 'Ana\u180E', 'Ana\u{E0041}', 'Ana\uD800', 'Ana\u0085',
  ];
  for (const name of refused) assert.throws(() => cleanName(name), { code: 'NAME_INVALID' }, JSON.stringify(name));
  const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  for (const name of [`Ana ${england}`, 'Ana \u{1F469}\u200D\u{1F469}\u200D\u{1F467}', 'Jos\u00E9', '\u674E\u5C0F\u9F8D', 'Ana \u2764\uFE0F', '<3']) {
    assert.equal(cleanName(name), name, JSON.stringify(name));
  }
});

test('a guest can change its language only', async () => {
  const g = await guest();
  const res = await patchMe(g, { preferredLanguage: 'de' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.preferredLanguage, 'de');
  assertProblem(await patchMe(g, { name: 'Guest' }), 403, 'GUEST_NOT_ALLOWED');
  assertProblem(await patchMe(g, { preferredLanguage: 'it' }), 422, 'LANGUAGE_UNSUPPORTED');
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

test('onboarding follows the data, and Later skips the optional steps', async () => {
  const me = await account();
  let { body } = await request(app).get('/v1/me/onboarding').set(me.headers);
  assertMatchesSpec('Onboarding', body);
  assert.equal(body.nextStep, 'phone_verified');

  await User.updateOne({ _id: me.user._id }, { $set: { phone: '+14155550123', mobileNumberVerified: true, phoneVerifiedAt: new Date() } });
  await patchMe(me, { dateOfBirth: '2000-01-12', gender: 'female' });
  ({ body } = await request(app).get('/v1/me/onboarding').set(me.headers));
  assert.equal(body.nextStep, 'terms_accepted');
  assert.ok(body.steps.find((s) => s.step === 'phone_verified').updatedAt);

  await request(app).post('/v1/me/consents').set(me.headers).send({ documentType: 'terms', version: '2026-09-01', accepted: true });
  ({ body } = await request(app).get('/v1/me/onboarding').set(me.headers));
  assert.equal(body.nextStep, 'interests');

  let res = await putStep(me, 'interests', 'skipped');
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Onboarding', res.body);
  assert.equal(res.body.nextStep, 'profile');
  res = await putStep(me, 'profile', 'skipped');
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.nextStep, null);
  assert.equal((await getMe(me)).body.onboarding.status, 'completed');

  // A name completes the profile step even after it was skipped.
  res = await patchMe(me, { name: 'Amelia' });
  assert.equal(res.body.onboarding.steps.find((s) => s.step === 'profile').status, 'completed');
});

test('data steps cannot be marked done without their data, nor skipped', async () => {
  const me = await account();
  assertProblem(await putStep(me, 'date_of_birth', 'completed'), 422, 'ONBOARDING_STEP_INVALID');
  assertProblem(await putStep(me, 'gender', 'skipped'), 422, 'ONBOARDING_STEP_NOT_SKIPPABLE');
  assertProblem(await putStep(me, 'terms_accepted', 'skipped'), 422, 'ONBOARDING_STEP_NOT_SKIPPABLE');
  await patchMe(me, { gender: 'male' });
  assert.equal((await putStep(me, 'gender', 'completed')).status, 200, 'done already: a no-op');
  assertProblem(await putStep(me, 'nonsense', 'completed'), 422, 'VALIDATION_FAILED');
});

test('with the phone not required, the phone step is skipped', async () => {
  const relaxed = buildApp({ features: { ...config.features, phoneVerificationRequired: false } });
  const me = await account();
  const { body } = await request(relaxed).get('/v1/me/onboarding').set(me.headers);
  const phone = body.steps.find((s) => s.step === 'phone_verified');
  assert.deepEqual([phone.status, phone.skippable], ['skipped', true]);
  assert.equal(body.nextStep, 'date_of_birth');
});

test('a guest\'s onboarding is the birthday, already done', async () => {
  const g = await guest();
  const { body } = await request(app).get('/v1/me/onboarding').set(g.headers);
  assert.deepEqual(body.steps.map((s) => s.step), ['date_of_birth']);
  assert.equal(body.status, 'completed');
  assert.equal((await putStep(g, 'date_of_birth', 'completed')).status, 200);
  assertProblem(await putStep(g, 'interests', 'skipped'), 422, 'ONBOARDING_STEP_INVALID');
});
