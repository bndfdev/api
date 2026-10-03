process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const mongoose = require('mongoose');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { config, loadConfig } = require('../src/config');
const { ApiError } = require('../src/lib/problem');
const { sha256 } = require('../src/lib/secrets');
const { createTokens } = require('../src/lib/tokens');
const { createSessionService } = require('../src/modules/sessions/service');
const User = require('../models/User');
const Session = require('../models/Session');
const RefreshToken = require('../models/RefreshToken');
const RefreshGrace = require('../models/RefreshGrace');
const db = require('./support/db');

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

// A fake clock: tests move time by hand instead of sleeping.
const clock = { t: 0, now: () => clock.t, advance(ms) { clock.t += ms; } };
const service = createSessionService({ now: clock.now });
const tokens = createTokens({ jwt: config.jwt, now: clock.now });

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
// `format` is not checked (the unknown-format warning is silenced); timestamps are matched by regex below.
const ajv = new Ajv2020({ strict: false, logger: false });
const matchesSpec = (name, value) => ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value);

const DEVICE = { platform: 'ios', model: 'iPhone 16', appVersion: '1.4.0+42' };
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

before(db.connect);
beforeEach(async () => {
  await db.clear();
  clock.t = Date.now();
});
after(db.disconnect);

async function makeUser(extra = {}) {
  const id = crypto.randomUUID();
  return User.create({ email: `${id}@example.com`, password: 'x', ...extra });
}

/** Sign a user in on a fresh install; returns everything a test needs. */
async function signIn(user, { signInMethod = 'password', device = DEVICE } = {}) {
  const installationId = crypto.randomUUID();
  const { tokens: pair, session } = await service.createSession({
    userId: String(user._id), signInMethod, device, installationId,
  });
  return { user, installationId, pair, session };
}

