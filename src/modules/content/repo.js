/**
 * The only place that reads and writes the `contents` collection (models/Content.js): the user's own content (the
 * Profile) and the media player's songs, albums and playlists. Returns plain objects.
 *
 * Pages are read by key ("everything after this item"), not by skipping: each sort has its own index that starts
 * with `ownerId` and ends with `_id` (see the model), so a page costs the same however deep it is, and an item
 * added or hidden meanwhile does not shift the next page.
 */
const mongoose = require('mongoose');
const Content = require('../../../models/Content');
const { addToCounter } = require('../../lib/counter');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Each sort's field and direction; `_id` breaks ties in the same direction. */
const SORTS = Object.freeze({
  recent: { field: 'createdAt', direction: -1 },
  popular: { field: 'listens', direction: -1 },
  title: { field: 'titleLower', direction: 1 },
});

/**
 * The owner's items of this type (null: every type) and visibility (null: both). An item without `hidden` counts
 * as not hidden, as the service shows it.
 */
const filterFor = (ownerId, type, hidden) => ({
  ownerId,
  ...(type ? { type } : {}),
  ...(hidden === true ? { hidden: true } : {}),
  ...(hidden === false ? { hidden: { $ne: true } } : {}),
});

/**
 * One page of an owner's content.
 * @param {{ownerId: string, type: string | null, hidden?: boolean | null, sort: 'recent' | 'popular' | 'title',
 *   limit: number, after?: {value: Date | number | string, id: string} | null}} input `type` null for every type;
 *   `hidden` null for hidden and not; `after` the sort key and id of the last item of the previous page
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
async function page({ ownerId, type, hidden = null, sort, limit, after = null }) {
  if (!OBJECT_ID.test(String(ownerId))) return { items: [], hasMore: false };
  const { field, direction } = SORTS[sort];
  const query = filterFor(ownerId, type, hidden);
  if (after) {
    const beyond = direction === 1 ? '$gt' : '$lt';
    query.$or = [
      { [field]: { [beyond]: after.value } },
      { [field]: after.value, _id: { [beyond]: after.id } },
    ];
  }
  const docs = await Content.find(query).sort({ [field]: direction, _id: direction }).limit(limit + 1).lean();
  return { items: docs.slice(0, limit), hasMore: docs.length > limit };
}

/** How many items an owner has of this type and visibility (null: any). */
function count({ ownerId, type, hidden = null }) {
  if (!OBJECT_ID.test(String(ownerId))) return Promise.resolve(0);
  return Content.countDocuments(filterFor(ownerId, type, hidden));
}

/**
 * Change the privacy flags of one item, if this owner owns it.
 * @param {{ownerId: string, contentId: string, set: {hidden?: boolean, followersOnly?: boolean}}} input
 * @returns {Promise<object | null>} the item after the change; null when there is no such item for this owner
 */
function updateFlags({ ownerId, contentId, set }) {
  if (!OBJECT_ID.test(String(ownerId)) || !OBJECT_ID.test(String(contentId))) return Promise.resolve(null);
  return Content.findOneAndUpdate({ _id: contentId, ownerId }, { $set: set }, { returnDocument: 'after' }).lean();
}

/**
 * The owner's items among these ids (the Profile's hand-picked items), hidden and followers-only ones included.
 * Unknown ids, ids in no known format and other owners' items are left out.
 * @param {{ownerId: string, ids: string[]}} input
 * @returns {Promise<object[]>} in no particular order
 */
function findOwned({ ownerId, ids }) {
  const wanted = ids.filter((id) => OBJECT_ID.test(String(id)));
  if (!OBJECT_ID.test(String(ownerId)) || wanted.length === 0) return Promise.resolve([]);
  return Content.find({ _id: { $in: wanted }, ownerId }).lean();
}

/**
 * Items by id, whoever owns them and whatever their type or flags (the media player's songs, albums and playlists:
 * hidden and followers-only items still answer by id). Unknown ids and ids in no known format are left out.
 * @param {string[]} ids
 * @param {object} [fields] a projection, to read only some fields (a playlist's lengths, say)
 * @returns {Promise<object[]>} in no particular order
 */
function findByIds(ids, fields = undefined) {
  const wanted = [...new Set(ids.map((id) => String(id).toLowerCase()))].filter((id) => OBJECT_ID.test(id));
  if (wanted.length === 0) return Promise.resolve([]);
  return Content.find({ _id: { $in: wanted } }, fields).lean();
}

/**
 * The songs on an album, in album order (track number, then id; the `album_order` index): the album owner's songs
 * whose `albumId` is this album.
 * @param {{albumId: string, ownerId: string}} input
 * @returns {Promise<object[]>}
 */
