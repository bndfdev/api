process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { toUserResponse, buildOnboarding, isSuspended } = require('../src/modules/users/service');

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
const ajv = new Ajv2020({ strict: false, logger: false });
const assertUser = (user) => assert.equal(ajv.validate({ $ref: '#/components/schemas/User', components: spec.components }, user), true, JSON.stringify(ajv.errors));

const created = new Date('2026-10-01T09:30:15.123Z');
const base = () => ({ _id: '6650f1c2a4b7e9d3c1f00a12', email: 'amelia.jane@example.com', password: '$argon2id$x', createdAt: created });

test('toUserResponse builds the spec User for a new account and never exposes the password or internal fields', () => {
  const user = toUserResponse({
    ...base(), emailVerified: true, passwordAlgo: 'argon2id',
    loginFailedCount: 3, loginLockedUntil: new Date(), isBlocked: false, failedLoginAttempts: 2, deviceId: 'abc',
  });
  assertUser(user);
  assert.equal(user.id, '6650f1c2a4b7e9d3c1f00a12');
  assert.equal(user.createdAt, '2026-10-01T09:30:15Z', 'whole seconds, UTC');
  assert.equal(user.updatedAt, user.createdAt);
  assert.deepEqual(user.loginMethods, ['password']);
  assert.ok(!('password' in user) && !('passwordAlgo' in user));
  const text = JSON.stringify(user);
  // ("password" itself is a legitimate word here: the login method and an onboarding step.)
  for (const hidden of ['argon2id', 'loginFailed', 'loginLocked', 'isBlocked', 'failedLoginAttempts', 'deviceId']) {
    assert.ok(!text.includes(hidden), `${hidden} is exposed`);
  }
});

test('toUserResponse passes real profile data through and keeps updatedAt when there is one', () => {
  const user = toUserResponse({
    ...base(), name: '  Amelia Jane ', dateOfBirth: '2000-01-12', gender: 'female', preferredLanguage: 'hi', phone: '+14155550123',
    mobileNumberVerified: true, phoneVerifiedAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-02T00:00:00Z'),
  });
  assertUser(user);
  assert.equal(user.name, 'Amelia Jane');
  assert.equal(user.dateOfBirth, '2000-01-12');
  assert.equal(user.gender, 'female');
  assert.equal(user.preferredLanguage, 'hi');
  assert.equal(user.phoneNumber, '+14155550123');
  assert.equal(user.phoneVerified, true);
  assert.equal(user.updatedAt, '2026-10-02T00:00:00Z');
});

test('toUserResponse reports values the spec does not allow as null (older users)', () => {
  const user = toUserResponse({
    ...base(), name: 'x'.repeat(80), dateOfBirth: '12/01/2000', gender: 'other', preferredLanguage: 'English', phone: '555-1234',
    profileImage: '/uploads/a.png', profileBanner: '/uploads/b.png',
  });
  assertUser(user);
  assert.equal([...user.name].length, 50, 'cut to the longest name the spec allows');
  assert.equal(user.dateOfBirth, null);
  assert.equal(user.gender, 'prefer_not_to_say');
  assert.equal(user.preferredLanguage, null);
  assert.equal(user.phoneNumber, null);
  assert.equal(user.avatar, null);
  assert.equal(user.banner, null);
});

test('a user without a stored email verification still counts as verified (older users signed up with an emailed code)', () => {
  assert.equal(toUserResponse(base()).emailVerified, true);
  assert.equal(toUserResponse({ ...base(), emailVerified: false }).emailVerified, false);
});

test('onboarding is worked out from the data that exists, and the first pending step is next', () => {
  assert.equal(buildOnboarding(base()).nextStep, 'phone_verified');

  const oldApiNumber = buildOnboarding({ ...base(), phone: '+14155550123', mobileNumberVerified: true });
  assert.equal(oldApiNumber.nextStep, 'phone_verified', 'a number from the old API (fixed code) is not proof');
  assert.equal(toUserResponse({ ...base(), phone: '+14155550123', mobileNumberVerified: true }).phoneVerified, false);

  const progressed = buildOnboarding({ ...base(), phone: '+14155550123', phoneVerifiedAt: new Date(), dateOfBirth: '2000-01-12' });
  assert.equal(progressed.nextStep, 'terms_accepted', 'terms are not stored yet, so always pending');
  assert.equal(progressed.status, 'in_progress');
  assert.deepEqual(progressed.steps.filter((s) => s.status === 'completed').map((s) => s.step), ['email_verified', 'password_set', 'phone_verified', 'date_of_birth']);

  const noPassword = buildOnboarding({ ...base(), password: '' });
  assert.equal(noPassword.steps.find((s) => s.step === 'password_set').status, 'pending');
  assert.equal(noPassword.nextStep, 'password_set');

  const profile = buildOnboarding({ ...base(), name: 'Amelia', gender: 'male' });
  assert.equal(profile.steps.find((s) => s.step === 'profile').status, 'completed');
  assert.equal(profile.steps.find((s) => s.step === 'gender').status, 'completed');
  assert.ok(profile.steps.every((s) => s.updatedAt === null && typeof s.skippable === 'boolean'));
});

test('isSuspended: blocked with no end date, or an end date in the future', () => {
  const at = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(isSuspended({}, at), false);
  assert.equal(isSuspended({ isBlocked: false, blockedUntil: new Date(at + 1000) }, at), false);
  assert.equal(isSuspended({ isBlocked: true, blockedUntil: null }, at), true);
  assert.equal(isSuspended({ isBlocked: true }, at), true);
  assert.equal(isSuspended({ isBlocked: true, blockedUntil: new Date(at + 1000) }, at), true);
  assert.equal(isSuspended({ isBlocked: true, blockedUntil: new Date(at) }, at), false, 'ended');
  assert.equal(isSuspended({ isBlocked: true, blockedUntil: new Date(at - 1000) }, at), false);
});
