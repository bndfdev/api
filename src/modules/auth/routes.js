const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byIp, byInstallation } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { idempotency: defaultIdempotency, scopeToInstallation } = require('../../middleware/idempotency');
const { createAuthService } = require('./service');

const HOUR = 60 * 60;

// The limits are the ones in `x-rate-limit` of each operation in docs/api/paths/auth.yaml. Those that
// the spec lists per email, challenge or destination are not here: the challenge service enforces them
// (5 codes per address per 24 h: SEND_LIMIT_REACHED; 1 resend per 30 s: RESEND_TOO_SOON; 5 guesses per
// code: CHALLENGE_LOCKED), and the login lockout (5 failures per account per 15 minutes) is the auth
// service's. What is left is by IP address and by install.
const LIMITS = Object.freeze({
  availabilityPerIp: { name: 'email-availability:ip', points: 30, durationSeconds: HOUR, key: byIp },
  availabilityPerInstallation: { name: 'email-availability:installation', points: 20, durationSeconds: HOUR, key: byInstallation },
  signupStartPerIp: { name: 'signup-email:ip', points: 20, durationSeconds: HOUR, key: byIp },
  signupStartPerInstallation: { name: 'signup-email:installation', points: 10, durationSeconds: HOUR, key: byInstallation },
  verifyPerIp: { name: 'challenge-verify:ip', points: 60, durationSeconds: HOUR, key: byIp },
  loginPerIp: { name: 'login:ip', points: 50, durationSeconds: HOUR, key: byIp },
  passwordResetPerIp: { name: 'password-reset:ip', points: 20, durationSeconds: HOUR, key: byIp },
  guestPerIp: { name: 'guest:ip', points: 20, durationSeconds: HOUR, key: byIp },
});

/**
 * Email sign-up, login and password reset (`docs/api/paths/auth.yaml`: emailAvailability, signupEmail,
 * challenge, challengeResend, challengeVerify, signupComplete, login, passwordResetStart,
 * passwordResetComplete). Mount on the /v1 router, after the spec validator. Handlers only read the
 * request, call the service and send the answer.
 *
 * The old `/user/*` routes (routes/user.js) are still mounted: the app uses them until it moves to these
 * endpoints. They are removed in a later cleanup PR, not here.
 * @param {{service?: object, auth?: {optionalAuth: Function, authIfSent: Function}, idempotency?: Function}} [deps]
 *   Without `service`, the real one is built when the first request arrives (it needs the email provider from config).
 */
function createAuthRouter({ service, auth = defaultAuth, idempotency = defaultIdempotency } = {}) {
  const { optionalAuth, authIfSent } = auth;
  let built = service;
  const svc = () => (built ??= createAuthService());
  const router = express.Router();
  const installationId = (req) => req.get('x-installation-id');
  // Responses that carry tokens must never be cached.
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  // POST /auth/email/availability
  router.post(
    '/auth/email/availability',
    rateLimit(LIMITS.availabilityPerIp),
    rateLimit(LIMITS.availabilityPerInstallation),
    asyncHandler(async (req, res) => {
      res.json(await svc().checkEmailAvailability({ email: req.body.email }));
    }),
  );

  // POST /auth/signup/email: sends the code; 202 with the challenge.
  router.post(
    '/auth/signup/email',
    rateLimit(LIMITS.signupStartPerIp),
    rateLimit(LIMITS.signupStartPerInstallation),
    idempotency,
    asyncHandler(async (req, res) => {
      const challenge = await svc().startEmailSignup({ email: req.body.email, installationId: installationId(req) });
      res.status(202).json(challenge);
    }),
  );

  // GET /auth/challenges/{challengeId}: public for sign-up and reset codes; a phone code needs its owner's token.
  router.get(
    '/auth/challenges/:challengeId',
    optionalAuth,
    asyncHandler(async (req, res) => {
      const challenge = await svc().getChallenge({
        challengeId: req.params.challengeId,
        installationId: installationId(req),
        userId: req.auth && req.auth.userId,
      });
      res.json(challenge);
    }),
  );

  // POST /auth/challenges/{challengeId}/resend
  router.post(
    '/auth/challenges/:challengeId/resend',
    optionalAuth,
    idempotency,
    asyncHandler(async (req, res) => {
      const challenge = await svc().resendChallenge({
        challengeId: req.params.challengeId,
        installationId: installationId(req),
        userId: req.auth && req.auth.userId,
      });
      res.status(202).json(challenge);
    }),
  );

  // POST /auth/challenges/{challengeId}/verify
  router.post(
    '/auth/challenges/:challengeId/verify',
    optionalAuth,
    rateLimit(LIMITS.verifyPerIp),
    asyncHandler(async (req, res) => {
      const result = await svc().verifyChallenge({
        challengeId: req.params.challengeId,
        code: req.body.code,
        installationId: installationId(req),
        userId: req.auth && req.auth.userId,
      });
      noStore(res).json(result);
    }),
  );

  // POST /auth/signup/complete: creates the account; 201 with the session. With a guest's token the guest
  // becomes the account (an expired one is refused, so the guest is never silently left behind). A repeat
  // is keyed by the install: the guest session this ends cannot sign it.
  router.post(
    '/auth/signup/complete',
    authIfSent,
    scopeToInstallation,
    idempotency,
    asyncHandler(async (req, res) => {
      const session = await svc().completeSignup({
        signupToken: req.body.signupToken,
        password: req.body.password,
        device: req.body.device,
        preferredLanguage: req.body.preferredLanguage,
        installationId: installationId(req),
        auth: req.auth,
      });
      noStore(res).status(201).json(session);
    }),
  );

  // POST /auth/login
  router.post(
    '/auth/login',
    rateLimit(LIMITS.loginPerIp),
    asyncHandler(async (req, res) => {
      const session = await svc().login({
        email: req.body.email,
        password: req.body.password,
        device: req.body.device,
        installationId: installationId(req),
      });
      noStore(res).json(session);
    }),
  );

  // POST /auth/guest: 201 with a new guest's session, or 200 with this install's existing guest.
  router.post(
    '/auth/guest',
    rateLimit(LIMITS.guestPerIp),
    asyncHandler(async (req, res) => {
      const { session, created } = await svc().startGuestSession({
        device: req.body.device,
        dateOfBirth: req.body.dateOfBirth,
        preferredLanguage: req.body.preferredLanguage,
        installationId: installationId(req),
      });
      noStore(res).status(created ? 201 : 200).json(session);
    }),
  );

  // POST /auth/password-reset: always 202 with a challenge, whether or not the email has an account.
  router.post(
    '/auth/password-reset',
    rateLimit(LIMITS.passwordResetPerIp),
    idempotency,
    asyncHandler(async (req, res) => {
      const challenge = await svc().startPasswordReset({ email: req.body.email, installationId: installationId(req) });
      res.status(202).json(challenge);
    }),
  );

  // POST /auth/password-reset/complete: new password, every other device signed out; 200 with the session.
  router.post(
    '/auth/password-reset/complete',
    idempotency,
    asyncHandler(async (req, res) => {
      const session = await svc().completePasswordReset({
        resetToken: req.body.resetToken,
        newPassword: req.body.newPassword,
        device: req.body.device,
        installationId: installationId(req),
      });
      noStore(res).json(session);
    }),
  );

  return router;
}

module.exports = { createAuthRouter, router: createAuthRouter(), LIMITS };
