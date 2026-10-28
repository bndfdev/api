process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { config } = require('../src/config');
const { createApp } = require('../src/app');
const { createTokens } = require('../src/lib/tokens');
const sessionService = require('../src/modules/sessions/service');
const Session = require('../models/Session');
const User = require('../models/User');
const db = require('./support/db');
const { CLIENT, makeUser, signIn, assertProblem } = require('./support/api');

const app = createApp();
const HOUR = 60 * 60 * 1000;

before(db.connect);
beforeEach(db.clear);
after(db.disconnect);

const bearer = (token) => ({ ...CLIENT, Authorization: `Bearer ${token}` });
const listSessions = (headers) => request(app).get('/v1/me/sessions').set(headers);
const refresh = (installationId, refreshToken) => request(app)
  .post('/v1/auth/token/refresh')
  .set({ ...CLIENT, 'X-Installation-Id': installationId })
  .send({ refreshToken });
const logout = (headers = CLIENT) => request(app).post('/v1/auth/logout').set(headers);
const sessionIds = async (userId) => (await Session.find({ userId, revokedAt: null })).map((s) => String(s._id));

// ---------------------------------------------------------------------------
// requireAuth (exercised through GET /v1/me/sessions)
// ---------------------------------------------------------------------------

test('requireAuth: no Authorization header is 401 UNAUTHENTICATED with a Bearer challenge', async () => {
  const res = await request(app).get('/v1/me/sessions').set(CLIENT);
  assertProblem(res, 401, 'UNAUTHENTICATED');
  assert.equal(res.headers['www-authenticate'], 'Bearer');
});

test('requireAuth: only Bearer tokens count (other schemes and the old API key do not)', async () => {
  for (const headers of [
    { ...CLIENT, Authorization: 'Basic dXNlcjpwYXNz' },
    { ...CLIENT, Authorization: 'Token abc' },
    { ...CLIENT, 'x-api-key': 'anything' },
  ]) {
    const res = await request(app).get('/v1/me/sessions').set(headers);
    assertProblem(res, 401, 'UNAUTHENTICATED');
    assert.equal(res.headers['www-authenticate'], 'Bearer');
  }
});

test('requireAuth: a malformed Bearer value is 401 TOKEN_INVALID', async () => {
  for (const authorization of ['Bearer', 'Bearer not-a-jwt', 'Bearer two tokens', `Bearer ${'a'.repeat(5000)}`]) {
    const res = await request(app).get('/v1/me/sessions').set({ ...CLIENT, Authorization: authorization });
    // "Bearer" alone has no token, so it is treated like a missing credential.
    assertProblem(res, 401, authorization === 'Bearer' ? 'UNAUTHENTICATED' : 'TOKEN_INVALID');
    assert.match(res.headers['www-authenticate'], /^Bearer/);
  }
});

test('requireAuth: a tampered token is TOKEN_INVALID and is not echoed back', async () => {
  const user = await makeUser();
  const { pair } = await signIn(user);
  const [header, payload, signature] = pair.accessToken.split('.');
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  const token = `${header}.${payload}.${flipped}`;
  const res = await listSessions(bearer(token));
  assertProblem(res, 401, 'TOKEN_INVALID');
  assert.equal(res.headers['www-authenticate'], 'Bearer error="invalid_token"');
  assert.ok(!res.text.includes(token));
});

test('requireAuth: an expired token is TOKEN_EXPIRED', async () => {
  const user = await makeUser();
  const { session } = await signIn(user);
  const past = createTokens({ jwt: config.jwt, now: () => Date.now() - 2 * HOUR });
  const { token } = await past.signAccessToken({ userId: String(user._id), sessionId: session.id });
  const res = await listSessions(bearer(token));
  assertProblem(res, 401, 'TOKEN_EXPIRED');
  assert.equal(res.headers['www-authenticate'], 'Bearer error="invalid_token"');
});

test('requireAuth: a valid token for a revoked session is SESSION_REVOKED', async () => {
  const user = await makeUser();
  const { pair, session } = await signIn(user);
  assert.equal((await listSessions(bearer(pair.accessToken))).status, 200);

  await sessionService.revokeSession({ userId: String(user._id), sessionId: session.id });
  const res = await listSessions(bearer(pair.accessToken));
  assertProblem(res, 401, 'SESSION_REVOKED');
  assert.equal(res.headers['www-authenticate'], 'Bearer error="invalid_token"');
});

