const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const defaultService = require('./service');

/**
 * Notification switches (`docs/api/paths/me.yaml`: meNotificationSettings). Account-only: guests get 403
 * GUEST_NOT_ALLOWED. Neither operation has an `x-rate-limit` in the spec, so there is no limiter (as at PATCH /me).
 * @param {{service?: object, auth?: {requireAuth: Function}}} [deps]
 */
function createNotificationSettingsRouter({ service = defaultService, auth = defaultAuth } = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  // Personal data: never stored by shared caches.
  const privateCache = 'private, no-cache';

  // GET /me/notification-settings
  router.get('/me/notification-settings', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await service.get(req.auth));
  }));

  // PATCH /me/notification-settings: one switch at a time from the Notifications screen.
  router.patch('/me/notification-settings', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await service.update(req.auth, req.body));
  }));

  return router;
}

module.exports = { createNotificationSettingsRouter, router: createNotificationSettingsRouter() };
