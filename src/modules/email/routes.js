const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const { idempotency: defaultIdempotency } = require('../../middleware/idempotency');
const defaultReauth = require('../reauthTokens/check');
const { createChallengeService } = require('../challenges/service');
const { createEmailChangeService } = require('./service');

const DAY = 24 * 60 * 60;

// The limits in `x-rate-limit` of startEmailChange (docs/api/paths/me.yaml). The one per address (5 codes per
// 24 h) is the challenge service's (SEND_LIMIT_REACHED); this one is per account.
const LIMITS = Object.freeze({
  perAccount: { name: 'email-change:account', points: 10, durationSeconds: DAY, key: byUser },
});

/**
 * Changing the account's email (`docs/api/paths/me.yaml`: meEmailVerification). Account-only: guests get 403
 * GUEST_NOT_ALLOWED. Needs a fresh X-Reauth-Token (401 REAUTH_REQUIRED otherwise), checked before anything is
 * counted and used up only when the code is sent (202). The code is checked by POST /auth/challenges/{id}/verify
 * (auth module), with the owner's access token.
 * @param {{service?: object, auth?: {requireAuth: Function}, reauth?: {requireReauth: Function, giveBackOnError: Function},
 *   idempotency?: Function}} [deps]
 *   Without `service`, the real one is built when the first request arrives.
 */
function createEmailRouter({ service, auth = defaultAuth, reauth = defaultReauth, idempotency = defaultIdempotency } = {}) {
  const { requireAuth } = auth;
  let built = service;
  const svc = () => (built ??= createEmailChangeService({ challenges: createChallengeService() }));
  const router = express.Router();

  // POST /me/email/verification: sends the code to the new address; 202 with the challenge.
  router.post(
    '/me/email/verification',
    requireAuth,
    accountOnly,
    reauth.requireReauth,
    rateLimit(LIMITS.perAccount),
    idempotency,
    asyncHandler(async (req, res) => {
      const challenge = await svc().startChange({
        userId: req.auth.userId,
        email: req.body.email,
        installationId: req.get('x-installation-id'),
      });
      res.status(202).json(challenge);
    }),
  );
  // A request that failed after the reauth check gets its token back.
  router.use('/me/email/verification', reauth.giveBackOnError);

  return router;
}

module.exports = { createEmailRouter, router: createEmailRouter(), LIMITS };