async function assertRejects(promise, status, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

const rawDocs = (collection) => mongoose.connection.collection(collection).find({}).toArray();

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

test('createSession returns a TokenPair and SessionInfo that match the spec', async () => {
  const user = await makeUser();
  const { pair, session } = await signIn(user);

  assert.equal(matchesSpec('TokenPair', pair), true, JSON.stringify(ajv.errors));
  assert.equal(matchesSpec('SessionInfo', session), true, JSON.stringify(ajv.errors));
  assert.deepEqual(Object.keys(pair).sort(), ['accessToken', 'accessTokenExpiresAt', 'refreshToken', 'refreshTokenExpiresAt', 'tokenType']);
  assert.equal(pair.tokenType, 'Bearer');
  assert.match(pair.accessTokenExpiresAt, ISO_SECONDS);
  assert.match(pair.refreshTokenExpiresAt, ISO_SECONDS);

  const now = Math.floor(clock.t / SECOND) * SECOND;
  assert.equal(Date.parse(pair.accessTokenExpiresAt), now + 900 * SECOND);
  assert.equal(Date.parse(pair.refreshTokenExpiresAt), now + 60 * DAY);

  assert.equal(session.current, true);
  assert.equal(session.signInMethod, 'password');
  assert.deepEqual(session.device, DEVICE);
  assert.match(session.createdAt, ISO_SECONDS);
  assert.equal(session.createdAt, session.lastActiveAt);
  assert.match(session.id, /^[0-9a-f]{24}$/);
});

test('the access token identifies the user and the session', async () => {
  const user = await makeUser();
  const { pair, session } = await signIn(user);
  assert.deepEqual(await tokens.verifyAccessToken(pair.accessToken), { userId: String(user._id), sessionId: session.id });
});

test('createSession stores the session and only the hash of the refresh token', async () => {
  const user = await makeUser();
  const { pair, session, installationId } = await signIn(user, { signInMethod: 'guest' });

  const [stored] = await rawDocs('sessions');
  assert.equal(String(stored._id), session.id);
  assert.equal(String(stored.userId), String(user._id));
  assert.equal(stored.signInMethod, 'guest');
  assert.equal(stored.installationId, installationId);
  assert.equal(stored.revokedAt, null);
  assert.equal(stored.expiresAt.getTime(), Math.floor(clock.t / SECOND) * SECOND + 60 * DAY);

  const refreshDocs = await rawDocs('refresh_tokens');
  assert.equal(refreshDocs.length, 1);
  assert.equal(refreshDocs[0].tokenHash, sha256(pair.refreshToken));
  assert.equal(refreshDocs[0].usedAt, null);
  assert.equal(String(refreshDocs[0].sessionId), session.id);
  assert.ok(!JSON.stringify(refreshDocs).includes(pair.refreshToken));
});

test('the TTL and unique indexes exist', async () => {
  const sessionIndexes = await Session.collection.indexes();
  const tokenIndexes = await RefreshToken.collection.indexes();
  assert.ok(sessionIndexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
  assert.ok(sessionIndexes.some((i) => i.key.userId === 1 && i.key.revokedAt === 1));
  assert.ok(tokenIndexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
  assert.ok(tokenIndexes.some((i) => i.key.tokenHash === 1 && i.unique));
  assert.ok(tokenIndexes.some((i) => i.key.sessionId === 1));
  const graceIndexes = await RefreshGrace.collection.indexes();
  assert.ok(graceIndexes.some((i) => i.key.graceUntil === 1 && i.expireAfterSeconds === 0));
  assert.ok(graceIndexes.some((i) => i.key.tokenHash === 1 && i.unique));
  assert.ok(graceIndexes.some((i) => i.key.sessionId === 1));
});

// ---------------------------------------------------------------------------
// refresh: rotation
// ---------------------------------------------------------------------------

test('refresh rotates: a new pair, the old token retired, the session touched', async () => {
  const user = await makeUser();
  const { pair, installationId, session } = await signIn(user);
  clock.advance(5 * 60 * SECOND);

  const next = await service.refresh({ refreshToken: pair.refreshToken, installationId });
  assert.equal(matchesSpec('TokenPair', next), true, JSON.stringify(ajv.errors));
  assert.notEqual(next.refreshToken, pair.refreshToken);
  assert.notEqual(next.accessToken, pair.accessToken);
  assert.deepEqual(await tokens.verifyAccessToken(next.accessToken), { userId: String(user._id), sessionId: session.id });

  const now = Math.floor(clock.t / SECOND) * SECOND;
  assert.equal(Date.parse(next.accessTokenExpiresAt), now + 900 * SECOND);
  assert.equal(Date.parse(next.refreshTokenExpiresAt), now + 60 * DAY);

  const docs = await rawDocs('refresh_tokens');
  assert.equal(docs.length, 2);
  const oldDoc = docs.find((d) => d.tokenHash === sha256(pair.refreshToken));
  const newDoc = docs.find((d) => d.tokenHash === sha256(next.refreshToken));
  assert.ok(oldDoc.usedAt);
  assert.equal(oldDoc.replacedByHash, newDoc.tokenHash);
  // A used token is kept for 14 days (reuse detection); the new one for the full lifetime.
  assert.equal(oldDoc.expiresAt.getTime(), now + 14 * DAY);
  assert.equal(newDoc.usedAt, null);
  assert.equal(newDoc.expiresAt.getTime(), now + 60 * DAY);
  assert.equal(String(newDoc.sessionId), session.id);

  const [stored] = await rawDocs('sessions');
  assert.equal(stored.lastActiveAt.getTime(), now);
  assert.equal(stored.expiresAt.getTime(), now + 60 * DAY);
  assert.equal(stored.revokedAt, null);
});

test('the new refresh token can be rotated again, and so on', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  let current = pair;
  for (let i = 0; i < 4; i += 1) {
    clock.advance(10 * 60 * SECOND);
    current = await service.refresh({ refreshToken: current.refreshToken, installationId });
  }
  assert.equal((await rawDocs('refresh_tokens')).length, 5);
});

test('no raw token or access token is ever stored', async () => {
  const user = await makeUser();
  const { pair, installationId } = await signIn(user);
  const second = await service.refresh({ refreshToken: pair.refreshToken, installationId });
  clock.advance(60 * SECOND);
  const third = await service.refresh({ refreshToken: second.refreshToken, installationId });

  const scan = async () => JSON.stringify([
    ...(await rawDocs('refresh_tokens')),
    ...(await rawDocs('sessions')),
    ...(await rawDocs('refresh_grace')),
  ]);
  // The grace records are in place while they are scanned.
  assert.equal((await rawDocs('refresh_grace')).length, 2);
  let stored = await scan();
  for (const issued of [pair, second, third]) {
    assert.ok(!stored.includes(issued.refreshToken), 'raw refresh token stored');
    assert.ok(!stored.includes(issued.accessToken), 'access token stored');
  }
  await service.refresh({ refreshToken: pair.refreshToken, installationId }).catch(() => {});
  stored = await scan();
  for (const issued of [pair, second, third]) {
    assert.ok(!stored.includes(issued.refreshToken), 'raw refresh token stored');
    assert.ok(!stored.includes(issued.accessToken), 'access token stored');
  }
});

// ---------------------------------------------------------------------------
// refresh: grace window and reuse detection
// ---------------------------------------------------------------------------

test('the same used token within the grace window gets the identical pair, without rotating again', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  const first = await service.refresh({ refreshToken: pair.refreshToken, installationId });
  clock.advance(10 * SECOND);
  const again = await service.refresh({ refreshToken: pair.refreshToken, installationId });
  assert.deepEqual(again, first);
  assert.equal((await rawDocs('refresh_tokens')).length, 2);
});

test('the grace window includes its last second and ends after it', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  const first = await service.refresh({ refreshToken: pair.refreshToken, installationId });
  clock.advance(30 * SECOND);
  assert.deepEqual(await service.refresh({ refreshToken: pair.refreshToken, installationId }), first);
  clock.advance(SECOND);
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'REFRESH_TOKEN_REUSED');
});

