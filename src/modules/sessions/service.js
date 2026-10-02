/**
 * Session and refresh-token rules. No HTTP, no database access: it works through
 * `repo`, and the clock, config and logger are injected.
 *
 * Refresh tokens rotate and each works once. Presenting a used token again:
 * - from the same install, within the grace window: the same new pair is returned
 *   (it is kept AES-encrypted in a short-lived grace record), so a retried or
 *   racing refresh does not sign the user out;
 * - otherwise (after the window, or from another install): the whole session is
 *   revoked, because the token may have been stolen.
 */
const { config: defaultConfig } = require('../../config');
const { logger: defaultLogger } = require('../../lib/logger');
const { ApiError } = require('../../lib/problem');
const { randomToken, sha256, encrypt, decrypt } = require('../../lib/secrets');
const { createTokens } = require('../../lib/tokens');
const defaultRepo = require('./repo');

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
// Revoked sessions and their tokens stay this long, so a device that was signed
// out remotely still gets SESSION_REVOKED rather than "unknown token".
const REVOKED_RETENTION = 7 * DAY;
// A used refresh token is kept this long after use, to detect reuse.
const USED_TOKEN_RETENTION = 14 * DAY;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const isId = (value) => OBJECT_ID.test(String(value));

/** RFC 3339 UTC without milliseconds. */
const iso = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');

const refreshTokenInvalid = () => new ApiError({
  status: 401, code: 'REFRESH_TOKEN_INVALID', title: 'Refresh token invalid',
  detail: 'The refresh token is not valid. Sign in again.',
});
const refreshTokenReused = () => new ApiError({
  status: 401, code: 'REFRESH_TOKEN_REUSED', title: 'Refresh token reused',
  detail: 'This refresh token was already used, so the session was ended. Sign in again.',
});
// `challenge`: also tell the client which scheme failed (for a request that carried a Bearer token).
const sessionRevoked = ({ challenge = false } = {}) => new ApiError({
  status: 401, code: 'SESSION_REVOKED', title: 'Session revoked',
  detail: 'This session was signed out. Sign in again.',
  headers: challenge ? { 'WWW-Authenticate': 'Bearer error="invalid_token"' } : undefined,
});
const accountSuspended = () => new ApiError({
  status: 403, code: 'ACCOUNT_SUSPENDED', title: 'Account suspended',
});
const sessionNotFound = () => new ApiError({
  status: 404, code: 'SESSION_NOT_FOUND', title: 'Session not found',
});

/** `SessionInfo` from docs/api (components/schemas.yaml). */
function toSessionInfo(session, currentSessionId) {
  const device = {};
  for (const key of ['platform', 'model', 'appVersion']) {
    if (session.device && session.device[key] !== undefined) device[key] = session.device[key];
  }
  return {
    id: String(session._id),
    createdAt: iso(session.createdAt),
    lastActiveAt: iso(session.lastActiveAt),
    current: String(session._id) === String(currentSessionId),
    signInMethod: session.signInMethod,
    device,
  };
}

/**
 * @param {{repo?: object, config?: object, now?: () => number, tokens?: object, logger?: object}} [deps]
 *   `now` returns epoch ms. The access-token signer shares it unless `tokens` is given.
 */
