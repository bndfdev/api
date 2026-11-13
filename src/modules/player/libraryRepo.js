/**
 * The only place that reads and writes `song_likes` (models/SongLike.js), `library_entries` (models/LibraryEntry.js)
 * and `library_locks` (models/LibraryLock.js): the listener's likes and library. The playlists themselves are
 * `contents`, their songs `playlist_items` (./repo.js). Returns plain objects.
 *
 * Liked songs are paged by key ("everything after this like"), not by skipping, on the `user_liked` index.
 */
const SongLike = require('../../../models/SongLike');
const LibraryEntry = require('../../../models/LibraryEntry');
const LibraryLock = require('../../../models/LibraryLock');

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DUPLICATE_KEY = 11000;

/** A write error's code: the driver's `WriteError` has it as a getter, a copy may keep it in `err`. */
const codeOf = (writeError) => (writeError && (writeError.code ?? (writeError.err && writeError.err.code)));
/** A unique index refused the write (a duplicate key), and nothing else went wrong. */
function onlyDuplicates(err) {
  if (!err) return false;
  if (err.code === DUPLICATE_KEY) return true;
  const writeErrors = [].concat(err.writeErrors || []);
  return writeErrors.length > 0 && writeErrors.every((writeError) => codeOf(writeError) === DUPLICATE_KEY);
}
const idsIn = (ids) => [...new Set(ids.map((id) => String(id).toLowerCase()))].filter((id) => OBJECT_ID.test(id));

/**
 * Like a song (the `user_song` unique index keeps one row, so liking twice at once stores one).
 * @param {{userId: string, songId: string, likedAt: Date}} like
 * @returns {Promise<boolean>} true when this call liked it, false when it was liked already (its `likedAt` kept)
 */
async function like({ userId, songId, likedAt }) {
  try {
    await SongLike.create({ userId, songId, likedAt });
    return true;
  } catch (err) {
    if (onlyDuplicates(err)) return false;
    throw err;
  }
}

/**
 * Unlike a song.
 * @param {{userId: string, songId: string}} like
 * @returns {Promise<boolean>} true when this call took it out, false when it was not liked
 */
async function unlike({ userId, songId }) {
  if (!OBJECT_ID.test(String(userId)) || !OBJECT_ID.test(String(songId))) return false;
  const { deletedCount } = await SongLike.deleteOne({ userId, songId });
  return deletedCount > 0;
}

/**
 * Which of these songs the user liked, on the `user_song` index.
 * @param {{userId: string, songIds: string[]}} input
 * @returns {Promise<Set<string>>} song ids, lower case
 */
async function likedAmong({ userId, songIds }) {
  const wanted = idsIn(songIds);
  if (!OBJECT_ID.test(String(userId)) || wanted.length === 0) return new Set();
  const rows = await SongLike.find({ userId, songId: { $in: wanted } }, { _id: 0, songId: 1 }).lean();
  return new Set(rows.map((row) => String(row.songId)));
}

/**
 * One page of the user's likes, newest first (`likedAt`, then id).
 * @param {{userId: string, limit: number, after?: {likedAt: Date, id: string} | null}} input `after` the last row
 *   of the previous page
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
async function likesPage({ userId, limit, after = null }) {
  if (!OBJECT_ID.test(String(userId))) return { items: [], hasMore: false };
  const query = { userId };
  if (after) {
    query.$or = [
      { likedAt: { $lt: after.likedAt } },
      { likedAt: after.likedAt, _id: { $lt: after.id } },
    ];
  }
  const docs = await SongLike.find(query).sort({ likedAt: -1, _id: -1 }).limit(limit + 1).lean();
  return { items: docs.slice(0, limit), hasMore: docs.length > limit };
}

/**
 * How many songs the user liked, and the newest like.
 * @param {string} userId
 * @returns {Promise<{count: number, newestLikedAt: Date | null}>}
 */