test('an old token after the grace window is REUSED and revokes the whole session', async () => {
  const { pair, installationId, session } = await signIn(await makeUser());
  const next = await service.refresh({ refreshToken: pair.refreshToken, installationId });
  clock.advance(31 * SECOND);

  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'REFRESH_TOKEN_REUSED');

  const [stored] = await rawDocs('sessions');
  assert.equal(String(stored._id), session.id);
  assert.ok(stored.revokedAt);
  assert.equal(stored.revokeReason, 'refresh_token_reused');
  // The legitimate successor is dead too, and says why.
  await assertRejects(service.refresh({ refreshToken: next.refreshToken, installationId }), 401, 'SESSION_REVOKED');
  assert.equal((await service.listSessions({ userId: String(stored.userId), currentSessionId: session.id })).data.length, 0);
});

test('a used token from a different installation is REUSED, even inside the grace window', async () => {
  const { pair, installationId, session } = await signIn(await makeUser());
  const next = await service.refresh({ refreshToken: pair.refreshToken, installationId });

  await assertRejects(
    service.refresh({ refreshToken: pair.refreshToken, installationId: crypto.randomUUID() }),
    401, 'REFRESH_TOKEN_REUSED',
  );
  const [stored] = await rawDocs('sessions');
  assert.equal(String(stored._id), session.id);
  assert.equal(stored.revokeReason, 'refresh_token_reused');
  await assertRejects(service.refresh({ refreshToken: next.refreshToken, installationId }), 401, 'SESSION_REVOKED');
});

test('an unused token from a different installation is refused without revoking the session', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  await assertRejects(
    service.refresh({ refreshToken: pair.refreshToken, installationId: crypto.randomUUID() }),
    401, 'REFRESH_TOKEN_INVALID',
  );
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId: undefined }), 401, 'REFRESH_TOKEN_INVALID');
  const [stored] = await rawDocs('sessions');
  assert.equal(stored.revokedAt, null);
  assert.equal((await rawDocs('refresh_tokens'))[0].usedAt, null);
  // The real device is unaffected.
  const next = await service.refresh({ refreshToken: pair.refreshToken, installationId });
  assert.equal(matchesSpec('TokenPair', next), true);
});

test('parallel refreshes rotate exactly once and all callers get the same pair', async () => {
  for (let round = 0; round < 5; round += 1) {
    const { pair, installationId } = await signIn(await makeUser());
    const before = await RefreshToken.countDocuments();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => service.refresh({ refreshToken: pair.refreshToken, installationId })),
    );
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.notEqual(results[0].refreshToken, pair.refreshToken);
    // One new token on top of the original; the losers' candidates were dropped.
    assert.equal(await RefreshToken.countDocuments() - before, 1);
    const { _id: sessionId } = await Session.findOne({ installationId });
    assert.equal(await RefreshToken.countDocuments({ sessionId, usedAt: { $ne: null } }), 1);
    assert.equal(await RefreshGrace.countDocuments({ sessionId }), 1);
    // The one successor is live and rotates normally.
    await service.refresh({ refreshToken: results[0].refreshToken, installationId });
  }
});

