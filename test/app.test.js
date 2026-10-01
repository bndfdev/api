process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

const app = createApp();

test('GET / returns the legacy text', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.equal(res.text, 'Bondfire API is running');
});

test('legacy GET /health keeps its shape', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.message, 'API is healthy');
});

test('every response carries X-Request-Id', async () => {
  const res = await request(app).get('/');
  assert.match(res.headers['x-request-id'], /^[A-Za-z0-9._-]{8,128}$/);
});

test('a valid incoming X-Request-Id is echoed', async () => {
  const res = await request(app).get('/').set('X-Request-Id', 'client-req-12345');
  assert.equal(res.headers['x-request-id'], 'client-req-12345');
});

test('an invalid incoming X-Request-Id is replaced', async () => {
  const res = await request(app).get('/').set('X-Request-Id', 'bad id!');
  assert.notEqual(res.headers['x-request-id'], 'bad id!');
  assert.match(res.headers['x-request-id'], /^[A-Za-z0-9._-]{8,128}$/);
});

test('unknown /v1 path returns a problem+json 404', async () => {
  const res = await request(app).get('/v1/does-not-exist?secret=1');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^application\/problem\+json/);
  assert.equal(res.body.code, 'NOT_FOUND');
  assert.equal(res.body.status, 404);
  assert.equal(res.body.type, 'https://api.bondfire.app/errors/not-found');
  assert.ok(res.body.title);
  assert.equal(res.body.instance, '/v1/does-not-exist');
  assert.equal(res.body.requestId, res.headers['x-request-id']);
});

test('malformed JSON body returns a 400 problem', async () => {
  const res = await request(app)
    .post('/v1/anything')
    .set('Content-Type', 'application/json')
    .send('{"broken":');
  assert.equal(res.status, 400);
  assert.match(res.headers['content-type'], /^application\/problem\+json/);
  assert.equal(res.body.code, 'MALFORMED_REQUEST');
});

test('oversized body returns a 413 problem', async () => {
  const res = await request(app)
    .post('/v1/anything')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
});

test('unexpected errors become a 500 problem without internals', async () => {
  const secretMessage = 'db password is hunter2';
  const testApp = createApp({
    extend(a) {
      a.get('/v1/boom', () => {
        throw new Error(secretMessage);
      });
    },
  });
  const res = await request(testApp).get('/v1/boom');
  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /^application\/problem\+json/);
  assert.equal(res.body.code, 'INTERNAL_ERROR');
  assert.ok(!res.text.includes(secretMessage));
  assert.ok(!res.text.includes('at '));
});

test('ApiError maps to its problem with Retry-After', async () => {
  const { ApiError } = require('../src/lib/problem');
  const testApp = createApp({
    extend(a) {
      a.get('/v1/limited', () => {
        throw new ApiError({ status: 429, code: 'RATE_LIMITED', title: 'Slow down', retryAfterSeconds: 7 });
      });
    },
  });
  const res = await request(testApp).get('/v1/limited');
  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '7');
  assert.equal(res.body.retryAfterSeconds, 7);
});

test('unsupported content encoding returns a 415 problem, not 500', async () => {
  const res = await request(app)
    .post('/v1/x')
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'br')
    .send('{}');
  assert.equal(res.status, 415);
  assert.match(res.headers['content-type'], /^application\/problem\+json/);
  assert.equal(res.body.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.ok(!res.text.includes('unsupported content encoding'));
});

test('swagger UI is still mounted at /api-docs/', async () => {
  const res = await request(app).get('/api-docs/');
  assert.equal(res.status, 200);
});
