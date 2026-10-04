process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const fs = require('node:fs');
const mongoose = require('mongoose');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { createApp } = require('../src/app');

const app = createApp();
const CLIENT = {
  'X-Client-Platform': 'ios',
  'X-Client-Version': '1.0.0',
  'X-Installation-Id': '3f2b8c1e-9d4a-4b6e-8f10-1a2b3c4d5e6f',
};

// readyState is a prototype accessor on the connection; shadow it per test.
function withReadyState(state, fn) {
  return async () => {
    Object.defineProperty(mongoose.connection, 'readyState', { value: state, configurable: true });
    try {
      await fn();
    } finally {
      delete mongoose.connection.readyState;
    }
  };
}

function assertProblem(res, status, code) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/problem\+json/);
  assert.equal(res.body.code, code);
  assert.equal(res.body.status, status);
  assert.equal(res.body.requestId, res.headers['x-request-id']);
}

// Health is unversioned in the spec, so it is served at the root, outside the
// request validator. The bodies are checked against the spec schemas here.
const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
const ajv = new Ajv2020({ strict: false });
// Carry spec.components along so '#/components/...' references resolve.
const specResponse = (route, status) => ({
  ...spec.paths[route].get.responses[status].content['application/json'].schema,
  components: spec.components,
});

test('GET /health matches the spec liveness schema', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(ajv.validate(specResponse('/health', '200'), res.body), true, JSON.stringify(ajv.errors));
});

test('GET /health/ready is ready when MongoDB is connected', withReadyState(1, async () => {
  const res = await request(app).get('/health/ready');
  assert.equal(res.status, 200);
  assert.equal(ajv.validate(specResponse('/health/ready', '200'), res.body), true, JSON.stringify(ajv.errors));
  assert.deepEqual(res.body, { status: 'ready', checks: { database: 'ok' } });
}));

test('GET /health/ready is 503 when MongoDB is not connected', withReadyState(0, async () => {
  const res = await request(app).get('/health/ready');
  assert.equal(res.status, 503);
  assert.equal(ajv.validate(specResponse('/health/ready', '503'), res.body), true, JSON.stringify(ajv.errors));
  assert.deepEqual(res.body, { status: 'down', checks: { database: 'failing' } });
}));

test('health is not served under /v1; other methods on it are 405 with Allow', async () => {
  assertProblem(await request(app).get('/v1/health'), 404, 'NOT_FOUND');
  const res = await request(app).post('/health/ready');
  assertProblem(res, 405, 'METHOD_NOT_ALLOWED');
  assert.equal(res.headers.allow, 'GET, HEAD');
});

test('validation runs before handlers: an invalid body gets 422 with errors[]', async () => {
  const res = await request(app).post('/v1/auth/login').set(CLIENT).send({});
  assertProblem(res, 422, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(res.body.errors));
  const fields = res.body.errors.map((e) => e.field);
  assert.ok(fields.includes('/email'));
  assert.ok(fields.includes('/password'));
  for (const e of res.body.errors) {
    assert.deepEqual(Object.keys(e).sort(), ['code', 'field', 'message']);
  }
});

test('validation errors do not echo request values', async () => {
  const secret = 'hunter2-not-an-email-@@';
  const res = await request(app)
    .post('/v1/auth/login')
    .set(CLIENT)
    .send({ email: secret, password: 'Passw0rd!Passw0rd', device: 12345 });
  assert.equal(res.status, 422);
  assert.ok(!res.text.includes(secret));
});

test('a missing required header is a 400 MALFORMED_REQUEST', async () => {
  const res = await request(app).post('/v1/auth/login').send({});
  assertProblem(res, 400, 'MALFORMED_REQUEST');
  assert.ok(res.body.errors.some((e) => e.field === 'x-client-platform'));
});

test('a missing body is a 400 MALFORMED_REQUEST', async () => {
  const res = await request(app).post('/v1/auth/login').set(CLIENT);
  assertProblem(res, 400, 'MALFORMED_REQUEST');
});

test('a non-JSON content type is a 415', async () => {
  const res = await request(app)
    .post('/v1/auth/login')
    .set(CLIENT)
    .set('Content-Type', 'text/plain')
    .send('hello');
  assertProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
});

test('an invalid query parameter is a 422 naming the parameter', async () => {
  const res = await request(app).get('/v1/interests/search').set(CLIENT).query({ q: '' });
  assertProblem(res, 422, 'VALIDATION_FAILED');
  assert.equal(res.body.errors[0].field, 'q');
});

// Documented operations that no module implements yet pass validation and then
// reach the /v1 fallthrough, which answers 404 NOT_FOUND. This changes per
// operation as feature modules land.
test('a valid request to a not-yet-implemented operation falls through to 404', async () => {
  // Social login comes last (after the tester build); pick another unbuilt operation when it lands.
  const res = await request(app)
    .post('/v1/auth/social')
    .set(CLIENT)
    .send({
      credential: { provider: 'google', idToken: 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln' },
      device: { installationId: CLIENT['X-Installation-Id'], platform: 'ios', appVersion: '1.4.0' },
    });
  assertProblem(res, 404, 'NOT_FOUND');
});

test('an unknown /v1 path is a 404 problem', async () => {
  assertProblem(await request(app).get('/v1/no/such/thing'), 404, 'NOT_FOUND');
});

test('a wrong method on a documented /v1 path is a 405 with the spec Allow header', async () => {
  const res = await request(app).get('/v1/auth/login').set(CLIENT);
  assertProblem(res, 405, 'METHOD_NOT_ALLOWED');
  assert.equal(res.headers.allow, 'POST');
});
