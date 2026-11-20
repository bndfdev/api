/**
 * Artist pages and following artists (docs/api/paths/artists.yaml, tag Artists; design notes in docs/api/PLAYER.md,
 * "Artist page"). The rules only: no HTTP and no database access of its own; the clock is injected.
 *
 * - An artist is an account (`users`) that has published at least one song (`contents` of type `song`, hidden ones
 *   included): `Song.artist.id`. Anyone else, an unknown id and an id in no known format are 404 NOT_FOUND.
 * - The page: the account's name (as `ArtistSummary`: '' when it has none), avatar and banner (`Image`, as on
 *   `GET /me`), `genre` (not stored yet: null), the follow counts, whether the viewer follows (never for a guest,
 *   who cannot follow, or for the artist themselves), and the releases.
 * - Releases: the artist's albums and songs that are not hidden, newest first (`createdAt`, then id), at most
 *   `MAX_RELEASES`. A song on an album is listed too. `plays` is a song's `listens` (the counted listens kept by
 *   ./listens.js) and, for an album, the sum of its songs' (all of them, hidden ones too, as `GET /albums` lists
 *   them); an album's `songCount` is its songs as `GET /albums` counts them. Artwork as the player's: an album's own,
 *   a song's album's when it is on one, else its own (`Song.image`).
 * - Following: accounts only (the route answers guests). Following is idempotent and keeps the first `followedAt`;
 *   following yourself is 422 CANNOT_FOLLOW_SELF (checked first); following someone who is not an artist is 404.
 *   Unfollowing is idempotent and never 404, so a follower can always stop following, even an account that is no
 *   longer an artist.
 */
const { ApiError } = require('../../lib/problem');
const { iso } = require('../../lib/time');
const { storage: defaultStorage } = require('../../providers/storage');
const { toImage } = require('../users/service');
const defaultContents = require('../content/repo');
const defaultUsers = require('../users/repo');
const defaultFollows = require('./followsRepo');
const { artworkOf } = require('./service');
const { byId, albumIdsOf, albumOf } = require('./songs');

/** The most releases a page lists ("at most 200"). */
const MAX_RELEASES = 200;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const artistNotFound = () => new ApiError({
  status: 404, code: 'NOT_FOUND', title: 'Artist not found', detail: 'There is no artist with this id.',
});
const cannotFollowSelf = () => new ApiError({
  status: 422, code: 'CANNOT_FOLLOW_SELF', title: 'You can\'t follow yourself',
  errors: [{ field: 'artistId', code: 'CANNOT_FOLLOW_SELF', message: 'You can\'t follow yourself.' }],
});

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const isDate = (at) => at instanceof Date && !Number.isNaN(at.getTime());
/** When a release was published: its `createdAt`, else the time in its id. */
const releasedAtOf = (doc) => iso(isDate(doc.createdAt) ? doc.createdAt : doc._id.getTimestamp());
const isAccount = (auth) => Boolean(auth) && auth.accountType !== 'guest';

/**
 * @param {{contents?: object, users?: object, follows?: object, storage?: object, now?: () => number}} [deps]
 *   `contents` the content module's repo, `users` the users repo (`findArtistProfile`), `follows` ./followsRepo.js
 */
function createArtistService({
  contents = defaultContents,
  users = defaultUsers,
  follows = defaultFollows,
  storage = defaultStorage,
  now = Date.now,
} = {}) {
  const urlFor = (key) => storage.publicUrl(key);

  /** The artist's account, or 404 NOT_FOUND when there is none or it has published no song. */
  async function findArtist(artistId) {
    const id = String(artistId).toLowerCase();
    if (!OBJECT_ID.test(id)) throw artistNotFound();
    const [user, published] = await Promise.all([users.findArtistProfile(id), contents.hasSongs(id)]);
    if (!user || !published) throw artistNotFound();
    return { id, user };
  }

  /** The spec's `ArtistRelease` for each stored album and song, in the same order. */
  async function releasesOf(artistId, docs) {
    const albums = docs.filter((doc) => doc.type === 'album');
    const songs = docs.filter((doc) => doc.type === 'song');
    const albumIds = albumIdsOf(songs);
    const [stats, songAlbums] = await Promise.all([
      albums.length > 0 ? contents.albumStats({ ownerId: artistId, albumIds: albums.map((a) => String(a._id)) }) : new Map(),
      albumIds.length > 0 ? contents.findByIds(albumIds).then(byId) : new Map(),
    ]);
    return docs.map((doc) => {
      const id = String(doc._id);
      if (doc.type === 'album') {
        const stat = stats.get(id.toLowerCase()) || { songCount: 0, listens: 0 };
        return {
          id,
          kind: 'album',
          title: doc.title,
          releasedAt: releasedAtOf(doc),
          plays: count(stat.listens),
          songCount: count(stat.songCount),
          image: artworkOf(doc.image),
        };
      }
      const album = albumOf(doc, songAlbums);
      return {
        id,
        kind: 'song',
        title: doc.title,
        releasedAt: releasedAtOf(doc),
        plays: count(doc.listens),
        songCount: null,
        image: (album && artworkOf(album.image)) || artworkOf(doc.image),
      };
    });
  }

  /**
   * GET /artists/{artistId}.
   * @param {object | undefined} auth `req.auth` (an account or a guest)
   * @returns {Promise<object>} `Artist`
   */
  async function getArtist(auth, artistId) {
    const { id, user } = await findArtist(artistId);
    const viewer = isAccount(auth) ? String(auth.userId).toLowerCase() : null;
    const [docs, { followers, following }, followed] = await Promise.all([
      contents.releases({ ownerId: id, limit: MAX_RELEASES }),
      follows.counts(id),
      viewer && viewer !== id ? follows.isFollowing({ followerId: viewer, artistId: id }) : false,
    ]);
    return {
      id: String(user._id),
      name: typeof user.name === 'string' ? user.name : '',
      avatar: toImage(user.avatar, urlFor),
      banner: toImage(user.banner, urlFor),
      genre: null,
      followerCount: count(followers),
      followingCount: count(following),
      following: followed === true,
      releases: await releasesOf(id, docs),
    };
  }

  /** PUT /me/following/artists/{artistId}: idempotent. @param {object} auth an account's `req.auth` */
  async function follow(auth, artistId) {
    if (String(artistId).toLowerCase() === String(auth.userId).toLowerCase()) throw cannotFollowSelf();
    const { id } = await findArtist(artistId);
    await follows.follow({ followerId: String(auth.userId), artistId: id, followedAt: new Date(now()) });
  }

  /** DELETE /me/following/artists/{artistId}: idempotent, never 404. @param {object} auth an account's `req.auth` */
  async function unfollow(auth, artistId) {
    await follows.unfollow({ followerId: String(auth.userId), artistId: String(artistId).toLowerCase() });
  }

  return { getArtist, follow, unfollow };
}

module.exports = { createArtistService, MAX_RELEASES, ...createArtistService() };
