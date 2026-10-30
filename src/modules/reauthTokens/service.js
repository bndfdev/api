/**
 * Re-authentication tokens: the proof, handed out by POST /auth/reauthenticate,
 * that the user has just confirmed who they are. A sensitive call takes it as
 * `X-Reauth-Token`. No HTTP and no database access: it works through `repo`,
 * and the clock is injected.
 *
 * - The token is 32 random bytes; only its SHA-256 is stored.
 * - It is valid for 5 minutes (docs/api: `ReauthToken`, `X-Reauth-Token`).
 * - It only works for the user and the session (signed-in device) it was issued to, and only once.
 * - Anything wrong with it (missing, unknown, expired, used, someone else's) is 401 REAUTH_REQUIRED:
 *   the spec's only code for it, and the app's cue to ask for the password again.
 */
const { ApiError } = require('../../lib/problem');
const { randomToken, sha256 } = require('../../lib/secrets');
const defaultRepo = require('./repo');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The spec's number: "valid 5 minutes" (ReauthToken.reauthToken, the X-Reauth-Token parameter). */
const REAUTH_TOKEN_TTL_MS = 5 * MINUTE;
// Marks the kind of token when someone reads it in a bug report.
const PREFIX = 'rat_';

const reauthRequired = () => new ApiError({
  status: 401, code: 'REAUTH_REQUIRED', title: 'Confirm it is you',
  detail: 'Enter your password again to continue.',
});

/**
 * @param {{repo?: object, now?: () => number}} [deps] `now` returns epoch ms.
 */
function createReauthTokenService({ repo = defaultRepo, now = Date.now } = {}) {
  // Whole seconds, so stored times match the ones returned.
  const clock = () => Math.floor(now() / SECOND) * SECOND;

  /**
   * Make a token for a user who has just re-authenticated in this session.
   * @param {{userId: string, sessionId: string}} input
   * @returns {Promise<{reauthToken: string, expiresAt: number}>} `expiresAt` is epoch ms
   */
  async function issue({ userId, sessionId }) {
    const at = clock();
    const reauthToken = `${PREFIX}${randomToken()}`;
    await repo.insert({
      tokenHash: sha256(reauthToken),
      userId,
      sessionId,
      createdAt: new Date(at),
      expiresAt: new Date(at + REAUTH_TOKEN_TTL_MS),
    });
    return { reauthToken, expiresAt: at + REAUTH_TOKEN_TTL_MS };
  }

  /**
   * Use a token. Throws 401 REAUTH_REQUIRED for anything but an unused, unexpired token of this user's session.
   * @param {{reauthToken: unknown, userId: string, sessionId: string}} input
   * @returns {Promise<{tokenHash: string}>} `tokenHash` is what `release` takes
   */
  async function consume({ reauthToken, userId, sessionId }) {
    if (typeof reauthToken !== 'string' || reauthToken === '') throw reauthRequired();
    const tokenHash = sha256(reauthToken);
    const claimed = await repo.claim({ tokenHash, userId, sessionId, at: new Date(clock()) });
    if (!claimed) throw reauthRequired();
    return { tokenHash };
  }

  /** Give a token back after `consume`, when the request failed for a reason that is not the client's fault. */
  async function release(tokenHash) {
    await repo.unclaim(tokenHash);
  }

  return { issue, consume, release };
}

module.exports = { createReauthTokenService, reauthRequired, REAUTH_TOKEN_TTL_MS };
