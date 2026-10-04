process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { config } = require('../src/config');
const { ApiError } = require('../src/lib/problem');
const { createTokens } = require('../src/lib/tokens');

const SUBJECT = { userId: '6650f1c2a4b7e9d3c1f00a12', sessionId: '6650f1c2a4b7e9d3c1f00b34' };
const clock = { t: Date.parse('2026-10-01T10:00:00Z') };
const tokens = createTokens({ jwt: config.jwt, now: () => clock.t });

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

async function assertRejects(promise, status, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

// What verifying a token for SUBJECT gives back: a full account's token reads as accountType 'user'.
const VERIFIED = Object.freeze({ ...SUBJECT, accountType: 'user' });

const invalid = (token) => assertRejects(tokens.verifyAccessToken(token), 401, 'TOKEN_INVALID');

test('sign and verify round trip', async () => {
  const { token, expiresAt } = await tokens.signAccessToken(SUBJECT);
  assert.deepEqual(await tokens.verifyAccessToken(token), VERIFIED);
  assert.equal(expiresAt.getTime(), clock.t + 900 * 1000);
});

test('the token is an ES256 JWT with the documented header and only id claims', async () => {
  const { token, expiresAt } = await tokens.signAccessToken(SUBJECT);
  const [header, payload] = token.split('.').slice(0, 2).map(decode);
  assert.deepEqual(header,{ alg: 'ES256', kid: config.jwt.keyId, typ: 'at+jwt' });
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
  assert.equal(payload.sub, SUBJECT.userId);
  assert.equal(payload.sid, SUBJECT.sessionId);
  assert.equal(payload.iss, config.jwt.issuer);
  assert.equal(payload.aud, config.jwt.audience);
  assert.equal(payload.iat, clock.t / 1000);
  assert.equal(payload.exp, expiresAt.getTime() / 1000);
});

test('every token gets its own jti', async () => {
  const a = decode((await tokens.signAccessToken(SUBJECT)).token.split('.')[1]);
  const b = decode((await tokens.signAccessToken(SUBJECT)).token.split('.')[1]);
  assert.notEqual(a.jti, b.jti);
});

test('an expired token is TOKEN_EXPIRED with a WWW-Authenticate header', async () => {
  const { token } = await tokens.signAccessToken(SUBJECT);
  const later = createTokens({ jwt: config.jwt, now: () => clock.t + 901 * 1000 });
  await assertRejects(later.verifyAccessToken(token), 401, 'TOKEN_EXPIRED');
  await later.verifyAccessToken(token).catch((err) => {
    assert.equal(err.headers['WWW-Authenticate'], 'Bearer error="invalid_token"');
  });
  const almost = createTokens({ jwt: config.jwt, now: () => clock.t + 899 * 1000 });
  assert.deepEqual(await almost.verifyAccessToken(token), VERIFIED);
});

test('a tampered payload or signature is TOKEN_INVALID', async () => {
  const { token } = await tokens.signAccessToken(SUBJECT);
  const [header, payload, signature] = token.split('.');
  const forged = b64({ ...decode(payload), sub: 'someone-else' });
  await invalid(`${header}.${forged}.${signature}`);
  const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
  await invalid(`${header}.${payload}.${flipped}`);
});

test('an expired token with a bad signature is TOKEN_INVALID, not TOKEN_EXPIRED', async () => {
  const { token } = await tokens.signAccessToken(SUBJECT);
  const [header, payload] = token.split('.');
  const later = createTokens({ jwt: config.jwt, now: () => clock.t + 3600 * 1000 });
  const badSignature = Buffer.alloc(64).toString('base64url');
  await assertRejects(later.verifyAccessToken(`${header}.${payload}.${badSignature}`), 401, 'TOKEN_INVALID');
});

test('alg none is rejected', async () => {
  const { token } = await tokens.signAccessToken(SUBJECT);
  const payload = token.split('.')[1];
  const header = b64({ alg: 'none', typ: 'at+jwt', kid: config.jwt.keyId });
  await invalid(`${header}.${payload}.`);
  await invalid(`${header}.${payload}`);
});

test('HS256 is rejected, including a token keyed with the public key', async () => {
  const jose = await import('jose');
  const hmacKey = new TextEncoder().encode(config.jwt.publicKey);
  const token = await new jose.SignJWT({ sid: SUBJECT.sessionId })
    .setProtectedHeader({ alg: 'HS256', kid: config.jwt.keyId, typ: 'at+jwt' })
    .setSubject(SUBJECT.userId)
    .setIssuer(config.jwt.issuer)
    .setAudience(config.jwt.audience)
    .setJti('x')
    .setIssuedAt(clock.t / 1000)
    .setExpirationTime(clock.t / 1000 + 900)
    .sign(hmacKey);
  await invalid(token);
});

test('wrong audience, issuer or key id is TOKEN_INVALID', async () => {
  for (const override of [{ audience: 'someone-else' }, { issuer: 'someone-else' }, { keyId: 'other-key' }]) {
    const foreign = createTokens({ jwt: { ...config.jwt, ...override }, now: () => clock.t });
    const { token } = await foreign.signAccessToken(SUBJECT);
    await invalid(token);
  }
});

test('a token signed with another key is TOKEN_INVALID', async () => {
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const foreign = createTokens({
    jwt: {
      ...config.jwt,
      privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }),
    },
    now: () => clock.t,
  });
  await invalid((await foreign.signAccessToken(SUBJECT)).token);
});

