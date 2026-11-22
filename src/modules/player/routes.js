const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { idempotency: defaultIdempotency } = require('../../middleware/idempotency');
const defaultPlayer = require('./service');
const defaultListens = require('./listens');

/**
 * Each operation's `x-rate-limit` (docs/api/paths/player.yaml), per account (a guest counts as one): reads 120 a
 * minute, listens 60 a minute. Each operation has its own counter.
 */
const LIMITS = Object.freeze({
  listSongs: { name: 'player-songs:account', points: 120, durationSeconds: 60, key: byUser },
  getSong: { name: 'player-song:account', points: 120, durationSeconds: 60, key: byUser },
  getSongPlayback: { name: 'player-playback:account', points: 120, durationSeconds: 60, key: byUser },
  getSongTranscript: { name: 'player-transcript:account', points: 120, durationSeconds: 60, key: byUser },
  getAlbum: { name: 'player-album:account', points: 120, durationSeconds: 60, key: byUser },
  getPlaylist: { name: 'player-playlist:account', points: 120, durationSeconds: 60, key: byUser },
  listPlaylistSongs: { name: 'player-playlist-songs:account', points: 120, durationSeconds: 60, key: byUser },
  recordListens: { name: 'player-listens:account', points: 60, durationSeconds: 60, key: byUser },
});

/** `ids` as the validator leaves it (an array for `?ids=a,b`; a single value may stay a string). */
const idsOf = (value) => (Array.isArray(value) ? value : String(value).split(',')).map(String);

/**
 * The media player's listening operations (`docs/api/paths/player.yaml`, tag Player). Guests allowed everywhere: a
 * guest's token works like an account's (`requireAuth` without `accountOnly`); no token is 401.
 * @param {{player?: object, listens?: object, auth?: {requireAuth: Function}, idempotency?: Function,
 *   storeFactory?: Function}} [deps] `storeFactory` replaces the rate limiters' counter store (tests)
 */
function createPlayerRouter({
  player = defaultPlayer,
  listens = defaultListens,
  auth = defaultAuth,
  idempotency = defaultIdempotency,
  storeFactory,
} = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  const limit = Object.fromEntries(Object.entries(LIMITS)
    .map(([operation, rule]) => [operation, rateLimit({ ...rule, ...(storeFactory ? { storeFactory } : {}) })]));
  // `liked` and `playable` are the viewer's: never stored by shared caches.
  const privateCache = 'private, no-cache';

  // GET /songs?ids=: restoring a saved queue.
  router.get('/songs', requireAuth, limit.listSongs, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await player.listSongs(req.auth, idsOf(req.query.ids)));
  }));

  router.get('/songs/:songId', requireAuth, limit.getSong, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await player.getSong(req.auth, req.params.songId));
  }));

  // The address is short-lived and must not be kept anywhere.
  router.get('/songs/:songId/playback', requireAuth, limit.getSongPlayback, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store').json(await player.playback(req.auth, req.params.songId));
  }));

  // Without `language`, Accept-Language picks the transcript.
  router.get('/songs/:songId/transcript', requireAuth, limit.getSongTranscript, asyncHandler(async (req, res) => {
    const body = await player.transcript(req.auth, req.params.songId, {
      language: req.query.language,
      acceptLanguage: req.get('accept-language'),
    });
    res.vary('Accept-Language').set('Cache-Control', privateCache).json(body);
  }));

  router.get('/albums/:albumId', requireAuth, limit.getAlbum, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await player.getAlbum(req.auth, req.params.albumId));
  }));

  router.get('/playlists/:playlistId', requireAuth, limit.getPlaylist, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await player.getPlaylist(req.auth, req.params.playlistId));
  }));

  router.get('/playlists/:playlistId/songs', requireAuth, limit.listPlaylistSongs, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await player.listPlaylistSongs(req.auth, req.params.playlistId, {
      limit: req.query.limit,
      cursor: req.query.cursor,
    }));
  }));

  // POST /me/listens: 202 with no body once the batch is stored. The Idempotency-Key replays that answer.
  router.post('/me/listens', requireAuth, limit.recordListens, idempotency, asyncHandler(async (req, res) => {
    await listens.record(req.auth, req.body);
    res.status(202).end();
  }));

  return router;
}

module.exports = { createPlayerRouter, LIMITS, router: createPlayerRouter() };
