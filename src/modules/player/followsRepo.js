/**
 * The only place that reads and writes `follows` (models/Follow.js): accounts following artists. Returns plain
 * values. Ids in no known format follow nobody and are followed by nobody.
 */
const Follow = require('../../../models/Follow');

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DUPLICATE_KEY = 11000;

const isId = (id) => OBJECT_ID.test(String(id));

/**
 * Follow an artist (the `follower_artist` unique index keeps one row, so following twice at once stores one).
 * @param {{followerId: string, artistId: string, followedAt: Date}} follow
 * @returns {Promise<boolean>} true when this call followed, false when it was followed already (`followedAt` kept)
 */
async function follow({ followerId, artistId, followedAt }) {
  try {
    await Follow.create({ followerId, artistId, followedAt });
    return true;
  } catch (err) {
    if (err && err.code === DUPLICATE_KEY) return false;
    throw err;
  }
}

/**
 * Stop following an artist.
 * @param {{followerId: string, artistId: string}} follow
 * @returns {Promise<boolean>} true when this call took the row out, false when there was none
 */
async function unfollow({ followerId, artistId }) {
  if (!isId(followerId) || !isId(artistId)) return false;
  const { deletedCount } = await Follow.deleteOne({ followerId, artistId });
  return deletedCount > 0;
}

/**
 * Whether the account follows the artist (`follower_artist`).
 * @param {{followerId: string, artistId: string}} input
 */
async function isFollowing({ followerId, artistId }) {
  if (!isId(followerId) || !isId(artistId)) return false;
  return (await Follow.exists({ followerId, artistId })) !== null;
}

/**
 * How many accounts follow the artist (`artist_followers`), and how many artists the artist follows
 * (`follower_artist`).
 * @param {string} artistId
 * @returns {Promise<{followers: number, following: number}>}
 */
async function counts(artistId) {
  if (!isId(artistId)) return { followers: 0, following: 0 };
  const [followers, following] = await Promise.all([
    Follow.countDocuments({ artistId }),
    Follow.countDocuments({ followerId: artistId }),
  ]);
  return { followers, following };
}

module.exports = { follow, unfollow, isFollowing, counts };
