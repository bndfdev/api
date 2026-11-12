/**
 * The media player's listening side (docs/api/paths/player.yaml, tag Player; design notes in docs/api/PLAYER.md):
 * songs, albums, playlists, playback addresses and transcripts. Listens are ./listens.js. The rules only: no HTTP
 * and no database access of its own; the clock is injected. Guests and accounts alike.
 *
 * - Songs, albums and playlists are `contents` items of that `type`. An unknown id, an id in no known format and an
 *   item of another type (an album's id asked as a song) are all 404 CONTENT_NOT_FOUND.
 * - Hidden items (Hide Content) still answer by id, in albums, in playlists and in lists of songs: hiding only takes
 *   an item off its owner's Profile.
 * - Followers-only (Restrict Content on the song or on its album) songs are still described, with
 *   `playable: false` for a viewer who may not play them (./songs.js), and their playback address and transcript
 *   are 403 CONTENT_RESTRICTED. Restrict Content on a playlist changes nothing here (not specified yet).
 * - `Song.image` is the album's artwork when the song is on an album and the album has artwork, else the song's
 *   own; palette and BlurHash are read as stored (null when absent), never worked out here.
 * - `liked`, `commentCount` and `latestComment` come from `social` (see NO_SOCIAL), which the Library and Comments
 *   steps replace.
 * - A playlist's songs are its `playlist_items`, in position order. An item whose song no longer exists (nothing
 *   deletes songs yet) is left out of the page but still counted in `songCount` and `page.total`.
 * - Playlist pages: `limit` songs (1 to 50, 20 by default) and an opaque cursor, as for the Profile's content: a
 *   cursor only works for the same playlist and for 24 hours, otherwise CURSOR_INVALID (422). It holds the position
 *   and id of the last item shown, and the next page starts just after it.
 */
const crypto = require('node:crypto');
const { ApiError } = require('../../lib/problem');
const { iso } = require('../../lib/time');
const { logger: defaultLogger } = require('../../lib/logger');
const { storage: defaultStorage } = require('../../providers/storage');
const { toImage, paletteOrNull, BLURHASH } = require('../users/service');
const defaultContents = require('../content/repo');
const defaultUsers = require('../users/repo');
const defaultItems = require('./repo');
const { byId, followersOnlyOf, mayPlay, readyAudioOf, durationMsOf, albumIdsOf, albumOf } = require('./songs');