test('unreadable grace data fails closed: reuse is detected', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  await service.refresh({ refreshToken: pair.refreshToken, installationId });
  await RefreshGrace.updateOne({ tokenHash: sha256(pair.refreshToken) }, { $set: { cipher: 'AAAA' } });
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'REFRESH_TOKEN_REUSED');
});

test('grace data copied onto another token does not decrypt', async () => {
  const a = await signIn(await makeUser());
  const b = await signIn(await makeUser());
  await service.refresh({ refreshToken: a.pair.refreshToken, installationId: a.installationId });
  await service.refresh({ refreshToken: b.pair.refreshToken, installationId: b.installationId });
  const donor = await RefreshGrace.findOne({ tokenHash: sha256(a.pair.refreshToken) }).lean();
  await RefreshGrace.updateOne({ tokenHash: sha256(b.pair.refreshToken) }, { $set: { cipher: donor.cipher } });
  await assertRejects(
    service.refresh({ refreshToken: b.pair.refreshToken, installationId: b.installationId }),
    401, 'REFRESH_TOKEN_REUSED',
  );
});

test('the grace pair lives in its own record, keyed by the used token, not on the token', async () => {
  const { pair, installationId, session } = await signIn(await makeUser());
  const next = await service.refresh({ refreshToken: pair.refreshToken, installationId });

  const records = await rawDocs('refresh_grace');
  assert.equal(records.length, 1);
  const [record] = records;
  const now = Math.floor(clock.t / SECOND) * SECOND;
  assert.equal(record.tokenHash, sha256(pair.refreshToken));
  assert.equal(String(record.sessionId), session.id);
  assert.equal(record.graceUntil.getTime(), now + 30 * SECOND);
  assert.equal(typeof record.cipher, 'string');
  assert.ok(!record.cipher.includes(next.refreshToken));
  for (const doc of await rawDocs('refresh_tokens')) {
    assert.ok(!('graceCipher' in doc) && !('graceUntil' in doc));
  }
});

test('past graceUntil the record is not used even while it still exists, and the reuse removes it', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  await service.refresh({ refreshToken: pair.refreshToken, installationId });
  clock.advance(31 * SECOND);
  // The TTL monitor works on real time, so the record is still there.
  assert.equal(await RefreshGrace.countDocuments(), 1);
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'REFRESH_TOKEN_REUSED');
  assert.equal(await RefreshGrace.countDocuments(), 0);
});