function albumSongs({ albumId, ownerId }) {
  if (!OBJECT_ID.test(String(albumId)) || !OBJECT_ID.test(String(ownerId))) return Promise.resolve([]);
  return Content.find({ albumId, ownerId, type: 'song' }).sort({ trackNumber: 1, _id: 1 }).lean();
}

/**
 * Every playlist the owner made, hidden and followers-only ones included (the library's own playlists and Add to
 * Playlist's choices), on the `owner_recent` index.
 * @param {string} ownerId
 * @param {object} [fields] a projection
 * @returns {Promise<object[]>} in no particular order
 */
function ownPlaylists(ownerId, fields = undefined) {
  if (!OBJECT_ID.test(String(ownerId))) return Promise.resolve([]);
  return Content.find({ ownerId, type: 'playlist' }, fields).lean();
}

/**
 * Store what Add to Playlist changed on playlists, in one round trip: `songCount` (their number of items) and
 * `songsUpdatedAt` (null removes it).
 * @param {Array<{id: string, songCount: number, songsUpdatedAt: Date | null}>} stats
 */
async function setPlaylistStats(stats) {
  const ops = stats.filter(({ id }) => OBJECT_ID.test(String(id))).map(({ id, songCount, songsUpdatedAt }) => ({
    updateOne: {
      filter: { _id: id, type: 'playlist' },
      update: songsUpdatedAt
        ? { $set: { songCount, songsUpdatedAt } }
        : { $set: { songCount }, $unset: { songsUpdatedAt: '' } },
    },
  }));
  if (ops.length > 0) await Content.bulkWrite(ops, { ordered: false });
}

/**
 * Add counted listens to songs (`listens`), in one round trip.
 * @param {Map<string, number>} counts song id to the number of listens to add
 */
async function addListens(counts) {
  const ops = [...counts].filter(([id, n]) => OBJECT_ID.test(String(id)) && Number.isInteger(n) && n > 0)
    .map(([id, n]) => ({ updateOne: { filter: { _id: id, type: 'song' }, update: { $inc: { listens: n } } } }));
  if (ops.length > 0) await Content.bulkWrite(ops, { ordered: false });
}

/**
 * Change a song's `commentCount` (every comment on it, replies included) by `delta`, in one atomic step that never
 * takes it below 0. The song's `updatedAt` stays: a comment is not a change to the song.
 * @param {string} songId
 * @param {number} delta a whole number, up or down
 */
async function addComments(songId, delta) {
  if (!OBJECT_ID.test(String(songId))) return;
  await Content.updateOne({ _id: songId, type: 'song' }, addToCounter('commentCount', delta), {
    updatePipeline: true, timestamps: false,
  });
}

/**
 * Whether the owner has published a song (hidden ones count): what makes an account an artist. On `owner_recent`.
 * @param {string} ownerId
 * @returns {Promise<boolean>}
 */
async function hasSongs(ownerId) {
  if (!OBJECT_ID.test(String(ownerId))) return false;
  return (await Content.exists({ ownerId, type: 'song' })) !== null;
}

/**
 * An artist's releases for their page: the owner's albums and songs that are not hidden, newest first (`createdAt`,
 * then id), on the `owner_recent` index.
 * @param {{ownerId: string, limit: number}} input
 * @returns {Promise<object[]>}
 */
function releases({ ownerId, limit }) {
  if (!OBJECT_ID.test(String(ownerId))) return Promise.resolve([]);
  return Content.find({ ownerId, type: { $in: ['album', 'song'] }, hidden: { $ne: true } })
    .sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
}

/**
 * For each of these albums, its songs (the songs `albumSongs` lists: the album owner's songs whose `albumId` is
 * the album) counted, and their `listens` added up, in one aggregate on the `album_order` index.
 * @param {{ownerId: string, albumIds: string[]}} input
 * @returns {Promise<Map<string, {songCount: number, listens: number}>>} by album id, lower case; albums with no
 *   songs are not in it
 */
async function albumStats({ ownerId, albumIds }) {
  const wanted = [...new Set(albumIds.map((id) => String(id).toLowerCase()))].filter((id) => OBJECT_ID.test(id));
  if (!OBJECT_ID.test(String(ownerId)) || wanted.length === 0) return new Map();
  const { ObjectId } = mongoose.Types;
  const rows = await Content.aggregate([
    { $match: { albumId: { $in: wanted.map((id) => new ObjectId(id)) }, ownerId: new ObjectId(String(ownerId)), type: 'song' } },
    { $group: { _id: '$albumId', songCount: { $sum: 1 }, listens: { $sum: '$listens' } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), { songCount: row.songCount, listens: row.listens }]));
}

module.exports = {
  page, count, updateFlags, findOwned, findByIds, albumSongs, ownPlaylists, setPlaylistStats, addListens, addComments,
  hasSongs, releases, albumStats, SORTS,
};
