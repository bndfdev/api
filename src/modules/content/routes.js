const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const defaultContent = require('./service');

// The `x-rate-limit` of listMyContent (docs/api/paths/me.yaml): 120 a minute per account, as for interest search.
const LIST_LIMIT = Object.freeze({ name: 'content-list:account', points: 120, durationSeconds: 60, key: byUser });

/**
 * The user's own content (`docs/api/paths/me.yaml`: meContent, meContentItem). Account-only: guests get 403
 * GUEST_NOT_ALLOWED. updateMyContent has no `x-rate-limit` in the spec, so it has no limiter.
 * @param {{content?: object, auth?: {requireAuth: Function}, storeFactory?: Function}} [deps]
 *   `storeFactory` replaces the rate limiter's counter store (tests)
 */
function createContentRouter({ content = defaultContent, auth = defaultAuth, storeFactory } = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  // Personal data: never stored by shared caches.
  const privateCache = 'private, no-cache';
  const listLimit = rateLimit({ ...LIST_LIMIT, ...(storeFactory ? { storeFactory } : {}) });

  // GET /me/content: the Profile tabs and Popular Releases (sort=popular&limit=3), both with hidden=false, and the
  // Privacy lists (no hidden filter).
  router.get('/me/content', requireAuth, accountOnly, listLimit, asyncHandler(async (req, res) => {
    // The validator has checked `hidden` is a boolean; it may still arrive as its text.
    const { hidden } = req.query;
    res.set('Cache-Control', privateCache).json(await content.list(req.auth, {
      type: req.query.type,
      hidden: hidden === undefined ? undefined : hidden === true || hidden === 'true',
      sort: req.query.sort,
      limit: req.query.limit,
      cursor: req.query.cursor,
    }));
  }));

  // PATCH /me/content/{contentId}: Hide Content and Restrict Content.
  router.patch('/me/content/:contentId', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await content.update(req.auth, req.params.contentId, req.body));
  }));

  return router;
}

module.exports = { createContentRouter, LIST_LIMIT, router: createContentRouter() };