/** How long a playback address works ("`url` works for 6 hours"). */
const PLAYBACK_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** "A cursor only works ... for 24 hours" (as for the Profile's content). */
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
/** How far ahead of this server's clock a cursor's time may be (another instance's clock). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The spec's `Song.waveform` bounds. */
const WAVEFORM_MAX = 1024;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
/** A BCP 47 tag, the spec's `TranscriptLanguage`. */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const contentNotFound = () => new ApiError({
  status: 404, code: 'CONTENT_NOT_FOUND', title: 'Content not found', detail: 'This item no longer exists.',
});
const contentRestricted = () => new ApiError({
  status: 403, code: 'CONTENT_RESTRICTED', title: 'Only followers can play this',
  detail: 'The artist has made this song available to their followers only.',
});
const audioUnavailable = () => new ApiError({
  status: 409, code: 'AUDIO_UNAVAILABLE', title: 'This song is not ready to play yet', detail: 'Try again later.',
});
const transcriptNotFound = () => new ApiError({
  status: 404, code: 'TRANSCRIPT_NOT_FOUND', title: 'No transcript in this language',
});
const cursorInvalid = () => new ApiError({
  status: 422, code: 'CURSOR_INVALID', title: 'Start again from the first page',
  detail: 'This page link has expired or belongs to another list.',
  errors: [{ field: 'cursor', code: 'CURSOR_INVALID', message: 'Start again from the first page.' }],
});

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const tagOrNull = (value) => (typeof value === 'string' && LANGUAGE_TAG.test(value) ? value : null);

/**
 * What the later steps of the player add to a song. Until they are built nobody has liked a song (step 2, the
 * Library, replaces `likedSongIds`), `commentCount` is the stored counter (0 until comments exist) and no song has a
 * latest comment (step 3, Comments, replaces `latestComments` and keeps the counter). Same signatures there.
 */
const NO_SOCIAL = Object.freeze({
  /** `(auth, songIds) => Promise<Set<string>>`: the ids among `songIds` the viewer has liked. */
  likedSongIds: async () => new Set(),
  /** `(song) => number`: every comment on the song, replies included. */
  commentCountOf: (song) => count(song.commentCount),
  /** `(auth, songIds) => Promise<Map<string, object>>`: song id to its newest top-level `Comment` (`replies: []`). */
  latestComments: async () => new Map(),
});

/** The spec's `Image` for stored artwork, with its palette and BlurHash as stored; null for none or an address that is not http(s). */
function artworkOf(stored) {
  if (!stored || typeof stored.url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(stored.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return {
    url: parsed.href,
    width: count(stored.width),
    height: count(stored.height),
    status: 'ready',
    blurhash: typeof stored.blurhash === 'string' && BLURHASH.test(stored.blurhash) ? stored.blurhash : null,
    palette: paletteOrNull(stored.palette),
  };
}

/** The stored waveform when it is in the spec's shape (1 to 1024 levels from 0 to 1), else null. */
function waveformOf(levels) {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > WAVEFORM_MAX) return null;
  if (!levels.every((level) => typeof level === 'number' && level >= 0 && level <= 1)) return null;
  return [...levels];
}

/** The stored transcript languages that are tags, each once, in their order. */
function languagesOf(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((tag) => tagOrNull(tag) !== null))];
}

/**
 * Every transcript language a song has, the original first (a transcript that is not a translation; by tag if
 * there are several), then the translations by tag. Rows whose language is not a tag are left out.
 * @param {Array<{language: string, translatedFrom: string | null}>} rows
 */
function orderLanguages(rows) {
  const usable = rows.filter((row) => tagOrNull(row.language) !== null);
  const byTag = (a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0);
  const originals = usable.filter((row) => tagOrNull(row.translatedFrom) === null).sort(byTag);
  const translations = usable.filter((row) => tagOrNull(row.translatedFrom) !== null).sort(byTag);
  return [...originals, ...translations];
}

/**
 * The language ranges of an Accept-Language header, most preferred first (by q-value, then by order); ranges with
 * q=0 are left out.
 * @returns {string[]} lower case, `*` included
 */
function preferredLanguages(header) {
  if (typeof header !== 'string') return [];
  return header.split(',').map((part, index) => {
    const [range, ...params] = part.split(';');
    const q = params.map((p) => /^\s*q=([01](?:\.\d{0,3})?)\s*$/i.exec(p)).find(Boolean);
    return { range: range.trim().toLowerCase(), q: q ? Number(q[1]) : 1, index };
  }).filter((r) => r.range !== '' && r.q > 0).sort((a, b) => b.q - a.q || a.index - b.index).map((r) => r.range);
}

/**
 * Which transcript to send (getSongTranscript): `language` when it is one the song has (any case), else none.
 * Without it, the first Accept-Language range (by preference) that the song has: the same tag, else the same main
 * subtag (`es-MX` finds `es`); `*` is the original. When nothing matches, the original.
 * @param {Array<{language: string}>} available as `orderLanguages` gives them, the original first
 * @returns {{language: string} | null}
 */
function chooseTranscript(available, language, acceptLanguage) {
  if (available.length === 0) return null;
  const tagOf = (row) => row.language.toLowerCase();
  if (typeof language === 'string') return available.find((row) => tagOf(row) === language.toLowerCase()) || null;
  for (const range of preferredLanguages(acceptLanguage)) {
    if (range === '*') return available[0];
    const exact = available.find((row) => tagOf(row) === range);
    if (exact) return exact;
    const main = range.split('-')[0];
    const sameMain = available.find((row) => tagOf(row).split('-')[0] === main);
    if (sameMain) return sameMain;
  }
  return available[0];
}