async function likesSummary(userId) {
  if (!OBJECT_ID.test(String(userId))) return { count: 0, newestLikedAt: null };
  const [count, newest] = await Promise.all([
    SongLike.countDocuments({ userId }),
    SongLike.findOne({ userId }, { likedAt: 1 }).sort({ likedAt: -1, _id: -1 }).lean(),
  ]);
  return { count, newestLikedAt: newest ? newest.likedAt : null };
}

/**
 * Every library row of the user (saved playlists, played own playlists, Liked songs).
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
function entries(userId) {
  if (!OBJECT_ID.test(String(userId))) return Promise.resolve([]);
  return LibraryEntry.find({ userId }).lean();
}

/**
 * The user's rows for these playlists (is it in the library?).
 * @param {{userId: string, playlistIds: string[]}} input
 * @returns {Promise<object[]>}
 */
function entriesFor({ userId, playlistIds }) {
  const wanted = idsIn(playlistIds);
  if (!OBJECT_ID.test(String(userId)) || wanted.length === 0) return Promise.resolve([]);
  return LibraryEntry.find({ userId, kind: 'playlist', playlistId: { $in: wanted } }).lean();
}

/** The filter for one row: a playlist's, or the Liked songs one (`playlistId` null). */
const rowFilter = (userId, playlistId) => (playlistId
  ? { userId, playlistId }
  : { userId, playlistId: null, kind: 'liked_songs' });

/** Run upserts; when two requests make the same row at once, the loser runs again and finds it. */
async function upsertAll(ops) {
  if (ops.length === 0) return;
  try {
    await LibraryEntry.bulkWrite(ops, { ordered: false });
  } catch (err) {
    if (!onlyDuplicates(err)) throw err;
    await LibraryEntry.bulkWrite(ops, { ordered: false });
  }
}

/**
 * Move `playedAt` of library rows forward (never back), in one round trip.
 * @param {{userId: string, plays: Array<{playlistId: string | null, playedAt: Date, create: object | null}>}} input
 *   `playlistId` null for Liked songs; `create` the fields of the row to make when there is none (`{kind,
 *   savedAt}` for an own playlist, `{}` for Liked songs), null to only update a row that exists (a saved playlist)
 */
function markPlayed({ userId, plays }) {
  if (!OBJECT_ID.test(String(userId))) return Promise.resolve();
  return upsertAll(plays.filter(({ playlistId }) => playlistId === null || OBJECT_ID.test(String(playlistId)))
    .map(({ playlistId, playedAt, create }) => ({
      updateOne: {
        filter: rowFilter(userId, playlistId),
        update: { $max: { playedAt }, ...(create && Object.keys(create).length > 0 ? { $setOnInsert: create } : {}) },
        upsert: Boolean(create),
      },
    })));
}

/**
 * Note that a song was taken out of the user's Liked songs (its `updatedAt`), never moving it back.
 * @param {{userId: string, at: Date}} input
 */
function markUnliked({ userId, at }) {
  if (!OBJECT_ID.test(String(userId))) return Promise.resolve();
  return upsertAll([{ updateOne: { filter: rowFilter(userId, null), update: { $max: { unlikedAt: at } }, upsert: true } }]);
}

/**
 * Take the account's lock: free, or left behind and expired (taken over).
 * @param {{userId: string, owner: string, now: number, leaseMs: number}} input
 * @returns {Promise<boolean>} whether this call holds it now
 */
async function acquireLock({ userId, owner, now, leaseMs }) {
  const expiresAt = new Date(now + leaseMs);
  try {
    await LibraryLock.create({ _id: userId, owner, expiresAt });
    return true;
  } catch (err) {
    if (!onlyDuplicates(err)) throw err;
  }
  const taken = await LibraryLock.findOneAndUpdate(
    { _id: userId, expiresAt: { $lte: new Date(now) } },
    { $set: { owner, expiresAt } },
    { projection: { _id: 1 } },
  ).lean();
  return taken !== null;
}

/** Give the lock back, if `owner` still holds it. */
async function releaseLock({ userId, owner }) {
  await LibraryLock.deleteOne({ _id: userId, owner });
}

module.exports = {
  like, unlike, likedAmong, likesPage, likesSummary, entries, entriesFor, markPlayed, markUnliked, acquireLock,
  releaseLock,
};
