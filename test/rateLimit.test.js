process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { RateLimiterMemory, RateLimiterRes } = require('rate-limiter-flexible');
const { createApp } = require('../src/app');
const { sha256 } = require('../src/lib/secrets');
const { rateLimit, defaultStoreFactory, byIp, byInstallation, byUser, COLLECTION } = require('../src/middleware/rateLimit');
const { LIMITS } = require('../src/modules/sessions/routes');
const db = require('./support/db');
const { CLIENT, makeUser, signIn, assertProblem } = require('./support/api');

before(db.connect);
beforeEach(db.clear);
after(db.disconnect);

// Every test uses its own limit names, so counters never leak between tests.
let counter = 0;
const uniqueName = (label) => `test-${label}-${(counter += 1)}`;

/** An app with one GET route behind the given limiters (the `extend` hook is for tests only). */
function appWith(...limiters) {
  return createApp({
    extend(app) {
      app.get('/test/limited', ...limiters, (req, res) => res.json({ ok: true }));
    },
  });
}

const byHeader = (req) => req.get('x-test-key');

test('requests beyond the limit get 429 RATE_LIMITED with Retry-After and RateLimit', async () => {
  const app = appWith(rateLimit({ name: uniqueName('basic'), points: 2, durationSeconds: 60, key: byHeader }));
  const hit = () => request(app).get('/test/limited').set('x-test-key', 'a');

  const first = await hit();
  assert.equal(first.status, 200);
  assert.match(first.headers.ratelimit, /^limit=2, remaining=1, reset=(60|59)$/);
  const second = await hit();
  assert.equal(second.status, 200);
  assert.match(second.headers.ratelimit, /^limit=2, remaining=0, reset=\d+$/);

  const limited = await hit();
  assertProblem(limited, 429, 'RATE_LIMITED');
  assert.equal(limited.body.type, 'https://api.bondfire.app/errors/rate-limited');
  assert.ok(Number.isInteger(limited.body.retryAfterSeconds));
  assert.ok(limited.body.retryAfterSeconds >= 1 && limited.body.retryAfterSeconds <= 60);
  assert.equal(limited.headers['retry-after'], String(limited.body.retryAfterSeconds));
  assert.match(limited.headers.ratelimit, /^limit=2, remaining=0, reset=\d+$/);
});

test('each key has its own counter', async () => {
  const app = appWith(rateLimit({ name: uniqueName('keys'), points: 1, durationSeconds: 60, key: byHeader }));
  assert.equal((await request(app).get('/test/limited').set('x-test-key', 'a')).status, 200);
  assert.equal((await request(app).get('/test/limited').set('x-test-key', 'b')).status, 200);
  assert.equal((await request(app).get('/test/limited').set('x-test-key', 'a')).status, 429);
  assert.equal((await request(app).get('/test/limited').set('x-test-key', 'b')).status, 429);
});

test('limits count by IP, by installation and by user', async () => {
  assert.equal(byIp({ ip: '203.0.113.7' }), '203.0.113.7');
  assert.equal(byInstallation({ get: (name) => (name === 'x-installation-id' ? 'install-1' : undefined) }), 'install-1');
  assert.equal(byUser({ auth: { userId: 'u1' } }), 'u1');
  assert.equal(byUser({}), undefined);

  const app = appWith(rateLimit({ name: uniqueName('ip'), points: 1, durationSeconds: 60, key: byIp }));
  assert.equal((await request(app).get('/test/limited')).status, 200);
  assert.equal((await request(app).get('/test/limited')).status, 429);
});

test('keys are hashed before they reach the store', async () => {
  const seen = [];
  const storeFactory = (limit) => {
    const real = new RateLimiterMemory({ keyPrefix: limit.name, points: limit.points, duration: limit.durationSeconds });
    return { consume: (key, points) => { seen.push(key); return real.consume(key, points); } };
  };
  const app = appWith(rateLimit({ name: uniqueName('hash'), points: 5, durationSeconds: 60, key: byHeader, storeFactory }));
  await request(app).get('/test/limited').set('x-test-key', 'someone@example.com');
  assert.deepEqual(seen, [sha256('someone@example.com')]);
  assert.ok(!seen[0].includes('example'));
});

test('a request without a usable key still counts, in a shared bucket', async () => {
  const app = appWith(rateLimit({ name: uniqueName('nokey'), points: 1, durationSeconds: 60, key: byHeader }));
  assert.equal((await request(app).get('/test/limited')).status, 200);
  assert.equal((await request(app).get('/test/limited')).status, 429);
});

test('when several limits apply, the tightest one is reported', async () => {
  const app = appWith(
    rateLimit({ name: uniqueName('wide'), points: 100, durationSeconds: 60, key: byHeader }),
    rateLimit({ name: uniqueName('narrow'), points: 3, durationSeconds: 60, key: byHeader }),
  );
  const res = await request(app).get('/test/limited').set('x-test-key', 'a');
  assert.equal(res.status, 200);
  assert.match(res.headers.ratelimit, /^limit=3, remaining=2, reset=\d+$/);
});

test('when the store fails the request is allowed and a warning is logged', async () => {
  const warnings = [];
  const failing = { consume: () => Promise.reject(new Error('mongo is down')) };
  const app = createApp({
    extend(application) {
      application.get(
        '/test/limited',
        (req, res, next) => { req.log = { warn: (...args) => warnings.push(args) }; next(); },
        rateLimit({ name: uniqueName('failopen'), points: 1, durationSeconds: 60, key: byHeader, storeFactory: () => failing }),
        (req, res) => res.json({ ok: true }),
      );
    },
  });
  for (let i = 0; i < 3; i += 1) assert.equal((await request(app).get('/test/limited')).status, 200);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0][1], /rate limiter store failed/);
  assert.equal(warnings[0][0].err.message, 'mongo is down');
  assert.equal(warnings[0][0].limiter.startsWith('test-failopen'), true);
});