const isTime = (value) => Number.isInteger(value) && value >= 0;
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const timed = ({ text, startMs, endMs }) => isText(text) && isTime(startMs) && isTime(endMs) && endMs >= startMs;

/**
 * The stored lines in exactly the spec's shape (`TranscriptLine`: `{words}` or `{text, startMs, endMs}`). Words and
 * lines that are not (blank text, times that are not whole milliseconds or end before they start) are left out, and
 * so is a line left with no words. models/Transcript.js refuses them on write; this guards rows written elsewhere.
 */
function linesOf(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    if (Array.isArray(line.words)) {
      const words = line.words.filter((word) => word && timed(word))
        .map(({ text, startMs, endMs }) => ({ text, startMs, endMs }));
      if (words.length > 0) out.push({ words });
    } else if (timed(line)) {
      out.push({ text: line.text, startMs: line.startMs, endMs: line.endMs });
    }
  }
  return out;
}

/** What a playlist cursor is tied to: a hash of the playlist. */
const fingerprintOf = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);

/**
 * @param {{contents?: object, users?: object, items?: object, storage?: object, social?: object, now?: () => number,
 *   logger?: object}} [deps] `contents` the content module's repo, `users` the users repo (`findSummaries`), `items`
 *   ./repo.js, `social` what the Library and Comments steps add (NO_SOCIAL until then)
 */
