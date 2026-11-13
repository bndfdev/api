/**
 * The listener's library (docs/api/paths/library.yaml, tag Library; design notes in docs/api/PLAYER.md): likes, the
 * library's playlists, a song's heart and "+" states, and Add to Playlist. Also moves the library's "played" times
 * for listens (./listens.js). The rules only: no HTTP and no database access of its own; the clock is injected.
 * Accounts only (the routes refuse guests).
 *
 * - Likes (`song_likes`): one per user and song. Liking a liked song keeps its `likedAt`; unliking a song that is
 *   not liked, no longer exists or has an id in no known format is 204 too. A followers-only song can be liked (the
 *   spec lists no CONTENT_RESTRICTED there); it is then listed with `playable: false`, as a song that became
 *   followers-only after the like is.
 * - Liked songs pages: newest like first (`likedAt`, then the like's id), 1 to 50 (20 by default), an opaque cursor
 *   tied to the user and good for 24 hours (CURSOR_INVALID). A like whose song no longer exists (or is no longer a
 *   song) is left out of its page but still counted in `page.total` and in the Liked songs entry's `songCount`, as
 *   step 1 does for a playlist's items.
 * - The library: the user's own playlists (`editable`; hidden and followers-only ones too: this is the owner's view),
 *   the playlists saved from others (`library_entries` rows whose playlist still exists) and the Liked songs entry
 *   (id `liked_<userId>`, always there). `songCount` and `updatedAt` as GET /playlists/{id} gives them (step 1:
 *   items counted, `updatedAt` the last add or removal); `savedAt` the playlist's creation for own playlists and
 *   the account's creation for Liked songs; `playedAt` from listens. Liked songs' `updatedAt` is the newer of the
 *   newest like and the last unlike, else the account's creation.
 * - Library pages: sorted in memory (a library is small: own playlists, saved ones and one entry), `sort` as the
 *   spec says, ties by id, so the order is total; 1 to 200 (50 by default); a cursor holds the last entry's sort key
 *   and id, is tied to the user and the sort, and is good for 24 hours.
 * - Add to Playlist (PUT .../playlists): the Liked songs id and repeats are ignored; every id is checked before
 *   anything is written: ids that are not playlists in the user's library are 404 PLAYLIST_NOT_FOUND (reported
 *   first), saved playlists of others 403 PLAYLIST_NOT_EDITABLE, each with `meta.playlistIds` (as sent). The change
 *   runs under the account's lock (one at a time per account, so two sets sent at once end as one of them, never a
 *   mix): new items go after the playlist's last position, removed ones leave the others' order; each changed
 *   playlist gets `songsUpdatedAt` now and `songCount` from its items. If any write fails, what was written is undone
 *   and the request fails: nothing is half-saved.
 */
const crypto = require('node:crypto');
const { setTimeout: sleepFor } = require('node:timers/promises');
const { ApiError } = require('../../lib/problem');
const { iso } = require('../../lib/time');
const { logger: defaultLogger } = require('../../lib/logger');
const { sortableTitle } = require('../../../models/Content');
const defaultContents = require('../content/repo');
const defaultUsers = require('../users/repo');
const defaultItems = require('./repo');
const defaultLibrary = require('./libraryRepo');
const defaultPlayer = require('./service');
const { artworkOf, playlistUpdatedAt } = require('./service');
const { byId } = require('./songs');

const LIKED_DEFAULT_LIMIT = 20;
const LIKED_MAX_LIMIT = 50;
const LIBRARY_DEFAULT_LIMIT = 50;
const LIBRARY_MAX_LIMIT = 200;
const SORTS = Object.freeze(['recently_updated', 'recently_played', 'recently_saved', 'title']);
const DEFAULT_SORT = 'recently_updated';
/** "A cursor only works ... for 24 hours". */
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
/** How far ahead of this server's clock a cursor's time may be (another instance's clock). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The Liked songs entry's title (English; the app shows its own words). */
const LIKED_SONGS_TITLE = 'Liked songs';
/** How long a request may hold the account's lock before another may take it over (a crash left it behind). */
const LOCK_LEASE_MS = 10 * 1000;
/** How long a request waits for the lock: longer than a lease, so a lock left behind never fails a request. */
const LOCK_WAIT_MS = 12 * 1000;
const LOCK_RETRY_MS = 20;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const LIKED_ID = /^liked_[0-9a-f]{24}$/;
/** What the library reads of a playlist. */
const PLAYLIST_FIELDS = Object.freeze({ type: 1, ownerId: 1, title: 1, image: 1, createdAt: 1, songsUpdatedAt: 1 });

