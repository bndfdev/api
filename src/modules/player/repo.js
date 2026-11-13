/**
 * The only place that reads and writes `playlist_items` (models/PlaylistItem.js) and `transcripts`
 * (models/Transcript.js), the media player's own collections apart from listens (./listensRepo.js). The songs,
 * albums and playlists themselves are `contents`, read through the content module's repo. Returns plain objects.
 *
 * A playlist's songs are read by key ("everything after this item"), not by skipping, on the `playlist_order`
 * index, so a page costs the same however deep it is. Add to Playlist (./library.js) adds and removes items here.
 */
const mongoose = require('mongoose');
const PlaylistItem = require('../../../models/PlaylistItem');
const Transcript = require('../../../models/Transcript');

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DUPLICATE_KEY = 11000;

/** A write error's code: the driver's `WriteError` has it as a getter, a copy may keep it in `err`. */
const codeOf = (writeError) => (writeError && (writeError.code ?? (writeError.err && writeError.err.code)));

/**
 * One page of a playlist's items, in playlist order (position, then id).
 * @param {{playlistId: string, limit: number, after?: {position: number, id: string} | null}} input `after` the
 *   position and id of the last item of the previous page
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
async function playlistPage({ playlistId, limit, after = null }) {
  if (!OBJECT_ID.test(String(playlistId))) return { items: [], hasMore: false };
  const query = { playlistId };
  if (after) {
    query.$or = [
      { position: { $gt: after.position } },
      { position: after.position, _id: { $gt: after.id } },
    ];
  }
  const docs = await PlaylistItem.find(query).sort({ position: 1, _id: 1 }).limit(limit + 1).lean();
  return { items: docs.slice(0, limit), hasMore: docs.length > limit };
}

/**
 * A playlist's size and what its header needs, in one pass over its items.
 * @param {string} playlistId
 * @returns {Promise<{count: number, songIds: string[], lastAddedAt: Date | null}>}
 */
async function playlistSummary(playlistId) {
  if (!OBJECT_ID.test(String(playlistId))) return { count: 0, songIds: [], lastAddedAt: null };
  const [row] = await PlaylistItem.aggregate([
    { $match: { playlistId: new mongoose.Types.ObjectId(String(playlistId)) } },
    { $group: { _id: null, count: { $sum: 1 }, songIds: { $push: '$songId' }, lastAddedAt: { $max: '$addedAt' } } },
  ]);
  if (!row) return { count: 0, songIds: [], lastAddedAt: null };
  return { count: row.count, songIds: row.songIds.map(String), lastAddedAt: row.lastAddedAt || null };
}

/** How many items a playlist has (its `songCount`, a page's `total`). */
function playlistCount(playlistId) {
  if (!OBJECT_ID.test(String(playlistId))) return Promise.resolve(0);
  return PlaylistItem.countDocuments({ playlistId });
}

/**
 * Each playlist's size and newest addition, in one pass (the library's playlists).
 * @param {string[]} playlistIds
 * @returns {Promise<Map<string, {count: number, lastAddedAt: Date | null}>>} by id (lower case); a playlist with no
 *   items is not in it
 */
