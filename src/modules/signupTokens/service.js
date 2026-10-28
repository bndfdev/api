/**
 * Sign-up tokens: the proof, handed out when the code sent to an email address
 * is accepted, that the address was verified. POST /auth/signup/complete takes
 * it once. No HTTP and no database access: it works through `repo`, and the
 * clock is injected.
 *
 * - The token is 32 random bytes; only its SHA-256 is stored.
 * - It is valid for 30 minutes (docs/api: `SignupEmailVerified`).
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

/** The spec's number: "Only valid for POST /auth/signup/complete, for 30 minutes". */
const SIGNUP_TOKEN_TTL_MS = 30 * MINUTE;
// How long a token document outlives its expiry, so a late request still gets "expired" instead of "invalid". (An internal choice.)
const RETENTION_AFTER_EXPIRY_MS = HOUR;
// Marks the kind of token when someone reads it in a bug report; the spec's examples use it too.
const PREFIX = 'sgt_';

const tokenInvalid = () => new ApiError({
  status: 401, code: 'SIGNUP_TOKEN_INVALID', title: 'Sign-up link invalid',
  detail: 'Verify your email address again to continue.',
});
const tokenExpired = () => new ApiError({
  status: 401, code: 'SIGNUP_TOKEN_EXPIRED', title: 'Sign-up link expired',
  detail: 'Verify your email address again to continue.',
});

/**
 * @param {{repo?: object, now?: () => number}} [deps] `now` returns epoch ms.
 */
function createSignupTokenService({ repo = defaultRepo, now = Date.now } = {}) {
  // Whole seconds, so stored times match the ones returned.
  const clock = () => Math.floor(now() / SECOND) * SECOND;

  /**
   * Make a token for a verified address.
   * @param {{email: string, installationId: string}} input `email` is the normalised address
   * @returns {Promise<{signupToken: string, expiresAt: number}>} `expiresAt` is epoch ms
   */
  async function issue({ email, installationId }) {
    const at = clock();
    const signupToken = `${PREFIX}${randomToken()}`;
    await repo.insert({
      tokenHash: sha256(signupToken),
      email,
      installationId,
      createdAt: new Date(at),
      expiresAt: new Date(at + SIGNUP_TOKEN_TTL_MS),
      purgeAt: new Date(at + SIGNUP_TOKEN_TTL_MS + RETENTION_AFTER_EXPIRY_MS),
    });
    return { signupToken, expiresAt: at + SIGNUP_TOKEN_TTL_MS };
  }

  /**
   * Use a token. Throws 401 SIGNUP_TOKEN_EXPIRED or SIGNUP_TOKEN_INVALID (unknown, already used,
   * or from another install).
   * @param {{signupToken: unknown, installationId: string}} input
   * @returns {Promise<{email: string, tokenHash: string}>} `tokenHash` is what `release` takes
   */
  async function consume({ signupToken, installationId }) {
    if (typeof signupToken !== 'string' || signupToken === '') throw tokenInvalid();
    const at = clock();
    const tokenHash = sha256(signupToken);
    const claimed = await repo.claim({ tokenHash, installationId, at: new Date(at) });
    if (claimed) return { email: claimed.email, tokenHash };

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

  return { issue, consume, release };
}

module.exports = { createSignupTokenService };