test('requireAuth: an expired session, a missing session and a session of another user are all SESSION_REVOKED', async () => {
  const user = await makeUser();
  const other = await makeUser();
  const mine = await signIn(user);
  const theirs = await signIn(other);
  const tokens = createTokens({ jwt: config.jwt });

  // The token names someone else's session.
  const crossed = await tokens.signAccessToken({ userId: String(user._id), sessionId: theirs.session.id });
  assertProblem(await listSessions(bearer(crossed.token)), 401, 'SESSION_REVOKED');

  // The token names a session that never existed.
  const ghost = await tokens.signAccessToken({ userId: String(user._id), sessionId: String(new mongoose.Types.ObjectId()) });
  assertProblem(await listSessions(bearer(ghost.token)), 401, 'SESSION_REVOKED');

  // The session is past its expiry (it may already be removed by the TTL monitor: same answer).
  await Session.updateOne({ _id: mine.session.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assertProblem(await listSessions(bearer(mine.pair.accessToken)), 401, 'SESSION_REVOKED');
});

test('requireAuth: the Bearer scheme is case-insensitive', async () => {
  const { pair } = await signIn(await makeUser());
  const res = await listSessions({ ...CLIENT, Authorization: `bearer ${pair.accessToken}` });
  assert.equal(res.status, 200);
});

test('401 responses on /v1 are problems that carry the request id', async () => {
  const res = await request(app).get('/v1/me/sessions').set(CLIENT).set('X-Request-Id', 'trace-me-12345');
  assertProblem(res, 401, 'UNAUTHENTICATED');
  assert.equal(res.body.requestId, 'trace-me-12345');
  assert.equal(res.body.instance, '/v1/me/sessions');
});

// ---------------------------------------------------------------------------
// POST /v1/auth/token/refresh
// ---------------------------------------------------------------------------

test('refresh rotates the tokens and the new access token works for the same session', async () => {
  const user = await makeUser();
  const { pair, installationId, session } = await signIn(user);

  const res = await refresh(installationId, pair.refreshToken);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.tokenType, 'Bearer');
  assert.notEqual(res.body.refreshToken, pair.refreshToken);
  assert.notEqual(res.body.accessToken, pair.accessToken);

  const list = await listSessions(bearer(res.body.accessToken));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((s) => s.id), [session.id]);
});

test('refresh: the same install repeating a refresh inside the grace window gets the same pair', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  const first = await refresh(installationId, pair.refreshToken);
  const again = await refresh(installationId, pair.refreshToken);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
});

test('refresh: reuse from another install is REFRESH_TOKEN_REUSED and ends the session, access token included', async () => {
  const user = await makeUser();
  const { pair, installationId, session } = await signIn(user);
  const first = await refresh(installationId, pair.refreshToken);
  assert.equal(first.status, 200);

  const stolen = await refresh(crypto.randomUUID(), pair.refreshToken);
  assertProblem(stolen, 401, 'REFRESH_TOKEN_REUSED');

  // Both the access token the attacker never saw and the rotated one are now dead.
  assertProblem(await listSessions(bearer(first.body.accessToken)), 401, 'SESSION_REVOKED');
  assertProblem(await listSessions(bearer(pair.accessToken)), 401, 'SESSION_REVOKED');
  assertProblem(await refresh(installationId, first.body.refreshToken), 401, 'SESSION_REVOKED');
  assert.deepEqual(await sessionIds(user._id), []);
  assert.equal((await Session.findById(session.id)).revokeReason, 'refresh_token_reused');
});

test('refresh: reuse after the grace window is REFRESH_TOKEN_REUSED and ends the session', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  const first = await refresh(installationId, pair.refreshToken);
  assert.equal(first.status, 200);
  await mongoose.connection.collection('refresh_grace').updateMany({}, { $set: { graceUntil: new Date(Date.now() - 1000) } });

  assertProblem(await refresh(installationId, pair.refreshToken), 401, 'REFRESH_TOKEN_REUSED');
  assertProblem(await listSessions(bearer(first.body.accessToken)), 401, 'SESSION_REVOKED');
});

test('refresh: unknown tokens and a token from the wrong install are REFRESH_TOKEN_INVALID', async () => {
  const { pair, installationId } = await signIn(await makeUser());
  assertProblem(await refresh(installationId, 'definitely-not-a-token'), 401, 'REFRESH_TOKEN_INVALID');
  assertProblem(await refresh(crypto.randomUUID(), pair.refreshToken), 401, 'REFRESH_TOKEN_INVALID');
  // The rightful install is not punished for the other's attempt.
  assert.equal((await refresh(installationId, pair.refreshToken)).status, 200);
});

