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
const { PASSWORD_POLICY } = require('../src/lib/passwords');
const { RULES } = require('../src/modules/challenges/service');
const { createMetaService, localeFrom, flagOf } = require('../src/modules/meta/service');
const { createMetaRouter } = require('../src/modules/meta/routes');
const { createClientVersionGate, compareVersions, parseVersion } = require('../src/middleware/clientVersion');
const { createAuthService } = require('../src/modules/auth/service');
const { createAuthRouter } = require('../src/modules/auth/routes');
const db = require('./support/db');
const { assertProblem, CLIENT } = require('./support/api');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const app = createApp({ trustProxy: 1 });

/** An app with some config values replaced. */
function appWith(overrides) {
  const custom = { ...config, ...overrides };
  return createApp({
    trustProxy: 1,
    metaRouter: createMetaRouter({ meta: createMetaService({ config: custom }) }),
    versionGate: createClientVersionGate({ config: custom }),
    authRouter: createAuthRouter({ service: createAuthService({ config: custom, logger: silent }) }),
  });
}

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
const ajv = new Ajv2020({ strict: false, logger: false });
const assertMatchesSpec = (name, value) => assert.equal(
  ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value),
  true,
  `${name}: ${JSON.stringify(ajv.errors)}`,
);

before(db.connect);
beforeEach(db.clear);
after(db.disconnect);

// ---------------------------------------------------------------------------
// GET /config
// ---------------------------------------------------------------------------

test('GET /config serves the rules the server enforces, with an ETag', async () => {
  const res = await request(app).get('/v1/config').set(CLIENT);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('AppConfig', res.body);
  assert.deepEqual(res.body.passwordPolicy, PASSWORD_POLICY);
  assert.deepEqual(res.body.otp, { length: 6, ttlSeconds: RULES.ttlSeconds, resendCooldownSeconds: RULES.resendCooldownSeconds, maxAttempts: RULES.maxAttempts });
  assert.equal(res.body.minimumAge, 13);
  assert.deepEqual(res.body.supportedLanguages.map((l) => l.tag), ['en', 'es', 'fr', 'de', 'hi']);
  assert.deepEqual(res.body.minimumSupportedVersion, { ios: '1.0.0', android: '1.0.0', web: '1.0.0' });
  assert.equal(res.body.latestVersion, undefined, 'left out until set');
  assert.equal(res.body.features.guestMode, true);
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  const again = await request(app).get('/v1/config').set({ ...CLIENT, 'If-None-Match': res.headers.etag });
  assert.equal(again.status, 304);
});

test('config switches show up in /config', async () => {
  const custom = appWith({
    app: { minimumVersions: { ios: '1.2.0', android: '1.0.0', web: '1.0.0' }, latestVersions: { ios: '1.5.0' } },
    features: { guestMode: false, phoneVerificationRequired: false },
  });
  const { body } = await request(custom).get('/v1/config').set({ ...CLIENT, 'X-Client-Version': '1.4.0' });
  assert.equal(body.minimumSupportedVersion.ios, '1.2.0');
  assert.deepEqual(body.latestVersion, { ios: '1.5.0' });
  assert.equal(body.features.guestMode, false);
  assert.equal(body.features.phoneVerificationRequired, false);
});

// ---------------------------------------------------------------------------
// Minimum app version
// ---------------------------------------------------------------------------

test('a build older than the minimum gets 426 UPGRADE_REQUIRED on any call', async () => {
  const strict = appWith({ app: { minimumVersions: { ios: '2.1.0', android: '1.0.0', web: '1.0.0' }, latestVersions: {} } });
  const old = await request(strict).get('/v1/config').set({ ...CLIENT, 'X-Client-Version': '2.0.9' });
  assertProblem(old, 426, 'UPGRADE_REQUIRED');
  assert.equal(old.body.meta.minimumVersion, '2.1.0');
  assertProblem(await request(strict).post('/v1/auth/login').set({ ...CLIENT, 'X-Client-Version': '1.4.0' }).send({}), 426, 'UPGRADE_REQUIRED');
  assert.equal((await request(strict).get('/v1/config').set({ ...CLIENT, 'X-Client-Version': '2.1.0' })).status, 200);
  assert.equal((await request(strict).get('/v1/config').set({ ...CLIENT, 'X-Client-Version': '10.0.0+3' })).status, 200);
  assert.equal((await request(strict).get('/v1/config').set({ ...CLIENT, 'X-Client-Platform': 'android', 'X-Client-Version': '1.0.0' })).status, 200);
  assert.equal((await request(strict).get('/v1/config').set({ ...CLIENT, 'X-Client-Version': 'dev' })).status, 200, 'unreadable: let through');
  assert.equal(compareVersions(parseVersion('1.10.0'), parseVersion('1.9.9')) > 0, true);
});