test('MongoDB removes a grace record once graceUntil has passed', { timeout: 45000 }, async () => {
  // Real clock and a 5 s window; the test database runs its TTL monitor every second. (With a 1 s window a
  // busy machine sometimes deleted the record before the first count below.)
  const fast = createSessionService({ config: loadConfig({ NODE_ENV: 'test', REFRESH_GRACE_SECONDS: '5' }) });
  const user = await makeUser();
  const installationId = crypto.randomUUID();
  const { tokens: pair } = await fast.createSession({
    userId: String(user._id), signInMethod: 'password', device: DEVICE, installationId,
  });
  await fast.refresh({ refreshToken: pair.refreshToken, installationId });
  assert.equal(await RefreshGrace.countDocuments(), 1);

  const deadline = Date.now() + 30000;
  while ((await RefreshGrace.countDocuments()) > 0 && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  assert.equal(await RefreshGrace.countDocuments(), 0);
  await assertRejects(fast.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'REFRESH_TOKEN_REUSED');
});

test('a used token is kept for 14 days: reuse is detected until then, unknown after', async () => {
  const user = await makeUser();
  const a = await signIn(user);
  const b = await signIn(user);
  await service.refresh({ refreshToken: a.pair.refreshToken, installationId: a.installationId });
  await service.refresh({ refreshToken: b.pair.refreshToken, installationId: b.installationId });

  clock.advance(14 * DAY - SECOND);
  await assertRejects(service.refresh({ refreshToken: a.pair.refreshToken, installationId: a.installationId }), 401, 'REFRESH_TOKEN_REUSED');
  clock.advance(SECOND);
  await assertRejects(service.refresh({ refreshToken: b.pair.refreshToken, installationId: b.installationId }), 401, 'REFRESH_TOKEN_INVALID');
  assert.equal((await Session.findById(b.session.id).lean()).revokedAt, null);
});

test('reuse and installation mismatches are logged with ids only', async () => {
  const calls = [];
  const logged = createSessionService({ now: clock.now, logger: { warn: (fields, message) => calls.push({ fields, message }) } });
  const user = await makeUser();
  const installationId = crypto.randomUUID();
  const { tokens: pair, session } = await logged.createSession({
    userId: String(user._id), signInMethod: 'password', device: DEVICE, installationId,
  });
  const expectedFields = { userId: String(user._id), sessionId: session.id };

  // An unused token from another install.
  await assertRejects(logged.refresh({ refreshToken: pair.refreshToken, installationId: crypto.randomUUID() }), 401, 'REFRESH_TOKEN_INVALID');
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /installation mismatch/);
  assert.deepEqual(calls[0].fields, expectedFields);

  // Reuse after the grace window.
  const next = await logged.refresh({ refreshToken: pair.refreshToken, installationId });
  clock.advance(31 * SECOND);
  await assertRejects(logged.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'REFRESH_TOKEN_REUSED');
  assert.equal(calls.length, 2);
  assert.match(calls[1].message, /reused.*session revoked/);
  assert.deepEqual(calls[1].fields, expectedFields);

  // Nothing secret in either entry.
  const text = JSON.stringify(calls);
  for (const secret of [pair.refreshToken, pair.accessToken, next.refreshToken, next.accessToken, installationId]) {
    assert.ok(!text.includes(secret));
  }
});

test('a used token from another install is logged and revokes the session', async () => {
  const calls = [];
  const logged = createSessionService({ now: clock.now, logger: { warn: (fields, message) => calls.push({ fields, message }) } });
  const user = await makeUser();
  const installationId = crypto.randomUUID();
  const { tokens: pair, session } = await logged.createSession({
    userId: String(user._id), signInMethod: 'password', device: DEVICE, installationId,
  });
  await logged.refresh({ refreshToken: pair.refreshToken, installationId });
  await assertRejects(logged.refresh({ refreshToken: pair.refreshToken, installationId: crypto.randomUUID() }), 401, 'REFRESH_TOKEN_REUSED');
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /another install: session revoked/);
  assert.deepEqual(calls[0].fields, { userId: String(user._id), sessionId: session.id });
});

// ---------------------------------------------------------------------------
// refresh: other refusals
// ---------------------------------------------------------------------------

test('unknown, empty and non-string refresh tokens are REFRESH_TOKEN_INVALID', async () => {
  const { installationId } = await signIn(await makeUser());
  for (const refreshToken of [crypto.randomBytes(32).toString('base64url'), '', undefined, null, 42, {}]) {
    await assertRejects(service.refresh({ refreshToken, installationId }), 401, 'REFRESH_TOKEN_INVALID');
  }
});

test('a refresh token is valid until its expiry and REFRESH_TOKEN_INVALID after', async () => {
  const user = await makeUser();
  const a = await signIn(user);
  const b = await signIn(user);
  clock.advance(60 * DAY - SECOND);
  assert.ok(await service.refresh({ refreshToken: a.pair.refreshToken, installationId: a.installationId }));
  clock.advance(SECOND);
  await assertRejects(service.refresh({ refreshToken: b.pair.refreshToken, installationId: b.installationId }), 401, 'REFRESH_TOKEN_INVALID');
});

test('a revoked session is SESSION_REVOKED', async () => {
  const { user, pair, installationId, session } = await signIn(await makeUser());
  await service.revokeSession({ userId: String(user._id), sessionId: session.id });
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'SESSION_REVOKED');
});

test('a token whose session is gone is REFRESH_TOKEN_INVALID', async () => {
  const { pair, installationId, session } = await signIn(await makeUser());
  await Session.deleteOne({ _id: session.id });
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'REFRESH_TOKEN_INVALID');
});