test('a store that does not answer in time fails open too', async () => {
  const warnings = [];
  const hanging = { consume: () => new Promise(() => {}) };
  const app = createApp({
    extend(application) {
      application.get(
        '/test/limited',
        (req, res, next) => { req.log = { warn: (...args) => warnings.push(args) }; next(); },
        rateLimit({ name: uniqueName('hang'), points: 1, durationSeconds: 60, key: byHeader, storeFactory: () => hanging }),
        (req, res) => res.json({ ok: true }),
      );
    },
  });
  const res = await request(app).get('/test/limited');
  assert.equal(res.status, 200);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0].err.message, /timed out/);
});

test('Retry-After is at least one second even when the window is about to end', async () => {
  const rejecting = { consume: () => Promise.reject(Object.assign(new RateLimiterRes(), { remainingPoints: 0, msBeforeNext: 0 })) };
  const app = appWith(rateLimit({ name: uniqueName('clamp'), points: 5, durationSeconds: 60, key: byHeader, storeFactory: () => rejecting }));
  const res = await request(app).get('/test/limited');
  assertProblem(res, 429, 'RATE_LIMITED');
  assert.equal(res.headers['retry-after'], '1');
  assert.equal(res.headers.ratelimit, 'limit=5, remaining=0, reset=0');
});

test('the default store is in memory under test and MongoDB-backed when asked (whatever the connection state)', async () => {
  assert.ok(defaultStoreFactory({ name: uniqueName('mem'), points: 1, durationSeconds: 60 }) instanceof RateLimiterMemory);

  const name = uniqueName('mongo');
  const store = defaultStoreFactory({ name, points: 2, durationSeconds: 60 }, true);
  const subject = sha256('203.0.113.9');
  assert.equal((await store.consume(subject)).remainingPoints, 1);
  assert.equal((await store.consume(subject)).remainingPoints, 0);
  await assert.rejects(store.consume(subject), (rejection) => rejection instanceof RateLimiterRes && rejection.msBeforeNext > 0);

  // The counter lives in one shared collection under a hashed key, and expires by itself.
  const docs = await mongoose.connection.collection(COLLECTION).find({}).toArray();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].key, `${name}:${subject}`);
  assert.equal(docs[0].points, 3);
  assert.ok(docs[0].expire instanceof Date);
  // The store builds its indexes in the background, so give them a moment.
  const hasExpiryIndex = async () => (await mongoose.connection.collection(COLLECTION).indexes())
    .some((index) => index.key.expire !== undefined && index.expireAfterSeconds === 0);
  for (let i = 0; i < 50 && !(await hasExpiryIndex()); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(await hasExpiryIndex());
});

test('the MongoDB store works through the middleware (counters survive a new middleware instance)', async () => {
  const name = uniqueName('persist');
  // A new MongoDB store builds its index first, which on a busy machine can take longer than the normal
  // 2-second wait; past that the middleware lets the request through (by design), so wait longer here.
  const make = () => rateLimit({
    name, points: 1, durationSeconds: 60, key: byHeader, storeFactory: (limit) => defaultStoreFactory(limit, true), timeoutMs: 30000,
  });
  assert.equal((await request(appWith(make())).get('/test/limited').set('x-test-key', 'a')).status, 200);
  // A second instance (another server process) sees the same counter.
  assertProblem(await request(appWith(make())).get('/test/limited').set('x-test-key', 'a'), 429, 'RATE_LIMITED');
});

// ---------------------------------------------------------------------------
// On the real routes
// ---------------------------------------------------------------------------

test('POST /auth/token/refresh is limited per installation (429 with the spec headers)', async () => {
  const app = createApp();
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const attempts = LIMITS.refreshPerInstallation.points;
  for (let i = 0; i < attempts; i += 1) {
    const res = await request(app).post('/v1/auth/token/refresh').set(headers).send({ refreshToken: 'unknown' });
    assertProblem(res, 401, 'REFRESH_TOKEN_INVALID');
  }
  const limited = await request(app).post('/v1/auth/token/refresh').set(headers).send({ refreshToken: 'unknown' });
  assertProblem(limited, 429, 'RATE_LIMITED');
  assert.ok(limited.headers['retry-after']);
  assert.match(limited.headers.ratelimit, new RegExp(`^limit=${attempts}, remaining=0, reset=\\d+$`));

  // Another install on the same IP still gets through.
  const other = await request(app)
    .post('/v1/auth/token/refresh')
    .set({ ...CLIENT, 'X-Installation-Id': crypto.randomUUID() })
    .send({ refreshToken: 'unknown' });
  assertProblem(other, 401, 'REFRESH_TOKEN_INVALID');
});

test('only token refresh is rate limited: logout and the session routes have no 429 in the spec', async () => {
  assert.deepEqual(Object.keys(LIMITS).sort(), ['refreshPerInstallation', 'refreshPerIp']);
  assert.equal(LIMITS.refreshPerIp.points, 1000);
  assert.equal(LIMITS.refreshPerInstallation.points, 30);

  const app = createApp();
  const user = await signIn(await makeUser());
  for (let i = 0; i < 130; i += 1) {
    const res = await request(app).post('/v1/auth/logout').set(CLIENT);
    assert.equal(res.status, 204);
    assert.equal(res.headers.ratelimit, undefined);
  }
  for (let i = 0; i < 70; i += 1) {
    const res = await request(app).get('/v1/me/sessions').set(user.headers);
    assert.equal(res.status, 200);
    assert.equal(res.headers.ratelimit, undefined);
  }
});
