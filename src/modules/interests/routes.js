const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const defaultInterests = require('./service');

// The `x-rate-limit` of searchInterests (docs/api/paths/catalog.yaml): 120 a minute per account.
const SEARCH_LIMIT = Object.freeze({ name: 'interests-search:account', points: 120, durationSeconds: 60, key: byUser });

/**
 * Interests (`docs/api/paths/catalog.yaml`: interestsFeatured, interestsSearch, interest; `docs/api/paths/me.yaml`:
 * meInterests, meInterest). Every operation needs a session; guests may use all of them (the spec lets a guest
 * choose interests, which move to its account at sign-up).
 * @param {{interests?: object, auth?: {requireAuth: Function}, storeFactory?: Function}} [deps]
 *   `storeFactory` replaces the rate limiter's counter store (tests)
 */
function createInterestsRouter({ interests = defaultInterests, auth = defaultAuth, storeFactory } = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  // Personal data: never stored by shared caches.
  const privateCache = 'private, no-cache';
  const searchLimit = rateLimit({ ...SEARCH_LIMIT, ...(storeFactory ? { storeFactory } : {}) });

  // GET /interests/featured: the onboarding grid. Uses the viewer's country, when a CDN in front says it.
  router.get('/interests/featured', requireAuth, asyncHandler(async (req, res) => {
    res.json(await interests.featured({
      limit: req.query.limit,
      cursor: req.query.cursor,
      region: req.get('cloudfront-viewer-country') || req.get('cf-ipcountry'),
    }));
  }));

  // GET /interests/search: Search Interests, as the user types.
  router.get('/interests/search', requireAuth, searchLimit, asyncHandler(async (req, res) => {
    const { kind } = req.query;
    res.json(await interests.search({
      auth: req.auth,
      q: req.query.q,
      kinds: kind === undefined ? [] : [].concat(kind),
      sort: req.query.sort,
      limit: req.query.limit,
      cursor: req.query.cursor,
    }));
  }));

  // GET /interests/{interestId}
  router.get('/interests/:interestId', requireAuth, asyncHandler(async (req, res) => {
    res.json(await interests.getInterest(req.params.interestId));
  }));

  // GET /me/interests
  router.get('/me/interests', requireAuth, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await interests.getMine(req.auth));
  }));

  // PUT /me/interests: "Next" on Tell us what you're interested in. Replaces the whole selection.
  router.put('/me/interests', requireAuth, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await interests.replaceMine(req.auth, req.body.interestIds));
  }));

  // PUT /me/interests/{interestId}: follow one (idempotent).
  router.put('/me/interests/:interestId', requireAuth, asyncHandler(async (req, res) => {
    await interests.addMine(req.auth, req.params.interestId);
    res.status(204).end();
  }));

  // DELETE /me/interests/{interestId}: unfollow one (idempotent).
  router.delete('/me/interests/:interestId', requireAuth, asyncHandler(async (req, res) => {
    await interests.removeMine(req.auth, req.params.interestId);
    res.status(204).end();
  }));

  return router;
}

module.exports = { createInterestsRouter, SEARCH_LIMIT, router: createInterestsRouter() };
