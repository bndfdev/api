/**
 * The `X-Reauth-Token` check for operations that take it as a header (docs/api: the ReauthToken parameter, and the
 * operations that ask for it, such as startEmailChange). The token comes from POST /auth/reauthenticate and is
 * checked by ./service.js: valid 5 minutes, only for the user and session it was issued to, and only once.
 *
 * - Anything wrong with it (missing, unknown, expired, used, another user's or another session's) is
 *   401 REAUTH_REQUIRED, without `WWW-Authenticate`: the access token is fine, so the app asks for the password
 *   again instead of signing the user out.
 * - `requireReauth` uses the token up before the rest of the route runs, so a refused request counts against no
 *   limit and two requests can never both use one token.
 * - `giveBackOnError`, mounted after the route, gives the token back when the request then fails (a wrong address, a
 *   limit, a mail server that is down): a token is only used up by a request that did what it asked, as a weak
 *   password does not use one up at PUT /me/password.
 */
const { asyncHandler } = require('../../lib/asyncHandler');
const { logger: defaultLogger } = require('../../lib/logger');
const { createReauthTokenService, reauthRequired } = require('./service');

/**
 * @param {{tokens?: object, logger?: object}} [deps] `tokens` is a reauth token service (`consume`, `release`).
 */
function createReauthCheck({ tokens = createReauthTokenService(), logger = defaultLogger } = {}) {
  /** Uses up this request's reauth token, or throws REAUTH_REQUIRED. Run after requireAuth. */
  const requireReauth = asyncHandler(async (req, res, next) => {
    if (!req.auth) throw reauthRequired();
    const { tokenHash } = await tokens.consume({
      reauthToken: req.get('x-reauth-token'),
      userId: String(req.auth.userId),
      sessionId: String(req.auth.sessionId),
    });
    req.reauthTokenHash = tokenHash;
    next();
  });

  /** Error middleware: gives the token `requireReauth` used up back, then passes the error on. */
  function giveBackOnError(err, req, res, next) {
    const tokenHash = req.reauthTokenHash;
    if (!tokenHash) return next(err);
    req.reauthTokenHash = undefined;
    tokens.release(tokenHash)
      .catch((releaseErr) => logger.warn({ err: releaseErr && releaseErr.name }, 'could not give a reauth token back'))
      .finally(() => next(err));
  }

  return { requireReauth, giveBackOnError };
}

module.exports = { createReauthCheck, ...createReauthCheck() };