test('a blocked user is ACCOUNT_SUSPENDED and the token is not consumed', async () => {
  const { user, pair, installationId } = await signIn(await makeUser());

  await User.updateOne({ _id: user._id }, { isBlocked: true, blockedUntil: null });
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 403, 'ACCOUNT_SUSPENDED');

  await User.updateOne({ _id: user._id }, { isBlocked: true, blockedUntil: new Date(clock.t + 60 * SECOND) });
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 403, 'ACCOUNT_SUSPENDED');
  assert.equal((await rawDocs('refresh_tokens'))[0].usedAt, null);

  // The block ran out: refreshing works again.
  clock.advance(61 * SECOND);
  const next = await service.refresh({ refreshToken: pair.refreshToken, installationId });
  assert.equal(matchesSpec('TokenPair', next), true);
});

test('a user whose block was lifted can refresh; isBlocked false ignores blockedUntil', async () => {
  const { user, pair, installationId } = await signIn(await makeUser());
  await User.updateOne({ _id: user._id }, { isBlocked: false, blockedUntil: new Date(clock.t + DAY) });
  assert.ok(await service.refresh({ refreshToken: pair.refreshToken, installationId }));
});

test('a deleted user is REFRESH_TOKEN_INVALID', async () => {
  const { user, pair, installationId } = await signIn(await makeUser());
  await User.deleteOne({ _id: user._id });
  await assertRejects(service.refresh({ refreshToken: pair.refreshToken, installationId }), 401, 'REFRESH_TOKEN_INVALID');
});

// ---------------------------------------------------------------------------
// list, revoke
// ---------------------------------------------------------------------------

test('listSessions returns the active sessions, current first, then most recent', async () => {
  const user = await makeUser();
  const userId = String(user._id);
  const a = await signIn(user, { signInMethod: 'password', device: { platform: 'ios', model: 'iPhone 16', appVersion: '1.4.0' } });
  clock.advance(60 * SECOND);
  const b = await signIn(user, { signInMethod: 'google', device: { platform: 'android', appVersion: '1.4.0' } });
  clock.advance(60 * SECOND);
  const c = await signIn(user, { signInMethod: 'apple', device: { platform: 'ios', appVersion: '1.3.0' } });
  await signIn(await makeUser()); // someone else's

  const list = await service.listSessions({ userId, currentSessionId: b.session.id });
  assert.equal(matchesSpec('SessionList', list), true, JSON.stringify(ajv.errors));
  assert.deepEqual(list.data.map((s) => s.id), [b.session.id, c.session.id, a.session.id]);
  assert.deepEqual(list.data.map((s) => s.current), [true, false, false]);
  assert.deepEqual(list.data.map((s) => s.signInMethod), ['google', 'apple', 'password']);
  assert.deepEqual(list.data[0].device, { platform: 'android', appVersion: '1.4.0' });
  for (const s of list.data) assert.equal(matchesSpec('SessionInfo', s), true, JSON.stringify(ajv.errors));
});

test('lastActiveAt follows refreshes in the list', async () => {
  const user = await makeUser();
  const a = await signIn(user);
  clock.advance(60 * SECOND);
  const b = await signIn(user);
  clock.advance(60 * SECOND);
  const c = await signIn(user);
  clock.advance(60 * SECOND);
  await service.refresh({ refreshToken: a.pair.refreshToken, installationId: a.installationId });
  const list = await service.listSessions({ userId: String(user._id), currentSessionId: c.session.id });
  assert.deepEqual(list.data.map((s) => s.id), [c.session.id, a.session.id, b.session.id]);
});

test('listSessions leaves out expired sessions and an unknown user gets an empty list', async () => {
  const user = await makeUser();
  await signIn(user);
  clock.advance(61 * DAY);
  assert.deepEqual((await service.listSessions({ userId: String(user._id) })).data, []);
  assert.deepEqual((await service.listSessions({ userId: 'nope' })).data, []);
});

