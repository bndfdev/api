process.env.NODE_ENV = 'test';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ApiError } = require('../src/lib/problem');
const { createGoogleVerifier } = require('../src/providers/social/google');
const { createFacebookVerifier } = require('../src/providers/social/facebook');
const { createSocialVerifier } = require('../src/providers/social');

const NOW = Date.parse('2026-11-01T10:00:00Z');
const epoch = NOW / 1000;
const audience = crypto.randomUUID();
const subject = crypto.randomUUID();
const email = () => `${crypto.randomUUID()}@example.com`;
let jose, privateKey, jwks, verifyGoogle;

before(async () => {
  jose = await import('jose');
  const pair = await jose.generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const key = { ...await jose.exportJWK(pair.publicKey), kid: 'local-google', use: 'sig', alg: 'RS256' };
  jwks = jose.createLocalJWKSet({ keys: [key] });
  verifyGoogle = createGoogleVerifier({ clientIds: [audience, crypto.randomUUID()], jwks, now: () => NOW });
});

function signed(claims = {}, { key = privateKey, algorithm = 'RS256', kid = 'local-google' } = {}) {
  return new jose.SignJWT({ iss: 'https://accounts.google.com', aud: audience, sub: subject, exp: epoch + 120, ...claims })
    .setProtectedHeader({ alg: algorithm, kid }).sign(key);
}

async function rejects(promise, status, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (status === 503) assert.equal(err.retryAfterSeconds, 30);
    return true;
  });
}

test('Google validates a locally signed JWT and uses sub with a verified email', async () => {
  const address = email();
  const result = await verifyGoogle({ idToken: await signed({ email: address, email_verified: true }) });
  assert.deepEqual(result, { provider: 'google', providerUserId: subject, email: address, emailVerified: true });
});

test('Google accepts either documented issuer and any configured client audience', async () => {
  const second = crypto.randomUUID();
  const verify = createGoogleVerifier({ clientIds: [audience, second], jwks, now: () => NOW });
  assert.equal((await verify({ idToken: await signed({ iss: 'accounts.google.com', aud: second }) })).providerUserId, subject);
});

test('Google allows a token without email, with no verified-email claim required', async () => {
  assert.deepEqual(await verifyGoogle({ idToken: await signed() }), { provider: 'google', providerUserId: subject });
});

test('Google refuses unverified, absent and string email_verified assertions for an email', async () => {
  for (const email_verified of [false, undefined, 'true', 'false', null]) {
    await rejects(verifyGoogle({ idToken: await signed({ email: email(), email_verified }) }), 422, 'SOCIAL_EMAIL_UNVERIFIED');
  }
});

test('Google rejects wrong audience, issuer, expiration and invalid required claims', async () => {
  for (const claims of [
    { aud: crypto.randomUUID() }, { iss: 'https://issuer.example.com' }, { exp: epoch }, { exp: undefined },
    { sub: '' }, { sub: undefined }, { sub: ' ' }, { nbf: epoch + 1 }, { email: 'invalid', email_verified: true },
  ]) await rejects(verifyGoogle({ idToken: await signed(claims) }), 401, 'SOCIAL_TOKEN_INVALID');
});

test('Google rejects tampered payloads, unknown keys, malformed JWTs and missing credentials', async () => {
  const token = await signed();
  const [header, , signature] = token.split('.');
  const modified = Buffer.from(JSON.stringify({ sub: crypto.randomUUID() })).toString('base64url');
  for (const idToken of [`${header}.${modified}.${signature}`, await signed({}, { kid: 'unknown' }), crypto.randomUUID(), '', undefined]) {
    await rejects(verifyGoogle({ idToken }), 401, 'SOCIAL_TOKEN_INVALID');
  }
});

test('Google refuses another signing key and an algorithm outside RS256', async () => {
  const other = await jose.generateKeyPair('RS256');
  await rejects(verifyGoogle({ idToken: await signed({}, { key: other.privateKey }) }), 401, 'SOCIAL_TOKEN_INVALID');
  const ec = await jose.generateKeyPair('ES256');
  await rejects(verifyGoogle({ idToken: await signed({}, { key: ec.privateKey, algorithm: 'ES256' }) }), 401, 'SOCIAL_TOKEN_INVALID');
});

