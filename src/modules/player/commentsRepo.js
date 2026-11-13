/**
 * The only place that reads and writes `comments` (models/Comment.js) and `comment_likes` (models/CommentLike.js):
 * comments on songs, their replies and likes. A song's `commentCount` is `contents` (the content module's repo).
 * Returns plain objects.
 *
 * Pages are read by key ("everything after this comment"), not by skipping, on the `song_thread` index: a song's
 * top-level comments newest first, a comment's replies oldest first (the same index read backwards).
 */
const Comment = require('../../../models/Comment');
const CommentLike = require('../../../models/CommentLike');
const { addToCounter } = require('../../lib/counter');

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DUPLICATE_KEY = 11000;

/** A unique index refused the write (a duplicate key), and nothing else went wrong. */
const onlyDuplicate = (err) => Boolean(err) && err.code === DUPLICATE_KEY;
const idsIn = (ids) => [...new Set(ids.map((id) => String(id).toLowerCase()))].filter((id) => OBJECT_ID.test(id));
/** Counter updates are atomic update pipelines (src/lib/counter.js). */
const PIPELINE = Object.freeze({ updatePipeline: true });

/** The comment or reply with this id, or null (also for an id in no known format). */
function findById(id) {
  if (!OBJECT_ID.test(String(id))) return Promise.resolve(null);
  return Comment.findById(id).lean();
}

/** Whether a comment with this id exists. */
async function exists(id) {
  if (!OBJECT_ID.test(String(id))) return false;
  return (await Comment.exists({ _id: id })) !== null;
}

/**
 * Store a comment or a reply.
 * @param {{songId: string, parentId: string | null, authorId: string, text: string, createdAt: Date}} fields
 * @returns {Promise<object>} as stored, with its counters at 0
 */
async function create(fields) {
  const doc = await Comment.create(fields);
  return doc.toObject();
}

/**
 * One page of a song's top-level comments, newest first (`createdAt`, then id).
 * @param {{songId: string, limit: number, after?: {createdAt: Date, id: string} | null}} input `after` the last
 *   comment of the previous page
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
async function topLevelPage({ songId, limit, after = null }) {
  if (!OBJECT_ID.test(String(songId))) return { items: [], hasMore: false };
  const query = { songId, parentId: null };
  if (after) {
    query.$or = [
      { createdAt: { $lt: after.createdAt } },
      { createdAt: after.createdAt, _id: { $lt: after.id } },
    ];
  }
  const docs = await Comment.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  return { items: docs.slice(0, limit), hasMore: docs.length > limit };
}

/** How many top-level comments a song has (a comment page's `page.total`). */
function topLevelCount(songId) {
  if (!OBJECT_ID.test(String(songId))) return Promise.resolve(0);
  return Comment.countDocuments({ songId, parentId: null });
}

/**
 * One page of a comment's replies, oldest first (`createdAt`, then id).
 * @param {{songId: string, parentId: string, limit: number, after?: {createdAt: Date, id: string} | null}} input
 *   `songId` the comment's song (replies are stored with it); `after` the last reply of the previous page
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
async function repliesPage({ songId, parentId, limit, after = null }) {
  if (!OBJECT_ID.test(String(songId)) || !OBJECT_ID.test(String(parentId))) return { items: [], hasMore: false };
  const query = { songId, parentId };
  if (after) {
    query.$or = [
      { createdAt: { $gt: after.createdAt } },
      { createdAt: after.createdAt, _id: { $gt: after.id } },
    ];
  }
  const docs = await Comment.find(query).sort({ createdAt: 1, _id: 1 }).limit(limit + 1).lean();
  return { items: docs.slice(0, limit), hasMore: docs.length > limit };
}

/**
 * The first replies (oldest first) of each of these comments of one song: one indexed read of at most `limit`
 * replies per comment, all at once.
 * @param {{songId: string, parentIds: string[], limit: number}} input
 * @returns {Promise<Map<string, object[]>>} comment id (lower case) to its first replies; a comment without replies
 *   is not in it
 */
async function firstReplies({ songId, parentIds, limit }) {
  const wanted = idsIn(parentIds);
  if (!OBJECT_ID.test(String(songId)) || wanted.length === 0) return new Map();
  const lists = await Promise.all(wanted.map((parentId) => Comment.find({ songId, parentId })
    .sort({ createdAt: 1, _id: 1 }).limit(limit).lean()));
  return new Map(wanted.flatMap((id, i) => (lists[i].length > 0 ? [[id, lists[i]]] : [])));
}