test('revokeSession signs out one device, is idempotent, and removes the grace record', async () => {
  const user = await makeUser();
  const userId = String(user._id);
  const a = await signIn(user);
  const b = await signIn(user);
  const rotated = await service.refresh({ refreshToken: a.pair.refreshToken, installationId: a.installationId });
  assert.equal(await RefreshGrace.countDocuments({ sessionId: a.session.id }), 1);

  await service.revokeSession({ userId, sessionId: a.session.id });
  await service.revokeSession({ userId, sessionId: a.session.id });
  assert.equal(await RefreshGrace.countDocuments({ sessionId: a.session.id }), 0);

  const list = await service.listSessions({ userId, currentSessionId: b.session.id });
  assert.deepEqual(list.data.map((s) => s.id), [b.session.id]);

  const stored = await Session.findById(a.session.id).lean();
  assert.ok(stored.revokedAt);
  assert.equal(stored.revokeReason, 'user_revoked');
  const aTokens = await RefreshToken.find({ sessionId: a.session.id }).lean();
  assert.equal(aTokens.length, 2);
  for (const t of aTokens) {
    assert.ok(t.expiresAt.getTime() <= clock.t + 7 * DAY);
  }
  await assertRejects(service.refresh({ refreshToken: rotated.refreshToken, installationId: a.installationId }), 401, 'SESSION_REVOKED');
  // The other device keeps working.
  assert.ok(await service.refresh({ refreshToken: b.pair.refreshToken, installationId: b.installationId }));
});

test("revoking someone else's session, a missing one, or a malformed id is SESSION_NOT_FOUND", async () => {
  const mine = await signIn(await makeUser());
  const theirs = await signIn(await makeUser());
  const userId = String(mine.user._id);

  for (const sessionId of [theirs.session.id, String(new mongoose.Types.ObjectId()), 'nope', '', undefined]) {
    await assertRejects(service.revokeSession({ userId, sessionId }), 404, 'SESSION_NOT_FOUND');
  }
  await assertRejects(service.revokeSession({ userId: 'nope', sessionId: mine.session.id }), 404, 'SESSION_NOT_FOUND');

  assert.equal((await Session.findById(theirs.session.id).lean()).revokedAt, null);
  assert.ok(await service.refresh({ refreshToken: theirs.pair.refreshToken, installationId: theirs.installationId }));
});

test('revokeAllOtherSessions keeps the current session and leaves other users alone', async () => {
  const user = await makeUser();
  const userId = String(user._id);
  const current = await signIn(user);
  const other1 = await signIn(user);
  const other2 = await signIn(user);
  const stranger = await signIn(await makeUser());

  await service.revokeAllOtherSessions({ userId, keepSessionId: current.session.id });
  await service.revokeAllOtherSessions({ userId, keepSessionId: current.session.id });

  const list = await service.listSessions({ userId, currentSessionId: current.session.id });
  assert.deepEqual(list.data.map((s) => s.id), [current.session.id]);
  assert.equal((await Session.findById(other1.session.id).lean()).revokeReason, 'other_sessions_revoked');
  for (const s of [other1, other2]) {
    await assertRejects(service.refresh({ refreshToken: s.pair.refreshToken, installationId: s.installationId }), 401, 'SESSION_REVOKED');
  }
  assert.ok(await service.refresh({ refreshToken: current.pair.refreshToken, installationId: current.installationId }));
  assert.ok(await service.refresh({ refreshToken: stranger.pair.refreshToken, installationId: stranger.installationId }));
});

test('revokeAllOtherSessions refuses a missing or malformed keepSessionId and revokes nothing', async () => {
  const user = await makeUser();
  const userId = String(user._id);
  const a = await signIn(user);
  const b = await signIn(user);
  for (const keepSessionId of [undefined, null, '', 'nope', '123', 42, {}]) {
    await assert.rejects(service.revokeAllOtherSessions({ userId, keepSessionId }), /keepSessionId/);
  }
  const list = await service.listSessions({ userId, currentSessionId: a.session.id });
  assert.deepEqual(list.data.map((x) => x.id).sort(), [a.session.id, b.session.id].sort());
  // An unknown user is not an error; there is simply nothing to revoke.
  await service.revokeAllOtherSessions({ userId: 'nope', keepSessionId: a.session.id });
});

