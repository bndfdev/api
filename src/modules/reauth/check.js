/**
 * The `X-Reauth-Token` check for sensitive operations (docs/api: the ReauthToken parameter, `reauthenticate`,
 * and the operations that ask for it, such as startEmailChange). The token comes from POST /auth/reauthenticate,
 * proves that the user just entered their password again, and is valid for 5 minutes.
 *
 * A missing, invalid or expired token is 401 REAUTH_REQUIRED: the app asks for the password again and retries,
 * instead of signing the user out as it does for other 401s. A token is only good for the account (and session)
 * whose access token comes with it.
 *
 * TODO(merge with change-password): POST /auth/reauthenticate and its tokens are being built in the
 * change-password work. When it lands, make `verifyToken` below its real check (signature, 5-minute expiry, and
 * the user and session it was issued to). Until then no token is valid: every call that needs one gets
 * REAUTH_REQUIRED (fails closed), and tests inject a stand-in.
 */
const { ApiError } = require('../../lib/problem');
const { asyncHandler } = require('../../lib/asyncHandler');

// A real token is a few hundred bytes at most; anything this long is not worth checking.
const MAX_TOKEN_LENGTH = 4096;

const reauthRequired = () => new ApiError({
  status: 401, code: 'REAUTH_REQUIRED', title: 'Confirm your password',
  detail: 'Enter your password again to continue.',
});

/** No token can be issued yet (see the TODO above), so none is valid. */
async function noTokenIsValidYet() {
  return false;
}

/**
 * @param {{verifyToken?: (token: string, owner: {userId: string, sessionId: string}) => Promise<boolean>}} [deps]
 *   `verifyToken` resolves true only for a genuine, unexpired token issued to this user and session. It rejects
 *   only for failures that are not the token's fault (a database that is down), which are not hidden.
 */
function createReauthCheck({ verifyToken = noTokenIsValidYet } = {}) {
  /** Throws REAUTH_REQUIRED unless the request carries a valid reauth token for its signed-in user. Run after requireAuth. */
  async function assertReauth(req) {
    const token = req.get('x-reauth-token');
    if (!req.auth || typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) throw reauthRequired();
    const valid = await verifyToken(token, { userId: String(req.auth.userId), sessionId: String(req.auth.sessionId) });
    if (valid !== true) throw reauthRequired();
  }

  /** The same, as middleware. */
  const requireReauth = asyncHandler(async (req, res, next) => {
    await assertReauth(req);
    next();
  });

  return { assertReauth, requireReauth };
}

module.exports = { createReauthCheck, reauthRequired, ...createReauthCheck() };