test('refresh: a revoked session is SESSION_REVOKED and a suspended user is ACCOUNT_SUSPENDED', async () => {
  const user = await makeUser();
  const { pair, installationId, session } = await signIn(user);
  await sessionService.revokeSession({ userId: String(user._id), sessionId: session.id });
  assertProblem(await refresh(installationId, pair.refreshToken), 401, 'SESSION_REVOKED');

  const blocked = await makeUser({ isBlocked: true });
  const other = await signIn(blocked);
  assertProblem(await refresh(other.installationId, other.pair.refreshToken), 403, 'ACCOUNT_SUSPENDED');
  await User.updateOne({ _id: blocked._id }, { $set: { isBlocked: false } });
  assert.equal((await refresh(other.installationId, other.pair.refreshToken)).status, 200);
});

test('refresh: bad requests are rejected by the spec validation before any token is touched', async () => {
  const { pair } = await signIn(await makeUser());
  const missingField = await request(app).post('/v1/auth/token/refresh').set(CLIENT).send({});
  assertProblem(missingField, 422, 'VALIDATION_FAILED');
  assert.deepEqual(missingField.body.errors.map((e) => e.field), ['/refreshToken']);

  const extra = await request(app).post('/v1/auth/token/refresh').set(CLIENT).send({ refreshToken: pair.refreshToken, extra: 1 });
  assertProblem(extra, 422, 'VALIDATION_FAILED');

  const noInstall = await request(app)
    .post('/v1/auth/token/refresh')
    .set({ 'X-Client-Platform': 'ios', 'X-Client-Version': '1.4.0' })
    .send({ refreshToken: pair.refreshToken });
  assertProblem(noInstall, 400, 'MALFORMED_REQUEST');

  // Nothing above used the token.
  assert.equal((await refresh(CLIENT['X-Installation-Id'], pair.refreshToken)).status, 401);
});

// ---------------------------------------------------------------------------
// POST /v1/auth/logout
// ---------------------------------------------------------------------------

test('logout with an access token ends that session only', async () => {
  const user = await makeUser();
  const a = await signIn(user);
  const b = await signIn(user);

  const res = await logout(a.headers);
  assert.equal(res.status, 204);
  assert.equal(res.text, '');
  assertProblem(await listSessions(a.headers), 401, 'SESSION_REVOKED');
  assertProblem(await refresh(a.installationId, a.pair.refreshToken), 401, 'SESSION_REVOKED');
  assert.equal((await listSessions(b.headers)).status, 200);
});

test('logout with only a refresh token (the access token expired) still ends the session', async () => {
  const user = await makeUser();
  const a = await signIn(user);
  const past = createTokens({ jwt: config.jwt, now: () => Date.now() - 2 * HOUR });
  const expired = await past.signAccessToken({ userId: String(user._id), sessionId: a.session.id });

  const res = await logout(bearer(expired.token)).send({ refreshToken: a.pair.refreshToken });
  assert.equal(res.status, 204);
  assertProblem(await listSessions(a.headers), 401, 'SESSION_REVOKED');
});

test('logout with a refresh token and no access token at all ends the session', async () => {
  const a = await signIn(await makeUser());
  assert.equal((await logout().send({ refreshToken: a.pair.refreshToken })).status, 204);
  assertProblem(await listSessions(a.headers), 401, 'SESSION_REVOKED');
});

test('logout is always 204: no credentials, junk credentials, already signed out, repeated', async () => {
  assert.equal((await logout()).status, 204);
  assert.equal((await logout(bearer('junk'))).status, 204);
  assert.equal((await logout().send({ refreshToken: 'unknown' })).status, 204);
  assert.equal((await logout().send({})).status, 204);

  const a = await signIn(await makeUser());
  assert.equal((await logout(a.headers).send({ refreshToken: a.pair.refreshToken })).status, 204);
  assert.equal((await logout(a.headers).send({ refreshToken: a.pair.refreshToken })).status, 204);
  assert.equal((await logout(a.headers)).status, 204);
});

test('logout cannot be used to sign out another user through their refresh token while signed in as yourself', async () => {
  const me = await signIn(await makeUser());
  const victim = await signIn(await makeUser());

  const res = await logout(me.headers).send({ refreshToken: victim.pair.refreshToken });
  assert.equal(res.status, 204);
  assertProblem(await listSessions(me.headers), 401, 'SESSION_REVOKED');
  assert.equal((await listSessions(victim.headers)).status, 200);
});

test('logout rejects unknown body fields', async () => {
  assertProblem(await logout().send({ refreshToken: 'x', all: true }), 422, 'VALIDATION_FAILED');
});

// ---------------------------------------------------------------------------
// GET /v1/me/sessions, DELETE /v1/me/sessions, DELETE /v1/me/sessions/{sessionId}
// ---------------------------------------------------------------------------

