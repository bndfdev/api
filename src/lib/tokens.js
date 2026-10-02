const crypto = require('node:crypto');
const { config: defaultConfig } = require('../config');
const { ApiError } = require('./problem');

const ALGORITHM = 'ES256';
// RFC 9068: marks the JWT as an access token so other signed tokens can't be passed off as one.
const TOKEN_TYPE = 'at+jwt';
const WWW_AUTHENTICATE = { 'WWW-Authenticate': 'Bearer error="invalid_token"' };

// jose is ESM-only; a dynamic import works on every supported Node 22.
let josePromise;
const loadJose = () => (josePromise ??= import('jose'));

function expired() {
  return new ApiError({ status: 401, code: 'TOKEN_EXPIRED', title: 'Access token expired', headers: WWW_AUTHENTICATE });
}

function invalid() {
  return new ApiError({ status: 401, code: 'TOKEN_INVALID', title: 'Access token invalid', headers: WWW_AUTHENTICATE });
}

/**
 * Access-token signer and verifier.
 * @param {{jwt?: object, now?: () => number}} [options] `jwt` is `config.jwt`; `now` returns epoch ms.
 */
function createTokens({ jwt = defaultConfig.jwt, now = Date.now } = {}) {
  let keys;

  async function getKeys() {
    if (!jwt.privateKey || !jwt.publicKey || !jwt.keyId) {
      throw new Error('JWT signing keys are not configured');
    }
    if (!keys) {
      const jose = await loadJose();
      keys = {
        privateKey: await jose.importPKCS8(jwt.privateKey, ALGORITHM),
        publicKey: await jose.importSPKI(jwt.publicKey, ALGORITHM),
      };
    }
    return keys;
  }

  /**
   * Sign an access token. Claims carry ids only, no personal data.
   * @param {{userId: string, sessionId: string}} subject
   * @returns {Promise<{token: string, expiresAt: Date}>}
   */
  async function signAccessToken({ userId, sessionId }) {
    const [jose, { privateKey }] = await Promise.all([loadJose(), getKeys()]);
    const iat = Math.floor(now() / 1000);
    const exp = iat + jwt.accessTtlSeconds;
    const token = await new jose.SignJWT({ sid: String(sessionId) })
      .setProtectedHeader({ alg: ALGORITHM, kid: jwt.keyId, typ: TOKEN_TYPE })
      .setSubject(String(userId))
      .setIssuer(jwt.issuer)
      .setAudience(jwt.audience)
      .setJti(crypto.randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Verify an access token. Throws a 401 ApiError: TOKEN_EXPIRED when it has
   * expired, TOKEN_INVALID for anything else.
   * @param {string} token
   * @returns {Promise<{userId: string, sessionId: string}>}
   */
  async function verifyAccessToken(token) {
    const jose = await loadJose();
    const { publicKey } = await getKeys();
    let payload;
    try {
      ({ payload } = await jose.jwtVerify(
        token,
        (header) => {
          if (header.kid !== jwt.keyId) throw new Error('unknown key id');
          return publicKey;
        },
        {
          algorithms: [ALGORITHM],
          issuer: jwt.issuer,
          audience: jwt.audience,
          typ: TOKEN_TYPE,
          requiredClaims: ['sub', 'sid', 'iat', 'exp', 'jti'],
          currentDate: new Date(now()),
        },
      ));
    } catch (err) {
      throw err instanceof jose.errors.JWTExpired ? expired() : invalid();
    }
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || !payload.sub || !payload.sid) {
      throw invalid();
    }
    return { userId: payload.sub, sessionId: payload.sid };
  }

  return { signAccessToken, verifyAccessToken };
}

module.exports = { createTokens, ...createTokens() };