function createSessionService({
  repo = defaultRepo,
  config = defaultConfig,
  now = Date.now,
  tokens = createTokens({ jwt: config.jwt, now }),
  logger = defaultLogger,
} = {}) {
  // Whole seconds, so stored times match the ones inside access tokens.
  const clock = () => Math.floor(now() / SECOND) * SECOND;
  const refreshTtl = config.refreshToken.ttlDays * DAY;
  const graceWindow = config.refreshToken.graceSeconds * SECOND;

  /** Sign an access token and mint a refresh token; nothing is stored yet. */
  async function mintPair({ userId, sessionId, at }) {
    const access = await tokens.signAccessToken({ userId, sessionId });
    const refreshToken = randomToken();
    const refreshExpiresAt = new Date(at + refreshTtl);
    const pair = {
      tokenType: 'Bearer',
      accessToken: access.token,
      accessTokenExpiresAt: iso(access.expiresAt),
      refreshToken,
      refreshTokenExpiresAt: iso(refreshExpiresAt),
    };
    return { pair, refreshHash: sha256(refreshToken), refreshExpiresAt };
  }

  /**
   * Start a session for a user who has just proven who they are.
   * @param {{userId: string, signInMethod: string, device: {platform?: string, model?: string, appVersion?: string}, installationId: string}} input
   * @returns {Promise<{tokens: object, session: object}>} `TokenPair` and `SessionInfo`
   */
  async function createSession({ userId, signInMethod, device, installationId }) {
    const at = clock();
    const sessionId = repo.newId();
    const minted = await mintPair({ userId, sessionId, at });
    // The token goes first: a stray token without a session can never be used.
    await repo.insertRefreshToken({
      tokenHash: minted.refreshHash,
      sessionId,
      userId,
      expiresAt: minted.refreshExpiresAt,
    });
    const session = await repo.insertSession({
      _id: sessionId,
      userId,
      signInMethod,
      device,
      installationId,
      createdAt: new Date(at),
      lastActiveAt: new Date(at),
      expiresAt: minted.refreshExpiresAt,
    });
    return { tokens: minted.pair, session: toSessionInfo(session, sessionId) };
  }

  async function assertUserMayRefresh(userId, at) {
    const user = await repo.findUserBlockStatus(userId);
    if (!user) throw refreshTokenInvalid();
    const blocked = user.isBlocked && (!user.blockedUntil || user.blockedUntil.getTime() > at);
    if (blocked) throw accountSuspended();
  }

  /** Handle a refresh token that was already used: replay inside the grace window, else revoke. */
  async function replayOrRevoke({ stored, session, installationId, at }) {
    const grace = await repo.findGrace(stored.tokenHash);
    const sameInstall = installationId === session.installationId;
    const inWindow = Boolean(grace) && at <= grace.graceUntil.getTime();
    let why;
    if (!sameInstall) why = 'used refresh token presented from another install';
    else if (!inWindow) why = 'refresh token reused after the grace window';
    else {
      try {
        return JSON.parse(decrypt(grace.cipher, { key: config.tokenEncKey, aad: stored.tokenHash }));
      } catch {
        // Unreadable (for example the key was rotated): fail closed, as for any reuse.
        why = 'refresh grace data unreadable';
      }
    }
    logger.warn({ userId: String(stored.userId), sessionId: String(session._id) }, `${why}: session revoked`);
    await repo.revokeSession(session._id, {
      reason: 'refresh_token_reused',
      at: new Date(at),
      retainUntil: new Date(at + REVOKED_RETENTION),
    });
    throw refreshTokenReused();
  }

  /**
   * Swap a refresh token for a new token pair (see the module comment).
   * @param {{refreshToken: string, installationId: string}} input
   * @returns {Promise<object>} `TokenPair`
   */
  async function refresh({ refreshToken, installationId }) {
    const at = clock();
    if (typeof refreshToken !== 'string' || refreshToken === '') throw refreshTokenInvalid();
    const tokenHash = sha256(refreshToken);

    const stored = await repo.findRefreshToken(tokenHash);
    if (!stored || stored.expiresAt.getTime() <= at) throw refreshTokenInvalid();
    const session = await repo.findSession(stored.sessionId);
    if (!session) throw refreshTokenInvalid();
    if (session.revokedAt) throw sessionRevoked();
    await assertUserMayRefresh(stored.userId, at);

    if (stored.usedAt) return replayOrRevoke({ stored, session, installationId, at });
    // An unused token from another install is refused but not treated as theft:
    // the real device still holds the token and keeps working.
    if (installationId !== session.installationId) {
      logger.warn({ userId: String(stored.userId), sessionId: String(session._id) }, 'refresh refused: installation mismatch');
      throw refreshTokenInvalid();
    }

    const minted = await mintPair({ userId: String(stored.userId), sessionId: String(stored.sessionId), at });
    await repo.insertRefreshToken({
      tokenHash: minted.refreshHash,
      sessionId: stored.sessionId,
      userId: stored.userId,
      expiresAt: minted.refreshExpiresAt,
    });

    // Rotating takes two steps. First the grace record is reserved (unique per
    // old token): the one parallel refresh that gets it is the winner, and the
    // others answer from its record. Then the old token is claimed atomically.
    const reserved = await repo.insertGrace({
      tokenHash,
      sessionId: stored.sessionId,
      graceUntil: new Date(at + graceWindow),
      cipher: encrypt(JSON.stringify(minted.pair), { key: config.tokenEncKey, aad: tokenHash }),
    });
    if (!reserved) {
      await repo.deleteRefreshToken(minted.refreshHash);
      return replayOrRevoke({ stored, session, installationId, at });
    }
    const claimed = await repo.claimRefreshToken({
      tokenHash,
      usedAt: new Date(at),
      replacedByHash: minted.refreshHash,
      retainUntil: new Date(at + USED_TOKEN_RETENTION),
    });
    if (!claimed) {
      // Someone else used the token in the meantime: undo ours, then treat it as reuse.
      await Promise.all([repo.deleteRefreshToken(minted.refreshHash), repo.deleteGrace(tokenHash)]);
      return replayOrRevoke({ stored, session, installationId, at });
    }

    await repo.touchSession(stored.sessionId, { lastActiveAt: new Date(at), expiresAt: minted.refreshExpiresAt });
    return minted.pair;
  }

  /**
   * Check that the session named in a valid access token is still usable (used
   * by requireAuth on every authenticated request). One indexed read by id.
   * Throws 401 SESSION_REVOKED when the session was signed out, has expired or
   * no longer exists: the client signs the user out in every one of those cases.
   * @param {{userId: string, sessionId: string}} input
   */
  async function assertSessionActive({ userId, sessionId }) {
    if (!isId(userId) || !isId(sessionId)) throw sessionRevoked({ challenge: true });
    const session = await repo.findSessionState(userId, sessionId);
    if (!session || session.revokedAt || session.expiresAt.getTime() <= clock()) {
      throw sessionRevoked({ challenge: true });
    }
  }

  /**
   * Sign out one of the user's sessions (idempotent). 404 SESSION_NOT_FOUND when
   * it does not exist or belongs to someone else.
   * @param {{userId: string, sessionId: string, reason?: string}} input
   */
  async function revokeSession({ userId, sessionId, reason = 'user_revoked' }) {
    if (!isId(userId) || !isId(sessionId)) throw sessionNotFound();
    const session = await repo.findUserSession(userId, sessionId);
    if (!session) throw sessionNotFound();
    const at = clock();
    await repo.revokeSession(session._id, { reason, at: new Date(at), retainUntil: new Date(at + REVOKED_RETENTION) });
  }

  /**
   * Sign out every session of the user except `keepSessionId`. A missing or
   * malformed `keepSessionId` is a bug in the caller and throws, so a bad id can
   * never sign out everything.
   * @param {{userId: string, keepSessionId: string, reason?: string}} input
   */
  async function revokeAllOtherSessions({ userId, keepSessionId, reason = 'other_sessions_revoked' }) {
    if (!isId(keepSessionId)) throw new Error('revokeAllOtherSessions needs a valid keepSessionId');
    if (!isId(userId)) return;
    const at = clock();
    await repo.revokeUserSessionsExcept(userId, keepSessionId, {
      reason, at: new Date(at), retainUntil: new Date(at + REVOKED_RETENTION),
    });
  }

  /**
   * Sign out the session a refresh token belongs to (for logout). Idempotent: an
   * unknown token is not an error. With `userId`, a token of another user is ignored.
   * @param {{refreshToken: string, userId?: string, reason?: string}} input
   * @returns {Promise<boolean>} whether a session was revoked by this call
   */
  async function revokeByRefreshToken({ refreshToken, userId, reason = 'logout' }) {
    if (typeof refreshToken !== 'string' || refreshToken === '') return false;
    if (userId !== undefined && !isId(userId)) return false;
    const at = clock();
    const revoked = await repo.revokeByRefreshTokenHash(sha256(refreshToken), {
      userId, reason, at: new Date(at), retainUntil: new Date(at + REVOKED_RETENTION),
    });
    return revoked > 0;
  }

  /**
   * Log out (idempotent, never fails because of the credentials it is given).
   * Ends the session of a verified access token and/or the session a refresh
   * token belongs to. When both are given the refresh token must be the same
   * user's. Unknown, expired or already-revoked credentials are ignored.
   * @param {{auth?: {userId: string, sessionId: string}, refreshToken?: string}} input
   */
  async function logout({ auth, refreshToken } = {}) {
    if (auth) {
      try {
        await revokeSession({ userId: auth.userId, sessionId: auth.sessionId, reason: 'logout' });
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'SESSION_NOT_FOUND')) throw err;
      }
    }
    await revokeByRefreshToken({ refreshToken, userId: auth ? auth.userId : undefined, reason: 'logout' });
  }

  /**
   * The user's active sessions, current first, then most recently active.
   * @param {{userId: string, currentSessionId?: string}} input
   * @returns {Promise<{data: object[]}>} `SessionList`
   */
  async function listSessions({ userId, currentSessionId }) {
    if (!isId(userId)) return { data: [] };
    const sessions = await repo.listActiveSessions(userId, new Date(clock()));
    const data = sessions.map((s) => toSessionInfo(s, currentSessionId));
    data.sort((a, b) => Number(b.current) - Number(a.current));
    return { data };
  }

  return {
    createSession,
    refresh,
    assertSessionActive,
    revokeSession,
    revokeAllOtherSessions,
    revokeByRefreshToken,
    logout,
    listSessions,
  };
}

module.exports = { createSessionService, ...createSessionService() };
