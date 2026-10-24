const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const { createCredentialsService } = require('./service');

/**
 * Re-authentication and password change (docs/api: `reauthenticate` in paths/auth.yaml, `mePassword` in
 * paths/me.yaml). Account-only: guests get 403 GUEST_NOT_ALLOWED. Mount on the /v1 router, after the spec
 * validator.
 *
 * Neither operation has an `x-rate-limit` or an `Idempotency-Key` in the spec, so there is no limiter and no
 * idempotency here: password guesses are limited by the login lock the service counts them against.
 * @param {{service?: object, auth?: {requireAuth: Function}}} [deps]
 *   Without `service`, the real one is built when the first request arrives (it needs the email provider from config).
 */
function createCredentialsRouter({ service, auth = defaultAuth } = {}) {
  const { requireAuth } = auth;
  let built = service;
  const svc = () => (built ??= createCredentialsService());
  const router = express.Router();

  // POST /auth/reauthenticate: 200 with a 5-minute reauthToken, which must never be cached.
  router.post('/auth/reauthenticate', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    const result = await svc().reauthenticate({ auth: req.auth, password: req.body.password, social: req.body.social });
    res.set('Cache-Control', 'no-store').json(result);
  }));

  // PUT /me/password: 204. This device stays signed in.
  router.put('/me/password', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    await svc().changePassword({
      auth: req.auth,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
      signOutOtherSessions: req.body.signOutOtherSessions,
      reauthToken: req.get('x-reauth-token'),
    });
    res.status(204).end();
  }));

  return router;
}

module.exports = { createCredentialsRouter, router: createCredentialsRouter() };