const contentNotFound = () => new ApiError({
  status: 404, code: 'CONTENT_NOT_FOUND', title: 'Content not found', detail: 'This item no longer exists.',
});
const cursorInvalid = () => new ApiError({
  status: 422, code: 'CURSOR_INVALID', title: 'Start again from the first page',
  detail: 'This page link has expired or belongs to another list.',
  errors: [{ field: 'cursor', code: 'CURSOR_INVALID', message: 'Start again from the first page.' }],
});
const playlistNotFound = (playlistIds) => new ApiError({
  status: 404, code: 'PLAYLIST_NOT_FOUND', title: 'Some playlists were not found',
  detail: 'Refresh your library and choose again.', meta: { playlistIds },
});
const playlistNotEditable = (playlistIds) => new ApiError({
  status: 403, code: 'PLAYLIST_NOT_EDITABLE', title: 'Only your own playlists can take songs',
  detail: 'Songs can only be added to or taken out of playlists you made.', meta: { playlistIds },
});

const isDate = (at) => at instanceof Date && !Number.isNaN(at.getTime());
const idOf = (doc) => String(doc._id).toLowerCase();
/** The Liked songs entry's id for this user (the spec's example: `liked_<userId>`). */
const likedSongsIdOf = (userId) => `liked_${String(userId).toLowerCase()}`;
/** What a cursor is tied to: a hash of the request it was made for. */
const fingerprintOf = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);
const pageSize = (limit, fallback, max) => {
  const n = Number(limit);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
};

/**
 * Each sort: the key it compares (a number, null for "never", or a string) and its direction. Ties: the id, A to Z.
 * `recently_played` puts entries never played last.
 */
const SORT_KEYS = Object.freeze({
  recently_updated: { keyOf: (entry) => entry.updatedAt.getTime(), newestFirst: true },
  recently_played: { keyOf: (entry) => (entry.playedAt ? entry.playedAt.getTime() : null), newestFirst: true },
  recently_saved: { keyOf: (entry) => entry.savedAt.getTime(), newestFirst: true },
  title: { keyOf: (entry) => sortableTitle(entry.title), newestFirst: false },
});