/**
 * Each song's newest top-level comment (`Song.latestComment`): one indexed lookup per song, all at once.
 * @param {string[]} songIds
 * @returns {Promise<Map<string, object>>} song id (lower case) to its newest top-level comment; a song without
 *   comments is not in it
 */
async function latestTopLevel(songIds) {
  const wanted = idsIn(songIds);
  const newest = await Promise.all(wanted.map((songId) => Comment.findOne({ songId, parentId: null })
    .sort({ createdAt: -1, _id: -1 }).lean()));
  return new Map(wanted.flatMap((id, i) => (newest[i] ? [[id, newest[i]]] : [])));
}

/**
 * Change a top-level comment's `replyCount` by `delta`, atomically, never below 0.
 * @returns {Promise<boolean>} whether that top-level comment exists (a reply, or a deleted comment, changes nothing)
 */
async function addReplies(commentId, delta) {
  if (!OBJECT_ID.test(String(commentId))) return false;
  const { matchedCount } = await Comment.updateOne({ _id: commentId, parentId: null }, addToCounter('replyCount', delta), PIPELINE);
  return matchedCount > 0;
}

/**
 * Change a comment's or a reply's `likeCount` by `delta`, atomically, never below 0.
 * @returns {Promise<boolean>} whether the comment exists
 */
async function addLikes(commentId, delta) {
  if (!OBJECT_ID.test(String(commentId))) return false;
  const { matchedCount } = await Comment.updateOne({ _id: commentId }, addToCounter('likeCount', delta), PIPELINE);
  return matchedCount > 0;
}

/**
 * Delete one comment or reply (not its replies: see `replyIds` and `removeMany`).
 * @returns {Promise<boolean>} true when this call deleted it, false when it was not there
 */
async function remove(commentId) {
  if (!OBJECT_ID.test(String(commentId))) return false;
  const { deletedCount } = await Comment.deleteOne({ _id: commentId });
  return deletedCount > 0;
}

/**
 * The ids of a comment's replies.
 * @param {{songId: string, parentId: string}} input
 * @returns {Promise<string[]>}
 */
async function replyIds({ songId, parentId }) {
  if (!OBJECT_ID.test(String(songId)) || !OBJECT_ID.test(String(parentId))) return [];
  const rows = await Comment.find({ songId, parentId }, { _id: 1 }).lean();
  return rows.map((row) => String(row._id));
}

/**
 * Delete these comments.
 * @param {string[]} ids
 * @returns {Promise<number>} how many this call deleted (one already deleted elsewhere is not counted)
 */
async function removeMany(ids) {
  const wanted = idsIn(ids);
  if (wanted.length === 0) return 0;
  const { deletedCount } = await Comment.deleteMany({ _id: { $in: wanted } });
  return deletedCount;
}

/**
 * Like a comment (the `comment_user` unique index keeps one row, so liking twice at once stores one).
 * @param {{commentId: string, userId: string, createdAt: Date}} like
 * @returns {Promise<boolean>} true when this call liked it, false when it was liked already
 */
async function addLike({ commentId, userId, createdAt }) {
  try {
    await CommentLike.create({ commentId, userId, createdAt });
    return true;
  } catch (err) {
    if (onlyDuplicate(err)) return false;
    throw err;
  }
}

/**
 * Unlike a comment.
 * @param {{commentId: string, userId: string}} like
 * @returns {Promise<boolean>} true when this call took the like out, false when there was none
 */
async function removeLike({ commentId, userId }) {
  if (!OBJECT_ID.test(String(commentId)) || !OBJECT_ID.test(String(userId))) return false;
  const { deletedCount } = await CommentLike.deleteOne({ commentId, userId });
  return deletedCount > 0;
}

/**
 * Which of these comments the user liked, in one read (`comment_user`).
 * @param {{userId: string, commentIds: string[]}} input
 * @returns {Promise<Set<string>>} comment ids, lower case
 */
async function likedAmong({ userId, commentIds }) {
  const wanted = idsIn(commentIds);
  if (!OBJECT_ID.test(String(userId)) || wanted.length === 0) return new Set();
  const rows = await CommentLike.find({ commentId: { $in: wanted }, userId }, { _id: 0, commentId: 1 }).lean();
  return new Set(rows.map((row) => String(row.commentId)));
}

/** Delete every like of these comments (they were deleted). */
async function removeLikesOf(commentIds) {
  const wanted = idsIn(commentIds);
  if (wanted.length > 0) await CommentLike.deleteMany({ commentId: { $in: wanted } });
}

module.exports = {
  findById, exists, create, topLevelPage, topLevelCount, repliesPage, firstReplies, latestTopLevel, addReplies, addLikes,
  remove, replyIds, removeMany, addLike, removeLike, likedAmong, removeLikesOf,
};