async function playlistStats(playlistIds) {
  const wanted = [...new Set(playlistIds.map((id) => String(id).toLowerCase()))].filter((id) => OBJECT_ID.test(id));
  if (wanted.length === 0) return new Map();
  const rows = await PlaylistItem.aggregate([
    { $match: { playlistId: { $in: wanted.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: '$playlistId', count: { $sum: 1 }, lastAddedAt: { $max: '$addedAt' } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), { count: row.count, lastAddedAt: row.lastAddedAt || null }]));
}

/**
 * A song's items in any of these playlists (which of them hold it), on the `playlist_song` index.
 * @param {{songId: string, playlistIds: string[]}} input
 * @returns {Promise<object[]>} whole items, in no particular order
 */
function songItems({ songId, playlistIds }) {
  const wanted = playlistIds.filter((id) => OBJECT_ID.test(String(id)));
  if (!OBJECT_ID.test(String(songId)) || wanted.length === 0) return Promise.resolve([]);
  return PlaylistItem.find({ playlistId: { $in: wanted }, songId }).lean();
}

/**
 * The highest position in each playlist, one indexed lookup each (`playlist_order`, read backwards).
 * @param {string[]} playlistIds
 * @returns {Promise<Map<string, number>>} by id (lower case); an empty playlist is not in it
 */
async function lastPositions(playlistIds) {
  const wanted = [...new Set(playlistIds.map((id) => String(id).toLowerCase()))].filter((id) => OBJECT_ID.test(id));
  const tops = await Promise.all(wanted.map((playlistId) => PlaylistItem.findOne({ playlistId }, { position: 1 })
    .sort({ position: -1, _id: -1 }).lean()));
  return new Map(wanted.flatMap((id, i) => (tops[i] && Number.isFinite(tops[i].position) ? [[id, tops[i].position]] : [])));
}

/**
 * Items to add, checked against the model, each with a new id made here, so that a change that fails part-way can
 * be undone exactly.
 * @param {Array<{playlistId: string, songId: string, position: number, addedAt: Date}>} specs
 * @returns {object[]} plain items, ids as ObjectIds
 */
function newItems(specs) {
  return specs.map((spec) => {
    const item = new PlaylistItem(spec);
    const invalid = item.validateSync();
    if (invalid) throw invalid;
    return item.toObject();
  });
}

/** Write ops in one round trip, unordered; an insert refused by a unique index (already there) is not an error. */
async function bulkIgnoringDuplicates(collection, ops) {
  if (ops.length === 0) return;
  try {
    await collection.bulkWrite(ops, { ordered: false });
  } catch (err) {
    const writeErrors = [].concat(err.writeErrors || []);
    if (writeErrors.length === 0 || writeErrors.some((writeError) => codeOf(writeError) !== DUPLICATE_KEY)) throw err;
  }
}

/**
 * Add and remove items in one round trip (Add to Playlist). Not atomic on its own: the library runs one change per
 * account at a time and calls `undoItems` when anything fails. Adding a song a playlist already holds changes
 * nothing (the `playlist_song` index refuses the copy).
 * @param {{add: object[], remove: object[]}} change `add` from `newItems`, `remove` the whole items to delete
 */
function changeItems({ add, remove }) {
  return bulkIgnoringDuplicates(PlaylistItem.collection, [
    ...add.map((document) => ({ insertOne: { document } })),
    ...remove.map((item) => ({ deleteOne: { filter: { _id: item._id } } })),
  ]);
}

/**
 * Undo `changeItems` with the same `add` and `remove`, however much of it happened: delete what it added, put back
 * what it removed exactly as it was (same id, position and `addedAt`). Safe to run more than once.
 * @param {{add: object[], remove: object[]}} change
 */
async function undoItems({ add, remove }) {
  if (add.length > 0) await PlaylistItem.deleteMany({ _id: { $in: add.map((item) => item._id) } });
  await bulkIgnoringDuplicates(PlaylistItem.collection, remove.map((document) => ({ insertOne: { document } })));
}

/**
 * The languages a song has a transcript in, without the lines.
 * @param {string} songId
 * @returns {Promise<Array<{language: string, translatedFrom: string | null}>>} in no particular order
 */
function transcriptLanguages(songId) {
  if (!OBJECT_ID.test(String(songId))) return Promise.resolve([]);
  return Transcript.find({ songId }, { _id: 0, language: 1, translatedFrom: 1 }).lean();
}

/**
 * A song's transcript in one language (the tag exactly as stored), or null.
 * @param {string} songId
 * @param {string} language
 */
function findTranscript(songId, language) {
  if (!OBJECT_ID.test(String(songId))) return Promise.resolve(null);
  return Transcript.findOne({ songId, language }).lean();
}

module.exports = {
  playlistPage, playlistSummary, playlistCount, playlistStats, songItems, lastPositions, newItems, changeItems, undoItems,
  transcriptLanguages, findTranscript,
};