test('GET /me/sessions lists the active sessions of the caller, current first', async () => {
  const user = await makeUser();
  const first = await signIn(user, { signInMethod: 'google', device: { platform: 'android', model: 'Pixel 9', appVersion: '1.3.0' } });
  const second = await signIn(user);
  await signIn(await makeUser()); // someone else's session never shows up

  // The older session is the caller: it must still come first.
  const res = await listSessions(first.headers);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body.data.map((s) => s.id), [first.session.id, second.session.id]);
  assert.deepEqual(res.body.data.map((s) => s.current), [true, false]);
  assert.equal(res.body.data[0].signInMethod, 'google');
  assert.deepEqual(res.body.data[0].device, { platform: 'android', model: 'Pixel 9', appVersion: '1.3.0' });
});

test('GET /me/sessions does not list revoked sessions', async () => {
  const user = await makeUser();
  const a = await signIn(user);
  const b = await signIn(user);
  await sessionService.revokeSession({ userId: String(user._id), sessionId: b.session.id });
  const res = await listSessions(a.headers);
  assert.deepEqual(res.body.data.map((s) => s.id), [a.session.id]);
});

test('DELETE /me/sessions/{id} signs out one other device', async () => {
  const user = await makeUser();
  const a = await signIn(user);
  const b = await signIn(user);

  const res = await request(app).delete(`/v1/me/sessions/${b.session.id}`).set(a.headers);
  assert.equal(res.status, 204);
  assert.equal(res.text, '');
  assertProblem(await listSessions(b.headers), 401, 'SESSION_REVOKED');
  assert.deepEqual((await listSessions(a.headers)).body.data.map((s) => s.id), [a.session.id]);

  // Repeating it is fine: the session is still the caller's.
  assert.equal((await request(app).delete(`/v1/me/sessions/${b.session.id}`).set(a.headers)).status, 204);
});

test('DELETE /me/sessions/{id} on the current session is the same as logout', async () => {
  const a = await signIn(await makeUser());
  assert.equal((await request(app).delete(`/v1/me/sessions/${a.session.id}`).set(a.headers)).status, 204);
  assertProblem(await listSessions(a.headers), 401, 'SESSION_REVOKED');
});

test('DELETE /me/sessions/{id} is 404 SESSION_NOT_FOUND for another user\'s, unknown and malformed ids', async () => {
  const me = await signIn(await makeUser());
  const theirs = await signIn(await makeUser());

  for (const id of [theirs.session.id, String(new mongoose.Types.ObjectId()), 'not-an-id']) {
    assertProblem(await request(app).delete(`/v1/me/sessions/${id}`).set(me.headers), 404, 'SESSION_NOT_FOUND');
  }
  // The other user's session is untouched.
  assert.equal((await listSessions(theirs.headers)).status, 200);
});

test('DELETE /me/sessions signs out every other device and keeps this one', async () => {
  const user = await makeUser();
  const a = await signIn(user);
  const b = await signIn(user);
  const c = await signIn(user);
  const bystander = await signIn(await makeUser());

  const res = await request(app).delete('/v1/me/sessions').set(b.headers);
  assert.equal(res.status, 204);
  assert.deepEqual((await listSessions(b.headers)).body.data.map((s) => s.id), [b.session.id]);
  assertProblem(await listSessions(a.headers), 401, 'SESSION_REVOKED');
  assertProblem(await listSessions(c.headers), 401, 'SESSION_REVOKED');
  assert.equal((await listSessions(bystander.headers)).status, 200);

  // Idempotent.
  assert.equal((await request(app).delete('/v1/me/sessions').set(b.headers)).status, 204);
});

test('session routes need authentication', async () => {
  const id = String(new mongoose.Types.ObjectId());
  assertProblem(await request(app).get('/v1/me/sessions').set(CLIENT), 401, 'UNAUTHENTICATED');
  assertProblem(await request(app).delete('/v1/me/sessions').set(CLIENT), 401, 'UNAUTHENTICATED');
  assertProblem(await request(app).delete(`/v1/me/sessions/${id}`).set(CLIENT), 401, 'UNAUTHENTICATED');
});

test('session routes validate the request against the spec first (client headers are required)', async () => {
  const { pair } = await signIn(await makeUser());
  const res = await request(app).get('/v1/me/sessions').set('Authorization', `Bearer ${pair.accessToken}`);
  assertProblem(res, 400, 'MALFORMED_REQUEST');
  assertProblem(await request(app).get('/v1/me/sessions').set(CLIENT).query({ page: 2 }), 422, 'VALIDATION_FAILED');
});

test('wrong methods on the session paths are 405 with the spec Allow header', async () => {
  const res = await request(app).put('/v1/me/sessions').set(CLIENT);
  assertProblem(res, 405, 'METHOD_NOT_ALLOWED');
  assert.equal(res.headers.allow, 'GET, DELETE, HEAD');
});
