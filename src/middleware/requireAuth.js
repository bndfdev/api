const { ApiError } = require('../lib/problem');
const { asyncHandler } = require('../lib/asyncHandler');
const defaultTokens = require('../lib/tokens');
const defaultSessions = require('../modules/sessions/service');

// "Bearer <token>": the scheme is case-insensitive (RFC 9110), the token has no spaces.
const BEARER = /^Bearer\s+(.+)$/i;
// A real access token is a few hundred bytes; anything this long is not worth verifying.
const MAX_TOKEN_LENGTH = 4096;

const unauthenticated = () => new ApiError({
  status: 401,
  code: 'UNAUTHENTICATED',
  title: 'Authentication required',
  detail: 'Send an access token as "Authorization: Bearer <token>".',
  headers: { 'WWW-Authenticate': 'Bearer' },
});

const tokenInvalid = () => new ApiError({
  status: 401,
  code: 'TOKEN_INVALID',
  title: 'Access token invalid',
  headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
});

/**
 * The bearer token of a request: a string, or null when there is no Authorization
 * header or it uses another scheme. A Bearer header whose token is empty or
 * malformed returns the (unusable) string so verification can reject it.
 */
function readBearerToken(req) {
  const header = req.get('authorization');
  if (typeof header !== 'string') return null;
  const match = BEARER.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Authentication middleware. Bearer tokens only: the pre-login key and tokens
 * in the body or query are not accepted.
 *
 * `requireAuth` answers 401 for anything but a valid access token whose session
 * is still active, and sets `req.auth = { userId, sessionId }`:
 * - UNAUTHENTICATED: no Authorization header, or not a Bearer one;
 * - TOKEN_EXPIRED / TOKEN_INVALID: from the token check (the client refreshes
 *   once on TOKEN_EXPIRED and signs the user out on anything else);
 * - SESSION_REVOKED: the token is genuine but its session was signed out.
 * Every 401 carries `WWW-Authenticate`. The token is never logged.
 *
 * `optionalAuth` does the same checks but never fails: it sets `req.auth` for
 * valid credentials and otherwise carries on without it. It is for operations
 * that work with or without a session, such as logout.
 *
 * @param {{tokens?: object, sessions?: object}} [deps] `tokens.verifyAccessToken` and `sessions.assertSessionActive`
 */
function createAuth({ tokens = defaultTokens, sessions = defaultSessions } = {}) {
  /** @returns {Promise<{userId: string, sessionId: string}|null>} null when no Bearer header was sent */
  async function authenticate(req) {
    const token = readBearerToken(req);
    if (token === null) return null;
    if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) throw tokenInvalid();
    const auth = await tokens.verifyAccessToken(token);
    await sessions.assertSessionActive(auth);
    return auth;
  }

  const requireAuth = asyncHandler(async (req, res, next) => {
    const auth = await authenticate(req);
    if (!auth) throw unauthenticated();
    req.auth = auth;
    next();
  });

  const optionalAuth = asyncHandler(async (req, res, next) => {
    try {
      const auth = await authenticate(req);
      if (auth) req.auth = auth;
    } catch (err) {
      // Only credential problems are ignored; a failing database is not hidden.
      if (!(err instanceof ApiError && err.status === 401)) throw err;
    }
    next();
  });

  return { requireAuth, optionalAuth };
}

module.exports = { createAuth, ...createAuth() };