test('revokeAllOtherSessions takes a reason, and removes the grace records of what it revokes', async () => {
  const user = await makeUser();
  const userId = String(user._id);
  const keep = await signIn(user);
  const gone = await signIn(user);
  await service.refresh({ refreshToken: keep.pair.refreshToken, installationId: keep.installationId });
  await service.refresh({ refreshToken: gone.pair.refreshToken, installationId: gone.installationId });
  assert.equal(await RefreshGrace.countDocuments(), 2);

  await service.revokeAllOtherSessions({ userId, keepSessionId: keep.session.id, reason: 'password_changed' });
  assert.equal((await Session.findById(gone.session.id).lean()).revokeReason, 'password_changed');
  assert.equal(await RefreshGrace.countDocuments({ sessionId: gone.session.id }), 0);
  assert.equal(await RefreshGrace.countDocuments({ sessionId: keep.session.id }), 1);
});

// ---------------------------------------------------------------------------
// revokeByRefreshToken (logout)
// ---------------------------------------------------------------------------

test('revokeByRefreshToken signs out the session of that token and is idempotent', async () => {
  const user = await makeUser();
  const userId = String(user._id);
  const a = await signIn(user);
  const b = await signIn(user);
  const rotated = await service.refresh({ refreshToken: a.pair.refreshToken, installationId: a.installationId });

  assert.equal(await service.revokeByRefreshToken({ refreshToken: rotated.refreshToken }), true);
  assert.equal(await service.revokeByRefreshToken({ refreshToken: rotated.refreshToken }), false);

  const stored = await Session.findById(a.session.id).lean();
  assert.equal(stored.revokeReason, 'logout');
  assert.equal(await RefreshGrace.countDocuments({ sessionId: a.session.id }), 0);
  await assertRejects(service.refresh({ refreshToken: rotated.refreshToken, installationId: a.installationId }), 401, 'SESSION_REVOKED');
  assert.deepEqual((await service.listSessions({ userId, currentSessionId: b.session.id })).data.map((x) => x.id), [b.session.id]);
  assert.ok(await service.refresh({ refreshToken: b.pair.refreshToken, installationId: b.installationId }));
});

test('revokeByRefreshToken also works with a token that was already used', async () => {
  const { pair, installationId, session } = await signIn(await makeUser());
  await service.refresh({ refreshToken: pair.refreshToken, installationId });
  assert.equal(await service.revokeByRefreshToken({ refreshToken: pair.refreshToken }), true);
  assert.ok((await Session.findById(session.id).lean()).revokedAt);
});

test('revokeByRefreshToken ignores unknown, empty and non-string tokens without an error', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  for (const refreshToken of [crypto.randomBytes(32).toString('base64url'), '', undefined, null, 42, {}]) {
    assert.equal(await service.revokeByRefreshToken({ refreshToken }), false);
  }
  assert.ok(await service.refresh({ refreshToken: pair.refreshToken, installationId }));
});

test('revokeByRefreshToken with a userId only revokes that user\'s own token', async () => {
  const mine = await signIn(await makeUser());
  const theirs = await signIn(await makeUser());

  assert.equal(await service.revokeByRefreshToken({ refreshToken: theirs.pair.refreshToken, userId: String(mine.user._id) }), false);
  assert.equal(await service.revokeByRefreshToken({ refreshToken: theirs.pair.refreshToken, userId: 'nope' }), false);
  assert.equal((await Session.findById(theirs.session.id).lean()).revokedAt, null);

  assert.equal(await service.revokeByRefreshToken({ refreshToken: mine.pair.refreshToken, userId: String(mine.user._id) }), true);
  assert.ok((await Session.findById(mine.session.id).lean()).revokedAt);
});

test('revoked sessions and their tokens are only kept for a week', async () => {
  const { user, session } = await signIn(await makeUser());
  await service.revokeSession({ userId: String(user._id), sessionId: session.id });
  const stored = await Session.findById(session.id).lean();
  assert.equal(stored.expiresAt.getTime(), Math.floor(clock.t / SECOND) * SECOND + 7 * DAY);
});

test('the service uses the injected clock for its tokens', async () => {
  clock.t = Date.parse('2030-01-01T00:00:00Z');
  const { pair } = await signIn(await makeUser());
  assert.equal(pair.accessTokenExpiresAt, '2030-01-01T00:15:00Z');
  assert.equal(pair.refreshTokenExpiresAt, '2030-03-02T00:00:00Z');
});
