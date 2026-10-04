process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mongoose = require('mongoose');
const request = require('supertest');
const { config } = require('../src/config');
const { createApp } = require('../src/app');
const { ApiError } = require('../src/lib/problem');
const { createIdempotency, canonicalJson } = require('../src/middleware/idempotency');
const { decrypt } = require('../src/lib/secrets');
const repo = require('../src/modules/idempotency/repo');
const IdempotencyKey = require('../models/IdempotencyKey');
const db = require('./support/db');
const { assertProblem } = require('./support/api');

before(db.connect);
beforeEach(db.clear);
after(db.disconnect);

// None of this PR's operations lists the IdempotencyKey parameter, so the
// middleware is exercised on test-only routes (the `extend` hook).
const key = () => crypto.randomUUID();
const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
const withKey = (value) => ({ 'Idempotency-Key': value });

/**
 * An app with test routes behind an idempotency middleware.
 * `calls` counts how often each route's handler really ran.
 */
function buildApp(options) {
  const calls = { create: 0, other: 0, flaky: 0, limited: 0, conflict: 0, slow: 0, big: 0 };
  // Requests held inside /test/slow: each one waits until the test releases it.
  const held = [];
  const idempotency = createIdempotency(options);
  const app = createApp({
    extend(application) {
      // Who is calling: tests set x-test-user to act as a signed-in user.
      application.use('/test', (req, res, next) => {
        if (req.get('x-test-user')) req.auth = { userId: req.get('x-test-user'), sessionId: 's' };
        next();
      });
      application.post('/test/create', idempotency, (req, res) => {
        calls.create += 1;
        res.status(201).set('Location', `/things/${calls.create}`).set('Set-Cookie', 'sid=secret').json({ n: calls.create, echo: req.body });
      });
      application.post('/test/other', idempotency, (req, res) => {
        calls.other += 1;
        res.json({ n: calls.other });
      });
      application.delete('/test/things/:id', idempotency, (req, res) => {
        res.status(200).json({ deleted: req.params.id });
      });
      // Fails with a 500 the first time and works afterwards.
      application.post('/test/flaky', idempotency, (req, res, next) => {
        calls.flaky += 1;
        if (calls.flaky === 1) return next(new Error('boom'));
        return res.json({ n: calls.flaky });
      });
      // Rate limited by the handler the first time.
      application.post('/test/limited', idempotency, (req, res, next) => {
        calls.limited += 1;
        if (calls.limited === 1) {
          return next(new ApiError({ status: 429, code: 'SEND_LIMIT_REACHED', title: 'Send limit reached', retryAfterSeconds: 30 }));
        }
        return res.json({ n: calls.limited });
      });
      // A client error is a normal, repeatable outcome.
      application.post('/test/conflict', idempotency, (req, res, next) => {
        calls.conflict += 1;
        next(new ApiError({ status: 409, code: 'EMAIL_TAKEN', title: 'Email already registered' }));
      });
      application.post('/test/big', idempotency, (req, res) => {
        calls.big += 1;
        res.json({ n: calls.big, filler: 'x'.repeat(2000) });
      });
      // Holds the request until the test lets it go. With x-test-first-fails the first request answers 500.
      application.post('/test/slow', idempotency, async (req, res) => {
        calls.slow += 1;
        const n = calls.slow;
        await new Promise((resolve) => { held.push(resolve); });
        res.status(n === 1 && req.get('x-test-first-fails') ? 500 : 200).json({ n });
      });
      // A response that carries tokens.
      application.post('/test/token', idempotency, (req, res) => {
        res.json({ accessToken: 'secret-access-value-1234', refreshToken: 'secret-refresh-value-5678' });
      });
    },
  });
  /** Resolves once `count` requests are being held in /test/slow. */
  const waitUntilHeld = async (count) => {
    for (let i = 0; i < 200 && held.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(held.length, count, 'the request did not reach the handler');
  };
  return { app, calls, held, waitUntilHeld };
}

const idempotencyDocs = () => mongoose.connection.collection('idempotency_keys').find({}).toArray();

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

test('canonicalJson ignores key order but not values, types or array order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } }), canonicalJson({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: '1' }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({}));
  assert.equal(canonicalJson(undefined), 'null');
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('a repeat with the same key and body replays the first response without running the handler again', async () => {
  const { app, calls } = buildApp();
  const k = key();
  const first = await request(app).post('/test/create').set(withKey(k)).send({ email: 'a@example.com' });
  assert.equal(first.status, 201);
  assert.equal(first.headers['idempotent-replayed'], undefined);

  const again = await request(app).post('/test/create').set(withKey(k)).send({ email: 'a@example.com' });
  assert.equal(again.status, 201);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.headers.location, '/things/1');
  assert.equal(again.headers['content-type'], first.headers['content-type']);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.equal(calls.create, 1);
  // The replay is a new response: its own request id, and no cookies from the first one.
  assert.notEqual(again.headers['x-request-id'], first.headers['x-request-id']);
  assert.equal(again.headers['set-cookie'], undefined);
});

test('the body is compared by content, not by key order', async () => {
  const { app, calls } = buildApp();
  const k = key();
  await request(app).post('/test/create').set(withKey(k)).send({ a: 1, b: { c: 2, d: 3 } });
  const again = await request(app).post('/test/create').set(withKey(k)).send({ b: { d: 3, c: 2 }, a: 1 });
  assert.equal(again.status, 201);
  assert.equal(calls.create, 1);
});

test('the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED and runs nothing', async () => {
  const { app, calls } = buildApp();
  const k = key();
  await request(app).post('/test/create').set(withKey(k)).send({ email: 'a@example.com' });
  const res = await request(app).post('/test/create').set(withKey(k)).send({ email: 'b@example.com' });
  assertProblem(res, 422, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(res.body.type, 'https://api.bondfire.app/errors/idempotency-key-reused');
  assert.equal(calls.create, 1);
  // A different query string is a different request too.
  assertProblem(await request(app).post('/test/create?x=1').set(withKey(k)).send({ email: 'a@example.com' }), 422, 'IDEMPOTENCY_KEY_REUSED');
});

test('a different key, no key, or a different route or caller each run for real', async () => {
  const { app, calls } = buildApp();
  const k = key();
  const post = (path, headers = {}) => request(app).post(path).set(headers).send({ a: 1 });

  await post('/test/create', withKey(k));
  await post('/test/create', withKey(key()));
  assert.equal(calls.create, 2);

  await post('/test/create');
  await post('/test/create');
  assert.equal(calls.create, 4);

  // Same key, other route.
  await post('/test/other', withKey(k));
  assert.equal(calls.other, 1);

  // Same key, other user or other install: separate scopes.
  await post('/test/create', { ...withKey(k), 'x-test-user': 'user-a' });
  await post('/test/create', { ...withKey(k), 'x-test-user': 'user-b' });
  assert.equal(calls.create, 6);
  await post('/test/create', { ...withKey(k), 'x-test-user': 'user-a' });
  assert.equal(calls.create, 6);
  await post('/test/create', { ...withKey(k), 'X-Installation-Id': key() });
  await post('/test/create', { ...withKey(k), 'X-Installation-Id': key() });
  assert.equal(calls.create, 8);
});

test('the key is scoped to the exact path: the same key on another resource runs again', async () => {
  const { app } = buildApp();
  const k = key();
  const one = await request(app).delete('/test/things/1').set(withKey(k));
  const two = await request(app).delete('/test/things/2').set(withKey(k));
  assert.deepEqual(one.body, { deleted: '1' });
  assert.deepEqual(two.body, { deleted: '2' });
  const again = await request(app).delete('/test/things/1').set(withKey(k));
  assert.deepEqual(again.body, { deleted: '1' });
  assert.equal(again.headers['idempotent-replayed'], 'true');
});

// ---------------------------------------------------------------------------
// Failures and concurrency
// ---------------------------------------------------------------------------

test('a server error is not stored: retrying with the same key runs the action again', async () => {
  const { app, calls } = buildApp();
  const k = key();
  const failed = await request(app).post('/test/flaky').set(withKey(k)).send({});
  assertProblem(failed, 500, 'INTERNAL_ERROR');
  const retried = await request(app).post('/test/flaky').set(withKey(k)).send({});
  assert.equal(retried.status, 200);
  assert.equal(retried.headers['idempotent-replayed'], undefined);
  assert.equal(calls.flaky, 2);
  // And now the success is the stored answer.
  const replayed = await request(app).post('/test/flaky').set(withKey(k)).send({});
  assert.equal(replayed.headers['idempotent-replayed'], 'true');
  assert.equal(calls.flaky, 2);
});

test('a 429 is not stored either, so the client can retry after waiting', async () => {
  const { app, calls } = buildApp();
  const k = key();
  assertProblem(await request(app).post('/test/limited').set(withKey(k)).send({}), 429, 'SEND_LIMIT_REACHED');
  const retried = await request(app).post('/test/limited').set(withKey(k)).send({});
  assert.equal(retried.status, 200);
  assert.equal(calls.limited, 2);
});

test('a client error is stored and replayed with its problem body', async () => {
  const { app, calls } = buildApp();
  const k = key();
  const first = await request(app).post('/test/conflict').set(withKey(k)).send({});
  assertProblem(first, 409, 'EMAIL_TAKEN');
  const again = await request(app).post('/test/conflict').set(withKey(k)).send({});
  assert.equal(again.status, 409);
  assert.match(again.headers['content-type'], /^application\/problem\+json/);
  assert.equal(again.body.code, 'EMAIL_TAKEN');
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.equal(calls.conflict, 1);
});

test('a repeat while the first request is still running is 409 IDEMPOTENCY_IN_PROGRESS, then it replays', async () => {
  const { app, calls, held, waitUntilHeld } = buildApp();
  const server = http.createServer(app).listen(0);
  try {
    const k = key();
    const first = request(server).post('/test/slow').set(withKey(k)).send({ a: 1 }).then((res) => res);
    await waitUntilHeld(1);

    const during = await request(server).post('/test/slow').set(withKey(k)).send({ a: 1 });
    assertProblem(during, 409, 'IDEMPOTENCY_IN_PROGRESS');
    assert.equal(during.body.type, 'https://api.bondfire.app/errors/idempotency-in-progress');
    // A different body is reported as reuse, not as "in progress".
    assertProblem(await request(server).post('/test/slow').set(withKey(k)).send({ a: 2 }), 422, 'IDEMPOTENCY_KEY_REUSED');

    held[0]();
    const firstRes = await first;
    assert.equal(firstRes.status, 200);

    const after = await request(server).post('/test/slow').set(withKey(k)).send({ a: 1 });
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, firstRes.body);
    assert.equal(after.headers['idempotent-replayed'], 'true');
    assert.equal(calls.slow, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('simultaneous identical requests run the handler exactly once', async () => {
  const { app, calls } = buildApp();
  const server = http.createServer(app).listen(0);
  try {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(server).post('/test/create').set(withKey(k)).send({ a: 1 })),
    );
    assert.equal(calls.create, 1);
    for (const res of results) assert.ok([201, 409].includes(res.status), `unexpected ${res.status}`);
    assert.ok(results.some((res) => res.status === 201));
    for (const res of results.filter((r) => r.status === 409)) assert.equal(res.body.code, 'IDEMPOTENCY_IN_PROGRESS');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a first request that never finished is taken over once it is stale', async () => {
  const { app, calls, held, waitUntilHeld } = buildApp({ staleAfterMs: 50 });
  const server = http.createServer(app).listen(0);
  try {
    const k = key();
    const abandoned = request(server).post('/test/slow').set(withKey(k)).send({}).then((res) => res);
    await waitUntilHeld(1);
    await new Promise((resolve) => setTimeout(resolve, 120));

    // The second request is not blocked: it takes the key over and runs.
    const second = request(server).post('/test/slow').set(withKey(k)).send({}).then((res) => res);
    await waitUntilHeld(2);
    assert.equal(calls.slow, 2);
    held[1]();
    const secondRes = await second;
    assert.equal(secondRes.status, 200);
    assert.deepEqual(secondRes.body, { n: 2 });

    // The abandoned request finally finishes: it answers its own caller, and the stored answer stays the second one.
    held[0]();
    const abandonedRes = await abandoned;
    assert.equal(abandonedRes.status, 200);
    assert.deepEqual(abandonedRes.body, { n: 1 });
    const replay = await request(server).post('/test/slow').set(withKey(k)).send({});
    assert.deepEqual(replay.body, { n: 2 });
    assert.equal(replay.headers['idempotent-replayed'], 'true');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an abandoned request that finishes after a takeover does not overwrite the new request's record", async () => {
  const { app, held, waitUntilHeld } = buildApp({ staleAfterMs: 50 });
  const server = http.createServer(app).listen(0);
  try {
    const k = key();
    const abandoned = request(server).post('/test/slow').set(withKey(k)).send({}).then((res) => res);
    await waitUntilHeld(1);
    const [original] = await idempotencyDocs();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = request(server).post('/test/slow').set(withKey(k)).send({}).then((res) => res);
    await waitUntilHeld(2);
    const [takenOver] = await idempotencyDocs();
    assert.notEqual(takenOver.owner, original.owner);

    // The abandoned request answers its own caller, but it no longer owns the record.
    held[0]();
    assert.deepEqual((await abandoned).body, { n: 1 });
    const [afterLate] = await idempotencyDocs();
    assert.equal(afterLate.state, 'pending');
    assert.equal(afterLate.owner, takenOver.owner);

    held[1]();
    assert.deepEqual((await second).body, { n: 2 });
    const replay = await request(server).post('/test/slow').set(withKey(k)).send({});
    assert.deepEqual(replay.body, { n: 2 });
    assert.equal(replay.headers['idempotent-replayed'], 'true');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an abandoned request that fails after a takeover does not delete the new request's record", async () => {
  const { app, held, waitUntilHeld } = buildApp({ staleAfterMs: 50 });
  const server = http.createServer(app).listen(0);
  try {
    const k = key();
    const abandoned = request(server).post('/test/slow').set(withKey(k)).set('x-test-first-fails', '1').send({}).then((res) => res);
    await waitUntilHeld(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = request(server).post('/test/slow').set(withKey(k)).send({}).then((res) => res);
    await waitUntilHeld(2);
    const [takenOver] = await idempotencyDocs();

    held[0]();
    assert.equal((await abandoned).status, 500);
    const docs = await idempotencyDocs();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].state, 'pending');
    assert.equal(docs[0].owner, takenOver.owner);

    held[1]();
    assert.equal((await second).status, 200);
    assert.equal((await idempotencyDocs())[0].state, 'done');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('repo: only the owner of a pending record can complete or release it', async () => {
  const base = { lookup: sha256Hex('repo-lookup'), requestHash: sha256Hex('body') };
  assert.equal(await repo.insertPending({ ...base, owner: 'owner-a', createdAt: new Date() }), true);
  assert.equal(await repo.insertPending({ ...base, owner: 'owner-b', createdAt: new Date() }), false);

  await repo.complete({ ...base, owner: 'owner-b', status: 200, headers: {}, body: 'x' });
  await repo.release({ lookup: base.lookup, owner: 'owner-b' });
  assert.equal((await repo.find(base.lookup)).state, 'pending');

  // A record that is not stale yet cannot be taken over.
  assert.equal(await repo.takeOverStale({ lookup: base.lookup, staleBefore: new Date(Date.now() - 60000), owner: 'owner-c', now: new Date() }), false);
  // A takeover hands the record to a new owner; the old one is locked out.
  assert.equal(await repo.takeOverStale({ lookup: base.lookup, staleBefore: new Date(Date.now() + 1000), owner: 'owner-b', now: new Date() }), true);
  await repo.complete({ ...base, owner: 'owner-a', status: 200, headers: {}, body: 'x' });
  await repo.release({ lookup: base.lookup, owner: 'owner-a' });
  assert.equal((await repo.find(base.lookup)).state, 'pending');

  await repo.complete({ ...base, owner: 'owner-b', status: 201, headers: {}, body: 'stored' });
  const done = await repo.find(base.lookup);
  assert.equal(done.state, 'done');
  assert.equal(done.status, 201);
  // Once done, nobody can release it.
  await repo.release({ lookup: base.lookup, owner: 'owner-b' });
  assert.equal((await repo.find(base.lookup)).state, 'done');
});

test('a response above the size limit is not stored', async () => {
  const { app, calls } = buildApp({ maxBodyBytes: 500 });
  const k = key();
  assert.equal((await request(app).post('/test/big').set(withKey(k)).send({})).status, 200);
  assert.equal((await request(app).post('/test/big').set(withKey(k)).send({})).status, 200);
  assert.equal(calls.big, 2);
  assert.equal((await idempotencyDocs()).length, 0);
});

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

test('records are keyed by a hash, hold only safe headers, and expire after 24 hours', async () => {
  const { app } = buildApp();
  const k = key();
  await request(app).post('/test/create').set(withKey(k)).set('x-test-user', 'user-a').send({ email: 'a@example.com' });

  const [doc] = await idempotencyDocs();
  assert.equal(doc.state, 'done');
  assert.equal(doc.status, 201);
  assert.match(doc.lookup, /^[0-9a-f]{64}$/);
  assert.match(doc.requestHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(doc.headers).sort(), ['content-type', 'etag', 'location']);
  assert.ok(!JSON.stringify(doc).includes(k));
  assert.ok(!JSON.stringify(doc).includes('user-a'));
  assert.ok(!JSON.stringify(doc).includes('secret'));

  const indexes = await IdempotencyKey.collection.indexes();
  assert.ok(indexes.some((index) => index.key.createdAt === 1 && index.expireAfterSeconds === 24 * 60 * 60));
  assert.ok(indexes.some((index) => index.key.lookup === 1 && index.unique === true));
});

test('the stored response body is encrypted: no token or body text is readable in the database', async () => {
  const { app } = buildApp();
  const k = key();
  const first = await request(app).post('/test/token').set(withKey(k)).send({});
  assert.equal(first.body.accessToken, 'secret-access-value-1234');
  await request(app).post('/test/create').set(withKey(key())).send({ email: 'private-address@example.com' });

  const raw = JSON.stringify(await idempotencyDocs());
  for (const plaintext of ['secret-access-value', 'secret-refresh-value', 'accessToken', 'refreshToken', 'private-address', 'echo']) {
    assert.ok(!raw.includes(plaintext), `"${plaintext}" is stored in plaintext`);
  }

  // It is still the same answer on replay, and only decrypts for its own record.
  const replay = await request(app).post('/test/token').set(withKey(k)).send({});
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.headers['idempotent-replayed'], 'true');

  const doc = await IdempotencyKey.findOne({ status: 200 }).lean();
  assert.deepEqual(JSON.parse(decrypt(doc.body, { key: config.tokenEncKey, aad: doc.lookup })), first.body);
  assert.throws(() => decrypt(doc.body, { key: config.tokenEncKey, aad: sha256Hex('another record') }));
});

test('a stored body that cannot be decrypted is never answered with a repeat of the action', async () => {
  const { app, calls } = buildApp();
  const k = key();
  await request(app).post('/test/create').set(withKey(k)).send({ a: 1 });
  await IdempotencyKey.updateOne({}, { $set: { body: 'not-a-valid-ciphertext-not-a-valid-ciphertext-xx' } });

  const res = await request(app).post('/test/create').set(withKey(k)).send({ a: 1 });
  assertProblem(res, 500, 'INTERNAL_ERROR');
  assert.equal(calls.create, 1);
});