/** Compare two sort positions (`{key, id}`) in the order of `sort`. */
function comparePositions(sort, a, b) {
  const { newestFirst } = SORT_KEYS[sort];
  if (a.key !== b.key) {
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    if (newestFirst) return a.key > b.key ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * @param {{contents?: object, users?: object, items?: object, library?: object, player?: object,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, logger?: object}} [deps] `contents` the content
 *   module's repo, `users` the users repo (`findCreatedAt`), `items` ./repo.js, `library` ./libraryRepo.js,
 *   `player` ./service.js (`describeSongs`), `sleep` waits between tries for the account's lock
 */
function createLibraryService({
  contents = defaultContents,
  users = defaultUsers,
  items = defaultItems,
  library = defaultLibrary,
  player = defaultPlayer,
  now = Date.now,
  sleep = sleepFor,
  logger = defaultLogger,
} = {}) {
  const userOf = (auth) => String(auth.userId).toLowerCase();

  /** The song with this id, or 404 CONTENT_NOT_FOUND (also for an id of another type). */
  async function findSong(songId) {
    const [doc] = await contents.findByIds([songId]);
    if (!doc || doc.type !== 'song') throw contentNotFound();
    return doc;
  }

  function encodeCursor(position, fingerprint) {
    const body = { k: position.key, i: position.id, f: fingerprint, t: Math.floor(now() / 1000) };
    return Buffer.from(JSON.stringify(body)).toString('base64url');
  }

  /**
   * The position a cursor holds, or throws CURSOR_INVALID. No cursor is the first page (null).
   * @param {(k: unknown) => boolean} keyOk whether `k` is a key of this list
   * @param {(i: unknown) => boolean} idOk whether `i` is an id of this list
   * @returns {{key: unknown, id: string} | null}
   */
  function positionFrom(cursor, fingerprint, keyOk, idOk) {
    if (cursor === undefined || cursor === null) return null;
    let decoded;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('not base64url');
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw cursorInvalid();
    }
    const { k, i, f, t } = decoded || {};
    const at = now();
    if (f !== fingerprint || !idOk(i) || !keyOk(k) || !Number.isInteger(t)) throw cursorInvalid();
    if (at - t * 1000 > CURSOR_TTL_MS || t * 1000 - at > CLOCK_SKEW_MS) throw cursorInvalid();
    return { key: k, id: i };
  }

  /**
   * GET /me/liked-songs.
   * @param {object} auth `req.auth`
   * @param {{limit?: number, cursor?: string}} input
   * @returns {Promise<object>} `LikedSongPage`
   */
  async function listLikedSongs(auth, { limit, cursor } = {}) {
    const userId = userOf(auth);
    const size = pageSize(limit, LIKED_DEFAULT_LIMIT, LIKED_MAX_LIMIT);
    const fingerprint = fingerprintOf(['liked-songs', userId]);
    const position = positionFrom(cursor, fingerprint, Number.isInteger, (i) => typeof i === 'string' && OBJECT_ID.test(i));
    const after = position ? { likedAt: new Date(position.key), id: position.id } : null;
    const [{ items: likes, hasMore }, { count }] = await Promise.all([
      library.likesPage({ userId, limit: size, after }),
      library.likesSummary(userId),
    ]);
    const found = byId((await contents.findByIds(likes.map((like) => String(like.songId)))).filter((doc) => doc.type === 'song'));
    const shown = likes.filter((like) => found.has(String(like.songId).toLowerCase()));
    const songs = await player.describeSongs(auth, shown.map((like) => found.get(String(like.songId).toLowerCase())));
    const last = likes[likes.length - 1];
    return {
      data: songs.map((song, i) => ({ ...song, likedAt: iso(shown[i].likedAt) })),
      page: {
        nextCursor: hasMore ? encodeCursor({ key: last.likedAt.getTime(), id: String(last._id) }, fingerprint) : null,
        hasMore,
        total: count,
      },
    };
  }

  /** PUT /me/liked-songs/{songId}: the heart. Idempotent (a liked song keeps its `likedAt`). */
  async function likeSong(auth, songId) {
    const song = await findSong(songId);
    await library.like({ userId: userOf(auth), songId: idOf(song), likedAt: new Date(now()) });
  }

  /**
   * DELETE /me/liked-songs/{songId}. Idempotent. Taking a song out moves the Liked songs entry's `updatedAt`; if that
   * note fails the like is still gone (the failure is logged), as the heart is what the listener sees.
   */
  async function unlikeSong(auth, songId) {
    const id = String(songId).toLowerCase();
    if (!OBJECT_ID.test(id)) return;
    const userId = userOf(auth);
    if (!(await library.unlike({ userId, songId: id }))) return;
    try {
      await library.markUnliked({ userId, at: new Date(now()) });
    } catch (err) {
      logger.error({ err }, 'a song was unliked but the Liked songs entry\'s "updated" time could not be moved');
    }
  }

  /** The library entry of a playlist (own or saved), with Date values the sorts compare. */
  function playlistEntry(playlist, { stats, row, editable }) {
    const created = isDate(playlist.createdAt) ? playlist.createdAt : new Date(0);
    return {
      id: idOf(playlist),
      title: typeof playlist.title === 'string' ? playlist.title : '',
      image: artworkOf(playlist.image),
      songCount: stats ? stats.count : 0,
      updatedAt: playlistUpdatedAt(playlist, stats ? stats.lastAddedAt : null),
      savedAt: editable || !row || !isDate(row.savedAt) ? created : row.savedAt,
      playedAt: row && isDate(row.playedAt) ? row.playedAt : null,
      isLikedSongs: false,
      editable,
    };
  }

  /** Every entry of the user's library, in no particular order. */
  async function libraryOf(userId) {
    const [own, rows, likes, createdAt] = await Promise.all([
      contents.ownPlaylists(userId, PLAYLIST_FIELDS),
      library.entries(userId),
      library.likesSummary(userId),
      users.findCreatedAt(userId),
    ]);
    const ownIds = new Set(own.map(idOf));
    const playlistRows = new Map(rows.filter((row) => row.kind === 'playlist' && row.playlistId)
      .map((row) => [String(row.playlistId).toLowerCase(), row]));
    const savedIds = [...playlistRows.keys()].filter((id) => !ownIds.has(id));
    const saved = savedIds.length > 0
      ? (await contents.findByIds(savedIds, PLAYLIST_FIELDS)).filter((doc) => doc.type === 'playlist')
      : [];
    const stats = await items.playlistStats([...own, ...saved].map(idOf));
    const likedRow = rows.find((row) => row.kind === 'liked_songs') || null;
    const accountSince = isDate(createdAt) ? createdAt : new Date(0);
    const likedChanges = [likes.newestLikedAt, likedRow && likedRow.unlikedAt].filter(isDate);
    return [
      {
        id: likedSongsIdOf(userId),
        title: LIKED_SONGS_TITLE,
        image: null,
        songCount: likes.count,
        updatedAt: likedChanges.length > 0 ? new Date(Math.max(...likedChanges.map((at) => at.getTime()))) : accountSince,
        savedAt: accountSince,
        playedAt: likedRow && isDate(likedRow.playedAt) ? likedRow.playedAt : null,
        isLikedSongs: true,
        editable: false,
      },
      ...own.map((doc) => playlistEntry(doc, { stats: stats.get(idOf(doc)), row: playlistRows.get(idOf(doc)), editable: true })),
      ...saved.map((doc) => playlistEntry(doc, { stats: stats.get(idOf(doc)), row: playlistRows.get(idOf(doc)), editable: false })),
    ];
  }

  /**
   * GET /me/library/playlists.
   * @param {object} auth `req.auth`
   * @param {{sort?: string, limit?: number, cursor?: string}} input
   * @returns {Promise<object>} `LibraryPlaylistPage`
   */
  async function listLibraryPlaylists(auth, { sort, limit, cursor } = {}) {
    const userId = userOf(auth);
    const order = SORTS.includes(sort) ? sort : DEFAULT_SORT;
    const size = pageSize(limit, LIBRARY_DEFAULT_LIMIT, LIBRARY_MAX_LIMIT);
    const fingerprint = fingerprintOf(['library-playlists', userId, order]);
    const keyOk = order === 'title' ? (k) => typeof k === 'string'
      : order === 'recently_played' ? (k) => k === null || Number.isInteger(k) : Number.isInteger;
    const idOk = (i) => typeof i === 'string' && (OBJECT_ID.test(i) || LIKED_ID.test(i));
    const after = positionFrom(cursor, fingerprint, keyOk, idOk);
    const { keyOf } = SORT_KEYS[order];
    const entries = (await libraryOf(userId)).map((entry) => ({ entry, position: { key: keyOf(entry), id: entry.id } }))
      .sort((a, b) => comparePositions(order, a.position, b.position));
    const rest = after ? entries.filter(({ position }) => comparePositions(order, position, after) > 0) : entries;
    const shown = rest.slice(0, size);
    const hasMore = rest.length > size;
    return {
      data: shown.map(({ entry }) => ({
        ...entry,
        updatedAt: iso(entry.updatedAt),
        savedAt: iso(entry.savedAt),
        playedAt: entry.playedAt ? iso(entry.playedAt) : null,
      })),
      page: {
        nextCursor: hasMore ? encodeCursor(shown[shown.length - 1].position, fingerprint) : null,
        hasMore,
        total: entries.length,
      },
    };
  }

  /**
   * GET /me/library/songs/{songId}: the heart and the "+" button.
   * @returns {Promise<object>} `SongLibraryState`
   */
  async function songLibraryState(auth, songId) {
    const userId = userOf(auth);
    const id = idOf(await findSong(songId));
    const own = await contents.ownPlaylists(userId, { _id: 1 });
    const [liked, holding] = await Promise.all([
      library.likedAmong({ userId, songIds: [id] }),
      items.songItems({ songId: id, playlistIds: own.map(idOf) }),
    ]);
    return { liked: liked.has(id), playlistIds: [...new Set(holding.map((item) => String(item.playlistId).toLowerCase()))] };
  }

  /** Run `work` holding the account's lock (waiting for it), and give the lock back after. */
  async function withAccountLock(userId, work) {
    const owner = crypto.randomUUID();
    const deadline = now() + LOCK_WAIT_MS;
    while (!(await library.acquireLock({ userId, owner, now: now(), leaseMs: LOCK_LEASE_MS }))) {
      if (now() >= deadline) throw new Error('the library lock of an account could not be taken in time');
      await sleep(LOCK_RETRY_MS);
    }
    try {
      return await work();
    } finally {
      try {
        await library.releaseLock({ userId, owner });
      } catch (err) {
        logger.warn({ err }, 'a library lock could not be given back; it expires on its own');
      }
    }
  }

  /**
   * Make `wanted` exactly the user's playlists holding the song (the caller holds the account's lock): add it at
   * the end of the new ones, take it out of the others, then store each changed playlist's count and time. Undone
   * if anything fails.
   */
  async function applySet({ userId, songId, ownIds, wanted }) {
    const holding = await items.songItems({ songId, playlistIds: ownIds });
    const current = new Set(holding.map((item) => String(item.playlistId).toLowerCase()));
    const wantedSet = new Set(wanted);
    const toAdd = wanted.filter((id) => !current.has(id));
    const remove = holding.filter((item) => !wantedSet.has(String(item.playlistId).toLowerCase()));
    if (toAdd.length === 0 && remove.length === 0) return;

    const at = new Date(now());
    const last = await items.lastPositions(toAdd);
    const add = items.newItems(toAdd.map((playlistId) => ({
      playlistId, songId, position: (last.has(playlistId) ? last.get(playlistId) : 0) + 1, addedAt: at,
    })));
    const changed = [...new Set([...toAdd, ...remove.map((item) => String(item.playlistId).toLowerCase())])];
    const before = await contents.findByIds(changed, { songCount: 1, songsUpdatedAt: 1 });
    try {
      await items.changeItems({ add, remove });
      const stats = await items.playlistStats(changed);
      await contents.setPlaylistStats(changed.map((id) => ({
        id, songCount: stats.has(id) ? stats.get(id).count : 0, songsUpdatedAt: at,
      })));
    } catch (err) {
      try {
        await items.undoItems({ add, remove });
        await contents.setPlaylistStats(before.map((doc) => ({
          id: idOf(doc),
          songCount: Number.isInteger(doc.songCount) ? doc.songCount : null,
          songsUpdatedAt: isDate(doc.songsUpdatedAt) ? doc.songsUpdatedAt : null,
        })));
      } catch (undoErr) {
        logger.error({ err: undoErr, songId }, 'Add to Playlist failed and could not be fully undone');
      }
      throw err;
    }
  }

  /**
   * PUT /me/library/songs/{songId}/playlists: Add to Playlist's Save.
   * @param {object} auth `req.auth`
   * @param {{playlistIds: string[]}} body up to 500 ids (the validator has checked the shape)
   * @returns {Promise<object>} `SongPlaylists`: the saved set (ids in lower case, in the order sent)
   */
  async function setSongPlaylists(auth, songId, { playlistIds }) {
    const userId = userOf(auth);
    const id = idOf(await findSong(songId));
    const likedId = likedSongsIdOf(userId);
    const sent = new Map();
    for (const raw of playlistIds) {
      const key = String(raw).toLowerCase();
      if (key !== likedId && !sent.has(key)) sent.set(key, String(raw));
    }
    const ownIds = (await contents.ownPlaylists(userId, { _id: 1 })).map(idOf);
    const own = new Set(ownIds);
    const others = [...sent.keys()].filter((key) => !own.has(key));
    if (others.length > 0) {
      const [rows, docs] = await Promise.all([
        library.entriesFor({ userId, playlistIds: others }),
        contents.findByIds(others, { type: 1 }),
      ]);
      const playlists = new Set(docs.filter((doc) => doc.type === 'playlist').map(idOf));
      const saved = new Set(rows.map((row) => String(row.playlistId).toLowerCase()).filter((key) => playlists.has(key)));
      const unknown = others.filter((key) => !saved.has(key));
      if (unknown.length > 0) throw playlistNotFound(unknown.map((key) => sent.get(key)));
      throw playlistNotEditable(others.map((key) => sent.get(key)));
    }
    const wanted = [...sent.keys()];
    await withAccountLock(userId, () => applySet({ userId, songId: id, ownIds, wanted }));
    return { playlistIds: wanted };
  }

  /**
   * Move `playedAt` of the library entries these listens were played from (POST /me/listens, after they are
   * stored): a `liked_songs` source marks Liked songs, a `playlist` source marks that playlist when it is in the
   * library (the user's own, or saved; someone else's playlist that is not saved is left alone). The time is the
   * newest `endedAt` per entry, never ahead of this server's clock; it never moves back. Guests have no library.
   * @param {object} auth `req.auth`
   * @param {object[]} listens the listens just stored (`source`, `endedAt`)
   */
  async function markPlayed(auth, listens) {
    if (!auth || auth.accountType === 'guest' || !Array.isArray(listens) || listens.length === 0) return;
    const userId = userOf(auth);
    const at = now();
    const newest = new Map();
    for (const { source, endedAt } of listens) {
      if (!source || !isDate(new Date(endedAt))) continue;
      // A stored listen keeps the source's id as an ObjectId.
      const sourceId = source.id ? String(source.id).toLowerCase() : '';
      let key;
      if (source.type === 'liked_songs') key = null;
      else if (source.type === 'playlist' && OBJECT_ID.test(sourceId)) key = sourceId;
      else continue;
      const playedAt = Math.min(new Date(endedAt).getTime(), at);
      if (!newest.has(key) || newest.get(key) < playedAt) newest.set(key, playedAt);
    }
    if (newest.size === 0) return;
    const playlistIds = [...newest.keys()].filter((key) => key !== null);
    const own = byId((playlistIds.length > 0 ? await contents.findByIds(playlistIds, { type: 1, ownerId: 1, createdAt: 1 }) : [])
      .filter((doc) => doc.type === 'playlist' && String(doc.ownerId).toLowerCase() === userId));
    const plays = [...newest].map(([key, playedAt]) => {
      if (key === null) return { playlistId: null, playedAt: new Date(playedAt), create: {} };
      const mine = own.get(key);
      const create = mine ? { kind: 'playlist', savedAt: isDate(mine.createdAt) ? mine.createdAt : new Date(at) } : null;
      return { playlistId: key, playedAt: new Date(playedAt), create };
    });
    await library.markPlayed({ userId, plays });
  }

  return { listLikedSongs, likeSong, unlikeSong, listLibraryPlaylists, songLibraryState, setSongPlaylists, markPlayed };
}

module.exports = {
  createLibraryService,
  likedSongsIdOf,
  LIKED_SONGS_TITLE,
  SORTS,
  CURSOR_TTL_MS,
  LOCK_LEASE_MS,
  LOCK_WAIT_MS,
  LIKED_DEFAULT_LIMIT,
  LIBRARY_DEFAULT_LIMIT,
  ...createLibraryService(),
};
