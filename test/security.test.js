process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { config } = require('../src/config');

const app = createApp();
const ALLOWED = 'http://localhost:3000';

test('helmet headers are present', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('swagger UI still loads (without a CSP, which it cannot satisfy)', async () => {
  const res = await request(app).get('/api-docs/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-security-policy'], undefined);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('an allowed origin gets CORS headers and exposed headers', async () => {
  assert.ok(config.corsOrigins.includes(ALLOWED));
  const res = await request(app).get('/health').set('Origin', ALLOWED);
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], ALLOWED);
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
  assert.match(res.headers['access-control-expose-headers'], /X-Request-Id/);
  assert.match(res.headers['access-control-expose-headers'], /Retry-After/);
  assert.match(res.headers['access-control-expose-headers'], /Idempotent-Replayed/);
});

test('a disallowed origin gets no CORS headers and no error', async () => {
  const res = await request(app).get('/health').set('Origin', 'https://evil.example');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
});

test('a request without Origin works', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
});

test('preflight for an allowed origin succeeds and lists the API headers', async () => {
  const res = await request(app)
    .options('/v1/auth/login')
    .set('Origin', ALLOWED)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'idempotency-key,x-client-version');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], ALLOWED);
  assert.match(res.headers['access-control-allow-headers'], /Idempotency-Key/);
  assert.match(res.headers['access-control-allow-headers'], /X-Client-Version/);
  assert.match(res.headers['access-control-allow-headers'], /x-api-key/);
});

test('preflight for a disallowed origin carries no CORS headers', async () => {
  const res = await request(app)
    .options('/v1/auth/login')
    .set('Origin', 'https://evil.example')
    .set('Access-Control-Request-Method', 'POST');
  assert.ok(res.status < 500);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
