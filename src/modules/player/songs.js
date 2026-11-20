/**
 * What a stored song is to the player: who may play it, whether it can be streamed, its length and its album.
 * Shared by the player's reads (./service.js) and listens (./listens.js). Pure rules over `contents` documents:
 * no HTTP and no database access.
 */

/** Items by their id (as a lower-case string). */
const byId = (docs) => new Map(docs.map((doc) => [String(doc._id).toLowerCase(), doc]));

/** Restrict Content is on for the song or for its album. */
const followersOnlyOf = (song, album) => song.followersOnly === true || Boolean(album && album.followersOnly === true);

/**
 * Whether the viewer may play the song: anyone, unless it is followers-only. Then only the artist's followers may,
 * and follows (`follows`, ./artists.js) do not open it yet (docs/api/PLAYER.md), so only the artist (the account
 * that published it) can.
 * Guests never can.
 * @param {{userId: string, accountType: string} | undefined} auth `req.auth`
 */
function mayPlay(auth, song, album) {
  if (!followersOnlyOf(song, album)) return true;
  return Boolean(auth) && auth.accountType !== 'guest' &&
    String(auth.userId).toLowerCase() === String(song.ownerId).toLowerCase();
}

/**
 * The song's audio when it can be streamed: processed (`status: ready`), with a storage key, a type and a size.
 * @returns {object | null} the stored `audio`, or null (no audio yet, still processing, failed, or incomplete)
 */
function readyAudioOf(song) {
  const { audio } = song;
  if (!audio || audio.status !== 'ready') return null;
  if (typeof audio.key !== 'string' || audio.key === '' || typeof audio.mimeType !== 'string' || audio.mimeType === '') return null;
  if (!Number.isInteger(audio.sizeBytes) || audio.sizeBytes < 1) return null;
  return audio;
}

/** Length in milliseconds: the audio file's once it is ready, else the stored `durationSec` (0 when neither is usable). */
function durationMsOf(song) {
  const audio = readyAudioOf(song);
  if (audio && Number.isInteger(audio.durationMs) && audio.durationMs >= 0) return audio.durationMs;
  const seconds = song.durationSec;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 0;
}

/** The album ids these songs point at, each once. */
const albumIdsOf = (songs) => [...new Set(songs.filter((song) => song.albumId).map((song) => String(song.albumId).toLowerCase()))];

/**
 * The album a song is on: the item its `albumId` names, when that is an album of the same owner. Anything else
 * (no `albumId`, an album that no longer exists, another type, someone else's album) makes it a single: null.
 * @param {Map<string, object>} albumsById items by id (see `byId`), as read for `albumIdsOf`
 */
function albumOf(song, albumsById) {
  if (!song.albumId) return null;
  const album = albumsById.get(String(song.albumId).toLowerCase());
  if (!album || album.type !== 'album') return null;
  return String(album.ownerId) === String(song.ownerId) ? album : null;
}

module.exports = { byId, followersOnlyOf, mayPlay, readyAudioOf, durationMsOf, albumIdsOf, albumOf };
