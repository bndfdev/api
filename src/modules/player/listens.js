/**
 * Listens (docs/api/paths/player.yaml: recordListens): the app reports each song that stopped being the current
 * one, up to 50 at a time. The rules only: no HTTP and no database access of its own; the clock is injected. Guests
 * and accounts alike: the listener is the account or the guest (`req.auth.userId`).
 *
 * - The batch's shape (1 to 50 events, each field) is checked by the spec validator before this runs.
 * - Dropped without an error, so one bad event never blocks the rest: events for an unknown song (or an id that is
 *   not a song's), for a song the listener may not play (followers-only, ./songs.js `mayPlay`), and events whose
 *   `endedAt` is more than 30 days before or more than 5 minutes after this server's clock.
 * - An event sent again (same listener, song and `endedAt`, in this batch or in an earlier one) is ignored: the
 *   `listens` unique index keeps one, and only the request that stored it counts it, so a resend never counts twice.
 * - It counts towards `Song.listens` when `listenedMs` is at least 30000 or `completed` is true. The spec lets
 *   counting happen after the answer (202 only says "received"); here it happens just before it, once the events
 *   are stored. If adding the counts fails, the events stay stored and the answer is still 202 (the failure is
 *   logged): those listens are then missing from the count, never counted twice.
 * - `source` is kept when usable: `album` and `playlist` with an id, `liked_songs` and `song` (an id sent with them is
 *   ignored). An `album` or `playlist` source without an id is dropped; the listen itself still counts.
 * - The events stored with a `playlist` or `liked_songs` source move that library entry's `playedAt` ("Recently
 *   played"; the Library, ./library.js `markPlayed`), after the counts. If that fails, the answer is still 202 (the
 *   failure is logged).
 */
const { logger: defaultLogger } = require('../../lib/logger');
const defaultContents = require('../content/repo');
const defaultListens = require('./listensRepo');
const defaultLibrary = require('./library');
const { byId, mayPlay, albumIdsOf, albumOf } = require('./songs');

/** The counting rule: at least 30 seconds played, or played to the end. */
const COUNTS_AFTER_MS = 30 * 1000;
/** Events that ended longer ago than this are dropped. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Events that end further ahead of this server's clock than this are dropped. */
const MAX_AHEAD_MS = 5 * 60 * 1000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const NEEDS_ID = Object.freeze(['album', 'playlist']);

/** A library that does nothing with listens (tests); the default is the Library's (./library.js). */
const NO_LIBRARY = Object.freeze({
  /** `(auth, listens) => Promise<void>`: move `playedAt` of the library entries these listens were played from. */
  markPlayed: async () => {},
});

/** Whether an event counts towards the song's listens. */
const counts = (event) => event.completed === true || event.listenedMs >= COUNTS_AFTER_MS;

/** The event's `source` as stored, or null when there is none or it is not usable. */
function sourceOf(source) {
  if (!source || typeof source.type !== 'string') return null;
  if (!NEEDS_ID.includes(source.type)) return { type: source.type };
  return typeof source.id === 'string' && OBJECT_ID.test(source.id) ? { type: source.type, id: source.id.toLowerCase() } : null;
}

/**
 * @param {{contents?: object, listens?: object, library?: object, now?: () => number, logger?: object}} [deps]
 *   `contents` the content module's repo, `listens` ./listensRepo.js, `library` ./library.js (its `markPlayed`)
 */
function createListenService({
  contents = defaultContents,
  listens = defaultListens,
  library = defaultLibrary,
  now = Date.now,
  logger = defaultLogger,
} = {}) {
  /**
   * POST /me/listens.
   * @param {object} auth `req.auth` (an account or a guest)
   * @param {{events: object[]}} body a `ListenBatch`
   * @returns {Promise<{stored: number, counted: number}>} how many events were new, and how many of those counted
   */
  async function record(auth, { events }) {
    const at = now();
    const seen = new Set();
    const fresh = [];
    for (const event of events) {
      const songId = String(event.songId).toLowerCase();
      const endedAt = Date.parse(event.endedAt);
      if (!OBJECT_ID.test(songId) || !Number.isFinite(endedAt)) continue;
      if (endedAt < at - MAX_AGE_MS || endedAt > at + MAX_AHEAD_MS) continue;
      const key = `${songId} ${endedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({ event, songId, endedAt });
    }
    if (fresh.length === 0) return { stored: 0, counted: 0 };

    const songs = byId((await contents.findByIds([...new Set(fresh.map((f) => f.songId))])).filter((doc) => doc.type === 'song'));
    const albumIds = albumIdsOf([...songs.values()]);
    const albums = byId(albumIds.length > 0 ? await contents.findByIds(albumIds) : []);
    const listenerType = auth.accountType === 'guest' ? 'guest' : 'user';
    const docs = fresh.filter(({ songId }) => {
      const song = songs.get(songId);
      return Boolean(song) && mayPlay(auth, song, albumOf(song, albums));
    }).map(({ event, songId, endedAt }) => ({
      listenerId: auth.userId,
      listenerType,
      songId,
      listenedMs: event.listenedMs,
      completed: event.completed,
      endedAt: new Date(endedAt),
      source: sourceOf(event.source),
      counted: counts(event),
      receivedAt: new Date(at),
    }));

    const stored = await listens.insertNew(docs);
    const increments = new Map();
    for (const listen of stored) {
      if (!listen.counted) continue;
      const id = String(listen.songId);
      increments.set(id, (increments.get(id) || 0) + 1);
    }
    try {
      await contents.addListens(increments);
    } catch (err) {
      logger.error({ err }, 'listens were stored but could not be added to the songs\' counts');
    }
    try {
      await library.markPlayed(auth, stored);
    } catch (err) {
      logger.error({ err }, 'listens were stored but could not move the library\'s "played" times');
    }
    return { stored: stored.length, counted: [...increments.values()].reduce((sum, n) => sum + n, 0) };
  }

  return { record };
}

module.exports = { createListenService, NO_LIBRARY, COUNTS_AFTER_MS, MAX_AGE_MS, MAX_AHEAD_MS, ...createListenService() };
