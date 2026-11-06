const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const defaultService = require('./service');

/**
 * The Profile's hand-picked items (`docs/api/paths/me.yaml`: meHandPicked). Account-only, as `/me/content`: guests
 * get 403 GUEST_NOT_ALLOWED. Neither operation has an `x-rate-limit` or an `Idempotency-Key` in the spec (PUT
 * replaces the whole list, so a retry is harmless), so there is no limiter.
 * @param {{service?: object, auth?: {requireAuth: Function}}} [deps]
 */
function createHandPickedRouter({ service = defaultService, auth = defaultAuth } = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  // Personal data: never stored by shared caches.
  const privateCache = 'private, no-cache';

  // GET /me/hand-picked: the "Hand-picked by <name>" section of the Profile.
  router.get('/me/hand-picked', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await service.get(req.auth));
  }));

  // PUT /me/hand-picked: add or remove (the menu on a content row) and drag to reorder all send the whole list.
  router.put('/me/hand-picked', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await service.replace(req.auth, req.body));
  }));

  return router;
}

module.exports = { createHandPickedRouter, router: createHandPickedRouter() };
