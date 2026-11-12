/**
 * The only place that reads and writes `playlist_items` (models/PlaylistItem.js) and `transcripts`
 * (models/Transcript.js), the media player's own collections apart from listens (./listensRepo.js). The songs,
 * albums and playlists themselves are `contents`, read through the content module's repo. Returns plain objects.
 *
 * A playlist's songs are read by key ("everything after this item"), not by skipping, on the `playlist_order`
 * index, so a page costs the same however deep it is.
 */
const mongoose = require('mongoose');
const PlaylistItem = require('../../../models/PlaylistItem');
const Transcript = require('../../../models/Transcript');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

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

module.exports = { playlistPage, playlistSummary, playlistCount, transcriptLanguages, findTranscript };