test('Google checks the SHA256 of the raw nonce and never permits omission on either side', async () => {
  const nonce = crypto.randomUUID();
  const digest = crypto.createHash('sha256').update(nonce).digest('hex');
  const idToken = await signed({ nonce: digest });
  assert.equal((await verifyGoogle({ idToken, nonce })).providerUserId, subject);
  for (const credential of [
    { idToken }, { idToken, nonce: '' }, { idToken, nonce: crypto.randomUUID() },
    { idToken: await signed(), nonce }, { idToken: await signed({ nonce }), nonce },
  ]) await rejects(verifyGoogle(credential), 401, 'SOCIAL_NONCE_MISMATCH');
});

test('Google maps key-service transport and timeout failures to safe retryable errors', async () => {
  const idToken = await signed();
  for (const failure of [new TypeError('fetch failed'), Object.assign(new Error('timeout'), { code: 'ERR_JWKS_TIMEOUT' })]) {
    const verify = createGoogleVerifier({ clientIds: [audience], jwks: async () => { throw failure; }, now: () => NOW });
    await rejects(verify({ idToken }), 503, 'SERVICE_UNAVAILABLE');
  }
});

function facebookFixture({ data = {}, me = {}, steps, timeoutMs } = {}) {
  const appId = crypto.randomUUID();
  const appSecret = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const accessToken = crypto.randomUUID();
  const calls = [];
  const bodies = [
    { data: { is_valid: true, app_id: appId, type: 'USER', user_id: userId, expires_at: epoch + 600, data_access_expires_at: epoch + 3600, ...data } },
    { id: userId, ...me },
  ];
  const fetch = async (url, options) => {
    const index = calls.length;
    calls.push({ url: new URL(url), options });
    if (steps) return steps(index, options);
    return { ok: true, status: 200, json: async () => bodies[index] };
  };
  const verify = createFacebookVerifier({ appId, appSecret, fetch, now: () => NOW, timeoutMs });
  return { verify, accessToken, appId, appSecret, userId, calls };
}

test('Facebook verifies debug_token app and user, then fetches the same user profile', async () => {
  const fixture = facebookFixture({ me: { name: 'Synthetic profile' } });
  assert.deepEqual(await fixture.verify({ accessToken: fixture.accessToken }), {
    provider: 'facebook', providerUserId: fixture.userId, name: 'Synthetic profile',
  });
  const [debug, me] = fixture.calls;
  assert.equal(debug.url.origin, 'https://graph.facebook.com');
  assert.equal(debug.url.pathname, '/debug_token');
  assert.equal(debug.url.searchParams.get('input_token'), fixture.accessToken);
  assert.equal(debug.options.headers.Authorization, `Bearer ${fixture.appId}|${fixture.appSecret}`);
  assert.equal(me.url.pathname, '/me');
  assert.equal(me.url.searchParams.get('fields'), 'id,name,email');
  assert.equal(me.options.headers.Authorization, `Bearer ${fixture.accessToken}`);
  for (const call of fixture.calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(!call.url.href.includes(fixture.appSecret));
  }
});

test('Facebook ignores email without a verified assertion and supports absent email', async () => {
  for (const me of [{ email: email() }, {}]) {
    const fixture = facebookFixture({ me });
    const result = await fixture.verify({ accessToken: fixture.accessToken });
    assert.deepEqual(result, { provider: 'facebook', providerUserId: fixture.userId });
  }
});

test('Facebook refuses invalid status, wrong app, expired tokens and expired data access before /me', async () => {
  for (const data of [
    { is_valid: false }, { is_valid: 'true' }, { app_id: crypto.randomUUID() }, { expires_at: epoch },
    { expires_at: undefined }, { expires_at: 0 }, { expires_at: String(epoch + 100) },
    { data_access_expires_at: epoch }, { data_access_expires_at: 'invalid' }, { user_id: '' }, { user_id: undefined }, { type: 'PAGE' },
  ]) {
    const fixture = facebookFixture({ data });
    await rejects(fixture.verify({ accessToken: fixture.accessToken }), 401, 'SOCIAL_TOKEN_INVALID');
    assert.equal(fixture.calls.length, 1);
  }
});

