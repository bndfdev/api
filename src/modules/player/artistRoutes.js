const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const defaultArtists = require('./artists');

/**
 * Each operation's `x-rate-limit` (docs/api/paths/artists.yaml), per account (a guest counts as one): the page 120
 * a minute, follow and unfollow 60 a minute (as the liked songs' heart). Each operation has its own counter.
 */
const LIMITS = Object.freeze({
  getArtist: { name: 'artist:account', points: 120, durationSeconds: 60, key: byUser },
  followArtist: { name: 'artist-follow:account', points: 60, durationSeconds: 60, key: byUser },
  unfollowArtist: { name: 'artist-unfollow:account', points: 60, durationSeconds: 60, key: byUser },
});

/**
 * Artist pages and following (`docs/api/paths/artists.yaml`, tag Artists). The page accepts a guest's token, as the
 * Player does; following is for accounts (a guest gets 403 GUEST_NOT_ALLOWED before the rate limit counts it). No
 * token is 401. Like the liked songs' heart, follow and unfollow take no `Idempotency-Key`: both are idempotent.
 * @param {{artists?: object, auth?: {requireAuth: Function}, storeFactory?: Function}} [deps] `storeFactory`
 *   replaces the rate limiters' counter store (tests)
 */
function createArtistRouter({ artists = defaultArtists, auth = defaultAuth, storeFactory } = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  const limit = Object.fromEntries(Object.entries(LIMITS)
    .map(([operation, rule]) => [operation, rateLimit({ ...rule, ...(storeFactory ? { storeFactory } : {}) })]));

  // `following` is the viewer's: never stored by shared caches.
  router.get('/artists/:artistId', requireAuth, limit.getArtist, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-cache').json(await artists.getArtist(req.auth, req.params.artistId));
  }));

  // The Follow button: idempotent both ways, 204 with no body.
  router.put('/me/following/artists/:artistId', requireAuth, accountOnly, limit.followArtist,
    asyncHandler(async (req, res) => {
      await artists.follow(req.auth, req.params.artistId);
      res.status(204).end();
    }));

  router.delete('/me/following/artists/:artistId', requireAuth, accountOnly, limit.unfollowArtist,
    asyncHandler(async (req, res) => {
      await artists.unfollow(req.auth, req.params.artistId);
      res.status(204).end();
    }));

  return router;
}

module.exports = { createArtistRouter, LIMITS, router: createArtistRouter() };
