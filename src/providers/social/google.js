const crypto = require('node:crypto');
const { validateDestination } = require('../../lib/destination');
const { ApiError } = require('../../lib/problem');
const { invalidToken, unsupportedProvider, providerUnavailable, nonceMismatch, unverifiedEmail } = require('./errors');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TIMEOUT_MS = 5000;

/** A cached remote JWKS in production; `jwks` accepts a local jose resolver in tests. */
function createGoogleVerifier({ clientIds = [], jwks, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  let keys = jwks;
  return async function verifyGoogle(credential = {}) {
    if (!clientIds.length) throw unsupportedProvider();
    if (typeof credential.idToken !== 'string' || !credential.idToken) throw invalidToken();
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    keys ??= createRemoteJWKSet(new URL(CERTS_URL), { timeoutDuration: timeoutMs });
    let payload;
    try {
      ({ payload } = await jwtVerify(credential.idToken, keys, {
        algorithms: ['RS256'], issuer: ['accounts.google.com', 'https://accounts.google.com'],
        audience: clientIds, requiredClaims: ['exp', 'sub'], currentDate: new Date(now()),
      }));
    } catch (err) {
      // JWKS transport failures are transient; bad JWTs and unknown signing keys are credentials failures.
      if (err instanceof ApiError) throw err;
      if (err instanceof TypeError || ['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC', 'ERR_JWKS_INVALID'].includes(err.code) ||
          ['AbortError', 'TimeoutError'].includes(err.name)) throw providerUnavailable();
      throw invalidToken();
    }
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) throw invalidToken();
    if (credential.nonce !== undefined || payload.nonce !== undefined) {
      if (typeof credential.nonce !== 'string' || !credential.nonce || typeof payload.nonce !== 'string') throw nonceMismatch();
      const expected = crypto.createHash('sha256').update(credential.nonce, 'utf8').digest('hex');
      const actual = Buffer.from(payload.nonce, 'utf8');
      const expectedBytes = Buffer.from(expected, 'utf8');
      if (actual.length !== expectedBytes.length || !crypto.timingSafeEqual(actual, expectedBytes)) throw nonceMismatch();
    }
    const result = { provider: 'google', providerUserId: payload.sub };
    if (payload.email !== undefined) {
      if (payload.email_verified !== true) throw unverifiedEmail();
      const email = validateDestination('email', payload.email);
      if (!email) throw invalidToken();
      result.email = email;
      result.emailVerified = true;
    }
    if (typeof payload.name === 'string') result.name = payload.name;
    return result;
  };
}

module.exports = { createGoogleVerifier, CERTS_URL, TIMEOUT_MS };
