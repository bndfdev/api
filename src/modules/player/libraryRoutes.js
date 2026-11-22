const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const defaultLibrary = require('./library');

/**
 * Each operation's `x-rate-limit` (docs/api/paths/library.yaml), per account: reads 120 a minute, likes and
 * playlist sets 60 a minute. Each operation has its own counter.
 */
const LIMITS = Object.freeze({
  listLikedSongs: { name: 'library-liked-songs:account', points: 120, durationSeconds: 60, key: byUser },
  likeSong: { name: 'library-like:account', points: 60, durationSeconds: 60, key: byUser },
  unlikeSong: { name: 'library-unlike:account', points: 60, durationSeconds: 60, key: byUser },
  listLibraryPlaylists: { name: 'library-playlists:account', points: 120, durationSeconds: 60, key: byUser },
  getSongLibraryState: { name: 'library-song:account', points: 120, durationSeconds: 60, key: byUser },
  setSongPlaylists: { name: 'library-song-playlists:account', points: 60, durationSeconds: 60, key: byUser },
});

/**
 * The listener's library (`docs/api/paths/library.yaml`, tag Library). Accounts only: a guest's token gets 403
 * GUEST_NOT_ALLOWED (before the rate limit counts it); no token is 401.
 * @param {{library?: object, auth?: {requireAuth: Function}, storeFactory?: Function}} [deps] `storeFactory`
 *   replaces the rate limiters' counter store (tests)
 */
function createLibraryRouter({ library = defaultLibrary, auth = defaultAuth, storeFactory } = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  const limit = Object.fromEntries(Object.entries(LIMITS)
    .map(([operation, rule]) => [operation, rateLimit({ ...rule, ...(storeFactory ? { storeFactory } : {}) })]));
  // The viewer's own library: never stored by shared caches.
  const privateCache = 'private, no-cache';

  router.get('/me/liked-songs', requireAuth, accountOnly, limit.listLikedSongs, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await library.listLikedSongs(req.auth, {
      limit: req.query.limit,
      cursor: req.query.cursor,
    }));
  }));

  // The heart: idempotent both ways, 204 with no body.
  router.put('/me/liked-songs/:songId', requireAuth, accountOnly, limit.likeSong, asyncHandler(async (req, res) => {
    await library.likeSong(req.auth, req.params.songId);
    res.status(204).end();
  }));

  router.delete('/me/liked-songs/:songId', requireAuth, accountOnly, limit.unlikeSong, asyncHandler(async (req, res) => {
    await library.unlikeSong(req.auth, req.params.songId);
    res.status(204).end();
  }));

  router.get('/me/library/playlists', requireAuth, accountOnly, limit.listLibraryPlaylists, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await library.listLibraryPlaylists(req.auth, {
      sort: req.query.sort,
      limit: req.query.limit,
      cursor: req.query.cursor,
    }));
  }));

  router.get('/me/library/songs/:songId', requireAuth, accountOnly, limit.getSongLibraryState, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await library.songLibraryState(req.auth, req.params.songId));
  }));

  // Add to Playlist's Save: the exact set, all or nothing; the same set again changes nothing.
  router.put('/me/library/songs/:songId/playlists', requireAuth, accountOnly, limit.setSongPlaylists,
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', privateCache).json(await library.setSongPlaylists(req.auth, req.params.songId, req.body));
    }));

  return router;
}

module.exports = { createLibraryRouter, LIMITS, router: createLibraryRouter() };