// ---------------------------------------------------------------------------
// GET /countries
// ---------------------------------------------------------------------------

test('GET /countries lists every country with dial code, flag and example, sorted by name', async () => {
  const res = await request(app).get('/v1/countries').set(CLIENT);
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('CountryList', res.body);
  assert.ok(res.body.data.length > 200);
  const india = res.body.data.find((c) => c.code === 'IN');
  assert.deepEqual([india.name, india.dialCode, india.flagEmoji, india.phoneSignupSupported], ['India', '+91', '🇮🇳', true]);
  assert.match(india.exampleNumber, /\d/);
  assert.equal(india.contentAvailable, undefined, 'left out until CONTENT_REGIONS is set');
  const names = res.body.data.map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
  assert.ok(['US', 'CA'].every((code) => res.body.data.some((c) => c.code === code && c.dialCode === '+1')), '+1 countries are separate');
  assert.equal(res.body.defaultCountryCode, 'US');
  // Added to whatever else varies the response (CORS's Origin), and the country headers too.
  const vary = (r) => (r.headers.vary || '').split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
  const expected = [...vary(await request(app).get('/v1/config').set(CLIENT)), 'accept-language', 'cloudfront-viewer-country', 'cf-ipcountry'];
  for (const field of expected) assert.ok(vary(res).includes(field), `Vary has ${field}: ${res.headers.vary}`);
  assert.equal(res.headers['cache-control'], 'public, max-age=86400');
  assert.equal((await request(app).get('/v1/countries').set({ ...CLIENT, 'If-None-Match': res.headers.etag })).status, 304);
});

test('countries: names follow Accept-Language; the CDN country preselects; regions mark what is supported', async () => {
  const hindi = await request(app).get('/v1/countries').set({ ...CLIENT, 'Accept-Language': 'hi-IN,hi;q=0.9,en;q=0.5' });
  assert.equal(hindi.body.data.find((c) => c.code === 'IN').name, 'भारत');
  const fromIndia = await request(app).get('/v1/countries').set({ ...CLIENT, 'CF-IPCountry': 'IN' });
  assert.equal(fromIndia.body.defaultCountryCode, 'IN');
  const bogus = await request(app).get('/v1/countries').set({ ...CLIENT, 'CF-IPCountry': 'XX' });
  assert.equal(bogus.body.defaultCountryCode, 'US');

  const limited = appWith({ phone: { regions: ['US', 'IN'], refuseVoip: false }, countries: { contentRegions: ['US'], defaultCountry: 'IN' } });
  const { body } = await request(limited).get('/v1/countries').set(CLIENT);
  const by = (code) => body.data.find((c) => c.code === code);
  assert.deepEqual([by('US').phoneSignupSupported, by('IN').phoneSignupSupported, by('GB').phoneSignupSupported], [true, true, false]);
  assert.deepEqual([by('US').contentAvailable, by('IN').contentAvailable], [true, false]);
  assert.equal(body.defaultCountryCode, 'IN');

  const german = await request(app).get('/v1/countries').set({ ...CLIENT, 'Accept-Language': 'fr;q=0.1, de;q=0.9' });
  assert.equal(german.body.data.find((c) => c.code === 'IN').name, 'Indien', 'the q-values decide');
  assert.equal(localeFrom('fr-CA,fr;q=0.8'), 'fr');
  assert.equal(localeFrom('ja, en-GB;q=0.5'), 'en');
  assert.equal(localeFrom('ja'), 'en', 'not an app language');
  assert.equal(localeFrom('***'), 'en');
  assert.equal(flagOf('US'), '🇺🇸');
});

// ---------------------------------------------------------------------------
// Switches enforced elsewhere
// ---------------------------------------------------------------------------

test('the version gate only knows its own platforms: "constructor" or "__proto__" is a 400, not a 500', async () => {
  for (const platform of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const res = await request(app).get('/v1/config').set({ ...CLIENT, 'X-Client-Platform': platform });
    assert.equal(res.status, 400, `${platform}: ${res.text}`);
  }
});

test('guest mode off: POST /auth/guest is 403 FORBIDDEN; languages outside the list are refused', async () => {
  const off = appWith({ features: { guestMode: false, phoneVerificationRequired: true } });
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const body = { device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' };
  assertProblem(await request(off).post('/v1/auth/guest').set(headers).send(body), 403, 'FORBIDDEN');
  assertProblem(await request(app).post('/v1/auth/guest').set(headers).send({ ...body, preferredLanguage: 'it' }), 422, 'LANGUAGE_UNSUPPORTED');
  assert.equal((await request(app).post('/v1/auth/guest').set(headers).send({ ...body, preferredLanguage: 'es' })).status, 201);
});