test('Facebook refuses a /me subject different from the validated subject', async () => {
  const fixture = facebookFixture({ me: { id: crypto.randomUUID() } });
  await rejects(fixture.verify({ accessToken: fixture.accessToken }), 401, 'SOCIAL_TOKEN_INVALID');
});

test('Facebook rejects missing access tokens and Limited Login JWTs without network', async () => {
  const fixture = facebookFixture();
  for (const credential of [{}, { accessToken: '' }, { idToken: crypto.randomUUID() }, { accessToken: fixture.accessToken, idToken: crypto.randomUUID() }]) {
    await rejects(fixture.verify(credential), 401, 'SOCIAL_TOKEN_INVALID');
  }
  assert.equal(fixture.calls.length, 0);
});

test('Facebook maps credential HTTP and Graph errors to invalid-token without exposing provider messages', async () => {
  for (const response of [
    { ok: false, status: 400 }, { ok: false, status: 401 },
    { ok: true, status: 200, json: async () => ({ error: { code: 190, message: crypto.randomUUID() } }) },
  ]) {
    const fixture = facebookFixture({ steps: async () => response });
    await rejects(fixture.verify({ accessToken: fixture.accessToken }), 401, 'SOCIAL_TOKEN_INVALID');
  }
});

test('Facebook maps network, server, throttling and malformed responses to retryable errors', async () => {
  for (const steps of [
    async () => { throw new TypeError('network'); },
    async () => ({ ok: false, status: 503 }), async () => ({ ok: false, status: 429 }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }),
    async () => ({ ok: true, json: async () => null }),
    async () => ({ ok: true, json: async () => ({ error: { code: 2, is_transient: true } }) }),
  ]) {
    const fixture = facebookFixture({ steps });
    await rejects(fixture.verify({ accessToken: fixture.accessToken }), 503, 'SERVICE_UNAVAILABLE');
  }
});

test('Facebook deadlines cover a hanging fetch and a hanging response body, and abort the request', async () => {
  for (const hangBody of [false, true]) {
    let signal;
    const fixture = facebookFixture({ timeoutMs: 10, steps: async (_, options) => {
      signal = options.signal;
      const pending = new Promise(() => {});
      return hangBody ? { ok: true, json: () => pending } : pending;
    } });
    await rejects(fixture.verify({ accessToken: fixture.accessToken }), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(signal.aborted, true);
  }
});

test('provider dispatcher enforces switches, always refuses Apple and passes through enabled credentials', async () => {
  const calls = [];
  const google = async (credential) => { calls.push(credential); return { provider: 'google', providerUserId: subject }; };
  const facebook = async (credential) => { calls.push(credential); return { provider: 'facebook', providerUserId: subject }; };
  const enabled = { social: { googleClientIds: [audience], facebookAppId: crypto.randomUUID(), facebookAppSecret: crypto.randomUUID() } };
  const verify = createSocialVerifier({ config: enabled, google, facebook });
  assert.equal((await verify({ provider: 'google' })).provider, 'google');
  assert.equal((await verify({ provider: 'facebook' })).provider, 'facebook');
  for (const provider of ['apple', 'other']) await rejects(verify({ provider }), 422, 'SOCIAL_PROVIDER_UNSUPPORTED');
  const off = createSocialVerifier({ config: { social: {} }, google, facebook });
  for (const provider of ['google', 'facebook', 'apple']) await rejects(off({ provider }), 422, 'SOCIAL_PROVIDER_UNSUPPORTED');
  assert.equal(calls.length, 2);
});

test('direct verifiers also fail closed when their provider configuration is absent', async () => {
  await rejects(createGoogleVerifier()({ idToken: crypto.randomUUID() }), 422, 'SOCIAL_PROVIDER_UNSUPPORTED');
  for (const config of [{}, { appId: crypto.randomUUID() }, { appSecret: crypto.randomUUID() }]) {
    await rejects(createFacebookVerifier(config)({ accessToken: crypto.randomUUID() }), 422, 'SOCIAL_PROVIDER_UNSUPPORTED');
  }
});