function createPlayerService({
  contents = defaultContents,
  users = defaultUsers,
  items = defaultItems,
  storage = defaultStorage,
  social = NO_SOCIAL,
  now = Date.now,
  logger = defaultLogger,
} = {}) {
  const urlFor = (key) => storage.publicUrl(key);

  /** The item with this id if it is of this type, else 404 CONTENT_NOT_FOUND. */
  async function findItem(id, type) {
    const [doc] = await contents.findByIds([id]);
    if (!doc || doc.type !== type) throw contentNotFound();
    return doc;
  }

  /** The albums these songs point at, by id (any type: `albumOf` checks). */
  async function albumsFor(songs) {
    const ids = albumIdsOf(songs);
    return byId(ids.length > 0 ? await contents.findByIds(ids) : []);
  }

  /** The users with these ids (name and avatar), by id. */
  async function peopleById(ids) {
    return byId(await users.findSummaries(ids.map(String)));
  }

  /** The spec's `ArtistSummary`: the account that published it. An account that has no name (or no longer exists) reads as ''. */
  function artistOf(ownerId, people) {
    const person = people.get(String(ownerId).toLowerCase());
    return {
      id: String(ownerId),
      name: person && typeof person.name === 'string' ? person.name : '',
      image: person ? toImage(person.avatar, urlFor) : null,
    };
  }

  /** The spec's `UserSummary` (a playlist's owner): `name` null when there is none. */
  function ownerOf(ownerId, people) {
    const person = people.get(String(ownerId).toLowerCase());
    return {
      id: String(ownerId),
      name: person && typeof person.name === 'string' && person.name !== '' ? person.name : null,
      avatar: person ? toImage(person.avatar, urlFor) : null,
    };
  }

  /**
   * The spec's `Song` for each stored song, for this viewer, in the same order.
   * @param {object | undefined} auth `req.auth`
   * @param {object[]} songs `contents` documents of type `song`
   * @param {Map<string, object>} albumsById as `albumsFor` reads them
   * @param {Map<string, object>} [people] the songs' owners, when already read
   */
  async function present(auth, songs, albumsById, people = null) {
    if (songs.length === 0) return [];
    const ids = songs.map((song) => String(song._id));
    const [owners, liked, latest] = await Promise.all([
      people || peopleById(songs.map((song) => song.ownerId)),
      social.likedSongIds(auth, ids),
      social.latestComments(auth, ids),
    ]);
    return songs.map((song, i) => {
      const album = albumOf(song, albumsById);
      return {
        id: ids[i],
        title: song.title,
        artist: artistOf(song.ownerId, owners),
        album: album ? { id: String(album._id), title: album.title } : null,
        image: (album && artworkOf(album.image)) || artworkOf(song.image),
        durationMs: durationMsOf(song),
        waveform: waveformOf(song.waveform),
        transcriptLanguages: languagesOf(song.transcriptLanguages),
        listens: count(song.listens),
        commentCount: social.commentCountOf(song),
        latestComment: latest.get(ids[i]) || null,
        liked: liked.has(ids[i]),
        followersOnly: followersOnlyOf(song, album),
        playable: mayPlay(auth, song, album) && readyAudioOf(song) !== null,
      };
    });
  }

  /** A song and its album (null for a single), or 404. */
  async function songAndAlbum(songId) {
    const song = await findItem(songId, 'song');
    return { song, album: albumOf(song, await albumsFor([song])) };
  }

  function encodeCursor(item, fingerprint) {
    const body = { k: item.position, i: String(item._id), f: fingerprint, t: Math.floor(now() / 1000) };
    return Buffer.from(JSON.stringify(body)).toString('base64url');
  }

  /** Where a cursor says the page starts, or throws CURSOR_INVALID. No cursor is the first page (null). */
  function afterFrom(cursor, fingerprint) {
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
    if (f !== fingerprint || typeof i !== 'string' || !OBJECT_ID.test(i) || !Number.isInteger(t) || !Number.isFinite(k)) {
      throw cursorInvalid();
    }
    if (at - t * 1000 > CURSOR_TTL_MS || t * 1000 - at > CLOCK_SKEW_MS) throw cursorInvalid();
    return { position: k, id: i };
  }

  /** GET /songs/{songId}. @returns {Promise<object>} `Song` */
  async function getSong(auth, songId) {
    const song = await findItem(songId, 'song');
    const [result] = await present(auth, [song], await albumsFor([song]));
    return result;
  }

  /**
   * GET /songs?ids=: the songs found, in the order asked. Ids that are unknown or not songs are left out; an id
   * asked twice (in any case) is answered once, at its first place. The validator has checked 1 to 50 ids.
   * @param {string[]} ids
   * @returns {Promise<object>} `SongList`
   */
  async function listSongs(auth, ids) {
    const order = [...new Set(ids.map((id) => String(id).toLowerCase()))];
    const found = byId((await contents.findByIds(order)).filter((doc) => doc.type === 'song'));
    const songs = order.map((id) => found.get(id)).filter(Boolean);
    return { data: await present(auth, songs, await albumsFor(songs)) };
  }

  /**
   * GET /songs/{songId}/playback: where to stream it from for the next 6 hours.
   * With the local storage driver the address is the file's plain /media address, which does not really expire
   * (`expiresAt` is still now + 6 hours, so the app already behaves as it will with signed CDN addresses); an object
   * storage driver will sign it (docs/api/PLAYER.md, Storage).
   * @returns {Promise<object>} `Playback`
   */
  async function playback(auth, songId) {
    const { song, album } = await songAndAlbum(songId);
    if (!mayPlay(auth, song, album)) throw contentRestricted();
    const audio = readyAudioOf(song);
    if (!audio) throw audioUnavailable();
    let url;
    try {
      url = urlFor(audio.key);
    } catch (err) {
      logger.warn({ err, songId: String(song._id) }, 'a song\'s audio key cannot be served');
      throw audioUnavailable();
    }
    return {
      url,
      expiresAt: iso(now() + PLAYBACK_TTL_MS),
      mimeType: audio.mimeType,
      sizeBytes: audio.sizeBytes,
      durationMs: durationMsOf(song),
    };
  }

  /**
   * GET /songs/{songId}/transcript.
   * @param {{language?: string, acceptLanguage?: string}} input
   * @returns {Promise<object>} `Transcript`
   */
  async function transcript(auth, songId, { language, acceptLanguage } = {}) {
    const { song, album } = await songAndAlbum(songId);
    if (!mayPlay(auth, song, album)) throw contentRestricted();
    const id = String(song._id);
    const available = orderLanguages(await items.transcriptLanguages(id));
    const chosen = chooseTranscript(available, language, acceptLanguage);
    if (!chosen) throw transcriptNotFound();
    const doc = await items.findTranscript(id, chosen.language);
    const lines = doc ? linesOf(doc.lines) : [];
    if (lines.length === 0) throw transcriptNotFound();
    return {
      language: doc.language,
      translatedFrom: tagOrNull(doc.translatedFrom),
      lines,
      availableLanguages: available.map((row) => row.language),
    };
  }

  /** GET /albums/{albumId}: the album and every song on it, in album order. @returns {Promise<object>} `Album` */
  async function getAlbum(auth, albumId) {
    const album = await findItem(albumId, 'album');
    const id = String(album._id);
    const [songs, people] = await Promise.all([
      contents.albumSongs({ albumId: id, ownerId: String(album.ownerId) }),
      peopleById([album.ownerId]),
    ]);
    const presented = await present(auth, songs, new Map([[id, album]]), people);
    return {
      id,
      title: album.title,
      artist: artistOf(album.ownerId, people),
      image: artworkOf(album.image),
      year: Number.isInteger(album.year) ? album.year : null,
      durationMs: presented.reduce((sum, song) => sum + song.durationMs, 0),
      songCount: presented.length,
      songs: presented,
    };
  }

  /**
   * GET /playlists/{playlistId}: the header. `updatedAt` is when the newest song was added (the playlist's
   * creation while it has none); taking songs out comes with Add to Playlist (step 2), which will store it.
   * @returns {Promise<object>} `Playlist`
   */
  async function getPlaylist(auth, playlistId) {
    const playlist = await findItem(playlistId, 'playlist');
    const id = String(playlist._id);
    const [summary, people] = await Promise.all([items.playlistSummary(id), peopleById([playlist.ownerId])]);
    const lengths = summary.songIds.length > 0
      ? await contents.findByIds(summary.songIds, { type: 1, durationSec: 1, audio: 1 })
      : [];
    const changed = [summary.lastAddedAt, playlist.createdAt].find((at) => at instanceof Date && !Number.isNaN(at.getTime()));
    return {
      id,
      title: playlist.title,
      owner: ownerOf(playlist.ownerId, people),
      image: artworkOf(playlist.image),
      songCount: summary.count,
      durationMs: lengths.filter((doc) => doc.type === 'song').reduce((sum, doc) => sum + durationMsOf(doc), 0),
      updatedAt: iso(changed || 0),
    };
  }

  /**
   * GET /playlists/{playlistId}/songs.
   * @param {{limit?: number, cursor?: string}} input
   * @returns {Promise<object>} `SongPage`
   */
  async function listPlaylistSongs(auth, playlistId, { limit, cursor } = {}) {
    const playlist = await findItem(playlistId, 'playlist');
    const id = String(playlist._id);
    const n = Number(limit);
    const size = Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : DEFAULT_LIMIT;
    const fingerprint = fingerprintOf(['playlist-songs', id]);
    const after = afterFrom(cursor, fingerprint);
    const [{ items: rows, hasMore }, total] = await Promise.all([
      items.playlistPage({ playlistId: id, limit: size, after }),
      items.playlistCount(id),
    ]);
    const found = byId((await contents.findByIds(rows.map((row) => String(row.songId)))).filter((doc) => doc.type === 'song'));
    const songs = rows.map((row) => found.get(String(row.songId).toLowerCase())).filter(Boolean);
    return {
      data: await present(auth, songs, await albumsFor(songs)),
      page: { nextCursor: hasMore ? encodeCursor(rows[rows.length - 1], fingerprint) : null, hasMore, total },
    };
  }

  return { getSong, listSongs, playback, transcript, getAlbum, getPlaylist, listPlaylistSongs };
}

module.exports = {
  createPlayerService,
  NO_SOCIAL,
  PLAYBACK_TTL_MS,
  CURSOR_TTL_MS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  preferredLanguages,
  chooseTranscript,
  ...createPlayerService(),
};
