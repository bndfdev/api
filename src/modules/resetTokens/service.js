/**
 * Password-reset tokens: the proof, handed out when the code sent to an
 * account's email is accepted, that the person may set a new password.
 * POST /auth/password-reset/complete takes it once. No HTTP and no database
 * access: it works through `repo`, and the clock is injected.
 *
 * - The token is 32 random bytes; only its SHA-256 is stored.
 * - It is valid for 15 minutes (docs/api: `PasswordResetVerified`).
 * - It only works from the install that verified the code, and only once.
 * - Anything wrong with it is reported as "invalid", except a token that is
 *   simply too old, which is "expired".
 */
const { ApiError } = require('../../lib/problem');
const { randomToken, sha256 } = require('../../lib/secrets');
const defaultRepo = require('./repo');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The spec's number: "valid for 15 minutes" (PasswordResetVerified.resetToken). */
const RESET_TOKEN_TTL_MS = 15 * MINUTE;
// How long a token document outlives its expiry, so a late request still gets "expired" instead of "invalid". (An internal choice.)
const RETENTION_AFTER_EXPIRY_MS = HOUR;
// Marks the kind of token when someone reads it in a bug report.
const PREFIX = 'rst_';

const tokenInvalid = () => new ApiError({
  status: 401, code: 'RESET_TOKEN_INVALID', title: 'Reset link invalid',
  detail: 'Request a new password reset code to continue.',
});
const tokenExpired = () => new ApiError({
  status: 401, code: 'RESET_TOKEN_EXPIRED', title: 'Reset link expired',
  detail: 'Request a new password reset code to continue.',
});

/**
 * @param {{repo?: object, now?: () => number}} [deps] `now` returns epoch ms.
 */
function createResetTokenService({ repo = defaultRepo, now = Date.now } = {}) {
  // Whole seconds, so stored times match the ones returned.
  const clock = () => Math.floor(now() / SECOND) * SECOND;

  /**
   * Make a token for the account whose reset code was accepted.
   * @param {{userId: string, installationId: string}} input
   * @returns {Promise<{resetToken: string, expiresAt: number}>} `expiresAt` is epoch ms
   */
  async function issue({ userId, installationId }) {
    const at = clock();
    const resetToken = `${PREFIX}${randomToken()}`;
    await repo.insert({
      tokenHash: sha256(resetToken),
      userId,
      installationId,
      createdAt: new Date(at),
      expiresAt: new Date(at + RESET_TOKEN_TTL_MS),
      purgeAt: new Date(at + RESET_TOKEN_TTL_MS + RETENTION_AFTER_EXPIRY_MS),
    });
    return { resetToken, expiresAt: at + RESET_TOKEN_TTL_MS };
  }

  /**
   * Use a token. Throws 401 RESET_TOKEN_EXPIRED or RESET_TOKEN_INVALID (unknown, already used,
   * or from another install).
   * @param {{resetToken: unknown, installationId: string}} input
   * @returns {Promise<{userId: string, tokenHash: string}>} `tokenHash` is what `release` takes
   */
  async function consume({ resetToken, installationId }) {
    if (typeof resetToken !== 'string' || resetToken === '') throw tokenInvalid();
    const at = clock();
    const tokenHash = sha256(resetToken);
    const claimed = await repo.claim({ tokenHash, installationId, at: new Date(at) });
    if (claimed) return { userId: String(claimed.userId), tokenHash };

    // Not usable: find out whether it is merely too old. A token that belongs to another install, or was
    // already used, is "invalid" like an unknown one, so the answer tells nobody anything about it.
    const stored = await repo.findByHash(tokenHash);
    if (stored && stored.installationId === installationId && !stored.usedAt && stored.expiresAt.getTime() <= at) {
      throw tokenExpired();
    }
    throw tokenInvalid();
  }

  /** Give a token back after `consume`, when the request failed for a reason that is not the client's fault. */
  async function release(tokenHash) {
    await repo.unclaim(tokenHash);
  }

  return { issue, consume, release, tokenInvalid };
}

module.exports = { createResetTokenService, RESET_TOKEN_TTL_MS };