test('a JWT of another type, or without a session id, is TOKEN_INVALID', async () => {
  const jose = await import('jose');
  const privateKey = await jose.importPKCS8(config.jwt.privateKey, 'ES256');
  const build = (typ, claims) => new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: config.jwt.keyId, typ })
    .setSubject(SUBJECT.userId)
    .setIssuer(config.jwt.issuer)
    .setAudience(config.jwt.audience)
    .setJti('x')
    .setIssuedAt(clock.t / 1000)
    .setExpirationTime(clock.t / 1000 + 900)
    .sign(privateKey);
  await invalid(await build('JWT', { sid: SUBJECT.sessionId }));
  await invalid(await build('at+jwt', {}));
  await invalid(await build('at+jwt', { sid: '' }));
  // Only "guest" is a known account type; anything else in `act` is refused.
  await invalid(await build('at+jwt', { sid: SUBJECT.sessionId, act: 'admin' }));
  await invalid(await build('at+jwt', { sid: SUBJECT.sessionId, act: 1 }));
  // The same builder with everything right is accepted, so the rejections above are for the stated reason.
  assert.deepEqual(await tokens.verifyAccessToken(await build('at+jwt', { sid: SUBJECT.sessionId })), VERIFIED);
});

test('a guest token carries act "guest" and reads back as a guest; an account token has no act', async () => {
  const jose = await import('jose');
  const guest = await tokens.signAccessToken({ ...SUBJECT, accountType: 'guest' });
  assert.deepEqual(await tokens.verifyAccessToken(guest.token), { ...SUBJECT, accountType: 'guest' });
  assert.equal(jose.decodeJwt(guest.token).act, 'guest');
  const account = await tokens.signAccessToken(SUBJECT);
  assert.equal(jose.decodeJwt(account.token).act, undefined);
});

test('malformed input is TOKEN_INVALID', async () => {
  for (const value of ['', 'abc', 'a.b.c', '....', undefined, null, 42, {}]) {
    await invalid(value);
  }
});

test('missing signing keys are a server error, not a 401', async () => {
  const unconfigured = createTokens({ jwt: { ...config.jwt, privateKey: undefined, publicKey: undefined } });
  await assert.rejects(unconfigured.signAccessToken(SUBJECT), (err) => !(err instanceof ApiError) && /not configured/.test(err.message));
  await assert.rejects(unconfigured.verifyAccessToken('a.b.c'), (err) => !(err instanceof ApiError));
});
