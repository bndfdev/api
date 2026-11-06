const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { callingCodeOf } = require('../../lib/phone');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const { idempotency: defaultIdempotency } = require('../../middleware/idempotency');
const { createChallengeService } = require('../challenges/service');
const { createPhoneService } = require('./service');

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

// The limits in `x-rate-limit` of startPhoneVerification (docs/api/paths/me.yaml). The one per phone number
// (5 codes per 24 h) is the challenge service's (SEND_LIMIT_REACHED); these are per account and per country
// calling code (a cap on SMS spend if someone sprays numbers of one country).
const LIMITS = Object.freeze({
  perAccount: { name: 'phone-verification:account', points: 10, durationSeconds: DAY, key: byUser },
  perCountryCode: {
    name: 'phone-verification:country-code',
    points: 1000,
    durationSeconds: HOUR,
    key: (req) => callingCodeOf(req.body && req.body.phoneNumber) || undefined,
  },
});

/**
 * The account's phone number (`docs/api/paths/me.yaml`: mePhoneVerification, mePhone). Account-only:
 * guests get 403 GUEST_NOT_ALLOWED. The code is checked by POST /auth/challenges/{id}/verify (auth module),
 * with the owner's access token.
 * @param {{service?: object, auth?: {requireAuth: Function}, idempotency?: Function}} [deps]
 *   Without `service`, the real one is built when the first request arrives.
 */
function createPhoneRouter({ service, auth = defaultAuth, idempotency = defaultIdempotency } = {}) {
  const { requireAuth } = auth;
  let built = service;
  const svc = () => (built ??= createPhoneService({ challenges: createChallengeService() }));
  const router = express.Router();

  // POST /me/phone/verification: sends the SMS code; 202 with the challenge.
  router.post(
    '/me/phone/verification',
    requireAuth,
    accountOnly,
    rateLimit(LIMITS.perAccount),
    rateLimit(LIMITS.perCountryCode),
    idempotency,
    asyncHandler(async (req, res) => {
      const challenge = await svc().startVerification({
        userId: req.auth.userId,
        phoneNumber: req.body.phoneNumber,
        installationId: req.get('x-installation-id'),
      });
      res.status(202).json(challenge);
    }),
  );

  // DELETE /me/phone: idempotent.
  router.delete(
    '/me/phone',
    requireAuth,
    accountOnly,
    asyncHandler(async (req, res) => {
      await svc().removePhone({ userId: req.auth.userId });
      res.status(204).end();
    }),
  );

  return router;
}

module.exports = { createPhoneRouter, router: createPhoneRouter(), LIMITS };
