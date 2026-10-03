const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byIp, byInstallation } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const defaultService = require('./service');

// Only token refresh is rate limited. It is the one operation here whose spec lists a
// 429 response; logout is documented as always 204, and the session operations have no
// 429 in their spec either. Refresh has no `x-rate-limit` in docs/api/paths/auth.yaml,
// so the limits below are our own defaults. They sit well above what a real app does
// (one refresh per access token, about every 15 minutes) and exist to stop loops and
// guessing, not to throttle normal use. The per-IP limit is generous because many
// phones can share one address (mobile carriers, offices). Change them here.
const TEN_MINUTES = 10 * 60;
const LIMITS = Object.freeze({
  refreshPerInstallation: { name: 'token-refresh:installation', points: 30, durationSeconds: TEN_MINUTES, key: byInstallation },
  refreshPerIp: { name: 'token-refresh:ip', points: 1000, durationSeconds: TEN_MINUTES, key: byIp },
});

/**
 * Token refresh, logout and session management (`docs/api/paths/auth.yaml`:
 * tokenRefresh, logout; `me.yaml`: meSessions, meSession). Mount on the /v1
 * router, after the spec validator. Handlers only read the request, call the
 * service and send the answer.
 * @param {{service?: object, auth?: {requireAuth: Function, optionalAuth: Function}}} [deps]
 */
function createSessionsRouter({ service = defaultService, auth = defaultAuth } = {}) {
  const { requireAuth, optionalAuth } = auth;
  const router = express.Router();

  // POST /auth/token/refresh: no access token, the refresh token is the credential.
  router.post(
    '/auth/token/refresh',
    rateLimit(LIMITS.refreshPerIp),
    rateLimit(LIMITS.refreshPerInstallation),
    asyncHandler(async (req, res) => {
      const pair = await service.refresh({
        refreshToken: req.body.refreshToken,
        installationId: req.get('x-installation-id'),
      });
      res.set('Cache-Control', 'no-store');
      res.json(pair);
    }),
  );

  // POST /auth/logout: always 204, whatever state the credentials are in.
  router.post(
    '/auth/logout',
    optionalAuth,
    asyncHandler(async (req, res) => {
      await service.logout({ auth: req.auth, refreshToken: req.body && req.body.refreshToken });
      res.status(204).end();
    }),
  );

  // GET /me/sessions: the caller's devices, current first.
  // The device list is account-only (guests get 403 GUEST_NOT_ALLOWED); logout and refresh work for guests.
  router.get(
    '/me/sessions',
    requireAuth,
    accountOnly,
    asyncHandler(async (req, res) => {
      const list = await service.listSessions({ userId: req.auth.userId, currentSessionId: req.auth.sessionId });
      res.set('Cache-Control', 'no-store');
      res.json(list);
    }),
  );

  // DELETE /me/sessions: sign out every device except this one.
  router.delete(
    '/me/sessions',
    requireAuth,
    accountOnly,
    asyncHandler(async (req, res) => {
      await service.revokeAllOtherSessions({ userId: req.auth.userId, keepSessionId: req.auth.sessionId });
      res.status(204).end();
    }),
  );

  // DELETE /me/sessions/{sessionId}: sign out one device; 404 when it is not the caller's.
  router.delete(
    '/me/sessions/:sessionId',
    requireAuth,
    accountOnly,
    asyncHandler(async (req, res) => {
      await service.revokeSession({ userId: req.auth.userId, sessionId: req.params.sessionId });
      res.status(204).end();
    }),
  );

  return router;
}

module.exports = { createSessionsRouter, router: createSessionsRouter(), LIMITS };
