/**
 * Comments on songs (docs/api/paths/comments.yaml, tag Comments; design notes in docs/api/PLAYER.md): the player
 * drawer's Comments tab, and the pill under the player (`Song.latestComment`, ./service.js). The rules only: no HTTP
 * and no database access of its own; the clock is injected. Reading is open to guests; the routes refuse guests
 * everything else (GUEST_NOT_ALLOWED).
 *
 * - One level deep: top-level comments (`parentId` null) and their replies. A reply to a reply is stored under the
 *   same top-level comment, which the answer's `parentId` names.
 * - Who may read: whoever may play the song (./songs.js `mayPlay`). For anyone else a followers-only song's comments
 *   are 403 CONTENT_RESTRICTED: listing, replies, posting, liking and unliking. Deleting is not: the author may always
 *   delete their comment and the song's artist any comment on the song; anyone else gets 403 FORBIDDEN. A comment
 *   whose song no longer exists (nothing deletes songs yet) is COMMENT_NOT_FOUND, except to its author's delete.
 * - Text: well formed (a lone surrogate becomes U+FFFD), trimmed, then 1 to 500 characters, counted as Unicode code
 *   points as the spec's JSON Schema counts them; line breaks inside are kept. Otherwise 422 VALIDATION_FAILED on
 *   `/text`, checked before anything else.
 * - Pages: top-level comments newest first (`createdAt`, then id), each with its first 3 replies oldest first;
 *   replies paged oldest first (the first page repeats those 3, as the spec says). 1 to 50 a page (20 by default);
 *   an opaque cursor tied to the song (or to the comment) and good for 24 hours, otherwise CURSOR_INVALID.
 *   `commentCount` is the song's counter (replies included); `page.total` the song's top-level comments, or for
 *   replies the comment's `replyCount`. A reply's own replies are an empty page.
 * - Counters: `contents.commentCount`, a comment's `replyCount` and `likeCount`, each changed in one atomic step that
 *   never goes below 0 (src/lib/counter.js). Each moves up before its row is stored and down only after a row was
 *   really deleted (by this request), so with posts, likes and deletes running at once a counter is never below the
 *   real number and settles on it; a write that fails is undone.
 * - Deleting a top-level comment deletes its replies and every like of them. A reply stored while its comment was
 *   being deleted (the delete's sweep may have missed it) is deleted again by the request that stored it, which
 *   answers 404 COMMENT_NOT_FOUND; a like stored while its comment was deleted likewise. So no reply outlives its
 *   comment and no like its comment.
 * - Authors are `users` (`UserSummary`: `name` null when there is none, `avatar` the profile photo or null), read in
 *   one query per page, as are the viewer's likes (`likedByMe`). `isMine` is whether the viewer wrote it. Both are
 *   always false for a guest.
 */
const crypto = require('node:crypto');
const { ApiError } = require('../../lib/problem');
const { iso } = require('../../lib/time');
const { logger: defaultLogger } = require('../../lib/logger');
const { storage: defaultStorage } = require('../../providers/storage');
const { toImage } = require('../users/service');
const defaultContents = require('../content/repo');
const defaultUsers = require('../users/repo');
const defaultComments = require('./commentsRepo');
const { byId, mayPlay, albumIdsOf, albumOf } = require('./songs');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** How many replies a top-level comment carries in a page ("its first replies (up to 3, oldest first)"). */
const REPLIES_SHOWN = 3;
/** "Trimmed, then 1 to 500 characters". */
const TEXT_MAX = 500;
/** "A cursor only works ... for 24 hours". */
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
/** How far ahead of this server's clock a cursor's time may be (another instance's clock). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const contentNotFound = () => new ApiError({
  status: 404, code: 'CONTENT_NOT_FOUND', title: 'Content not found', detail: 'This item no longer exists.',
});
const contentRestricted = () => new ApiError({
  status: 403, code: 'CONTENT_RESTRICTED', title: 'Only followers can see this',
  detail: 'The artist has made this song and its comments available to their followers only.',
});
const commentNotFound = () => new ApiError({
  status: 404, code: 'COMMENT_NOT_FOUND', title: 'Comment not found', detail: 'This comment no longer exists.',
});
const forbidden = () => new ApiError({
  status: 403, code: 'FORBIDDEN', title: 'You can\'t delete this comment',
  detail: 'Only its author and the song\'s artist can delete it.',
});
const textInvalid = (message) => new ApiError({
  status: 422, code: 'VALIDATION_FAILED', title: 'Some details need fixing',
  errors: [{ field: '/text', code: 'VALIDATION_FAILED', message }],
});
const cursorInvalid = () => new ApiError({
  status: 422, code: 'CURSOR_INVALID', title: 'Start again from the first page',
  detail: 'This page link has expired or belongs to another list.',
  errors: [{ field: 'cursor', code: 'CURSOR_INVALID', message: 'Start again from the first page.' }],
});

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const idOf = (doc) => String(doc._id).toLowerCase();
const lower = (id) => String(id).toLowerCase();
/** What a cursor is tied to: a hash of the list it was made for. */
const fingerprintOf = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);
const pageSize = (limit) => {
  const n = Number(limit);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : DEFAULT_LIMIT;
};

/**
 * The text as stored: well formed, trimmed, then 1 to 500 characters; otherwise 422 VALIDATION_FAILED on `/text`.
 * @param {unknown} raw `text` as sent (the validator has checked it is a string of 1 to 1000)
 * @returns {string}
 */
function textOf(raw) {
  const text = typeof raw === 'string' ? raw.toWellFormed().trim() : '';
  const length = [...text].length;
  if (length === 0) throw textInvalid('Write something first.');
  if (length > TEXT_MAX) throw textInvalid(`Keep it to ${TEXT_MAX} characters.`);
  return text;
}

/**
 * @param {{contents?: object, users?: object, comments?: object, storage?: object, now?: () => number,
 *   logger?: object}} [deps] `contents` the content module's repo (`findByIds`, `addComments`), `users` the users
 *   repo (`findSummaries`), `comments` ./commentsRepo.js
 */
function createCommentService({
  contents = defaultContents,
  users = defaultUsers,
  comments = defaultComments,
  storage = defaultStorage,
  now = Date.now,
  logger = defaultLogger,
} = {}) {
  const urlFor = (key) => storage.publicUrl(key);
  /** The viewer's account id (lower case), or null for a guest: guests have no likes and wrote nothing. */
  const viewerOf = (auth) => (auth && auth.accountType !== 'guest' ? lower(auth.userId) : null);

  /** Put back what a failed write changed; a failure here is logged, the first error is what the request reports. */
  async function undo(work, message) {
    try {
      await work();
    } catch (err) {
      logger.error({ err }, message);
    }
  }

  /** The song with this id and its album (null for a single), or null when it is not a song. */
  async function songWithAlbum(songId) {
    const [song] = await contents.findByIds([songId]);
    if (!song || song.type !== 'song') return null;
    const albumIds = albumIdsOf([song]);
    return { song, album: albumOf(song, byId(albumIds.length > 0 ? await contents.findByIds(albumIds) : [])) };
  }

  /** The song, if the viewer may read its comments: else 404 CONTENT_NOT_FOUND or 403 CONTENT_RESTRICTED. */
  async function readableSong(auth, songId) {
    const found = await songWithAlbum(songId);
    if (!found) throw contentNotFound();
    if (!mayPlay(auth, found.song, found.album)) throw contentRestricted();
    return found.song;
  }

  /** The comment, if the viewer may read it: else 404 COMMENT_NOT_FOUND (also when its song is gone) or 403 CONTENT_RESTRICTED. */
  async function readableComment(auth, commentId) {
    const comment = await comments.findById(commentId);
    if (!comment) throw commentNotFound();
    const found = await songWithAlbum(comment.songId);
    if (!found) throw commentNotFound();
    if (!mayPlay(auth, found.song, found.album)) throw contentRestricted();
    return comment;
  }

  /** The spec's `UserSummary` of an author: `name` null when there is none (or the account no longer exists). */
  function authorOf(authorId, people) {
    const person = people.get(lower(authorId));
    return {
      id: lower(authorId),
      name: person && typeof person.name === 'string' && person.name !== '' ? person.name : null,
      avatar: person ? toImage(person.avatar, urlFor) : null,
    };
  }

  /**
   * The spec's `Comment` for each stored comment, for this viewer, in the same order. The authors and the viewer's
   * likes of every comment shown (the replies too) are read once, together. A top-level comment carries `replies`
   * (those given for it, else none); a reply carries none (the spec: absent on a reply).
   * @param {object | undefined} auth `req.auth`
   * @param {object[]} docs stored comments
   * @param {Map<string, object[]>} [replies] top-level comment id to its first replies
   * @returns {Promise<object[]>}
   */
  async function present(auth, docs, replies = new Map()) {
    const all = [...docs, ...docs.flatMap((doc) => replies.get(idOf(doc)) || [])];
    if (all.length === 0) return [];
    const viewer = viewerOf(auth);
    const [found, liked] = await Promise.all([
      users.findSummaries([...new Set(all.map((doc) => lower(doc.authorId)))]),
      viewer ? comments.likedAmong({ userId: viewer, commentIds: all.map(idOf) }) : new Set(),
    ]);
    const people = byId(found);
    const one = (doc) => {
      const id = idOf(doc);
      const isReply = Boolean(doc.parentId);
      return {
        id,
        parentId: isReply ? lower(doc.parentId) : null,
        author: authorOf(doc.authorId, people),
        text: doc.text,
        createdAt: iso(doc.createdAt),
        likeCount: count(doc.likeCount),
        likedByMe: liked.has(id),
        replyCount: isReply ? 0 : count(doc.replyCount),
        ...(isReply ? {} : { replies: (replies.get(id) || []).map(one) }),
        isMine: viewer !== null && lower(doc.authorId) === viewer,
      };
    };
    return docs.map(one);
  }

  function encodeCursor(doc, fingerprint) {
    const body = { k: doc.createdAt.getTime(), i: idOf(doc), f: fingerprint, t: Math.floor(now() / 1000) };
    return Buffer.from(JSON.stringify(body)).toString('base64url');
  }

  /** Where a cursor says the page starts (`{createdAt, id}` of the last comment shown), or throws CURSOR_INVALID. No cursor: null. */
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
    if (f !== fingerprint || typeof i !== 'string' || !OBJECT_ID.test(i) || !Number.isInteger(k) || !Number.isInteger(t)) {
      throw cursorInvalid();
    }
    if (at - t * 1000 > CURSOR_TTL_MS || t * 1000 - at > CLOCK_SKEW_MS) throw cursorInvalid();
    return { createdAt: new Date(k), id: i };
  }

  /**
   * GET /songs/{songId}/comments.
   * @param {object} auth `req.auth` (an account or a guest)
   * @param {{limit?: number, cursor?: string}} input
   * @returns {Promise<object>} `CommentPage`
   */
  async function listSongComments(auth, songId, { limit, cursor } = {}) {
    const song = await readableSong(auth, songId);
    const id = idOf(song);
    const size = pageSize(limit);
    const fingerprint = fingerprintOf(['song-comments', id]);
    const after = afterFrom(cursor, fingerprint);
    const [{ items, hasMore }, total] = await Promise.all([
      comments.topLevelPage({ songId: id, limit: size, after }),
      comments.topLevelCount(id),
    ]);
    // A comment's `replyCount` is never below its real number of replies (it moves up first): at 0 it has none.
    const replies = await comments.firstReplies({
      songId: id, parentIds: items.filter((doc) => count(doc.replyCount) > 0).map(idOf), limit: REPLIES_SHOWN,
    });
    return {
      data: await present(auth, items, replies),
      page: { nextCursor: hasMore ? encodeCursor(items[items.length - 1], fingerprint) : null, hasMore, total },
      commentCount: count(song.commentCount),
    };
  }

  /**
   * GET /comments/{commentId}/replies: a top-level comment's replies, oldest first; a reply's are none.
   * @returns {Promise<object>} `CommentReplyPage`
   */
  async function listCommentReplies(auth, commentId, { limit, cursor } = {}) {
    const comment = await readableComment(auth, commentId);
    const id = idOf(comment);
    const fingerprint = fingerprintOf(['comment-replies', id]);
    const after = afterFrom(cursor, fingerprint);
    if (comment.parentId) return { data: [], page: { nextCursor: null, hasMore: false, total: 0 } };
    const { items, hasMore } = await comments.repliesPage({
      songId: lower(comment.songId), parentId: id, limit: pageSize(limit), after,
    });
    return {
      data: await present(auth, items),
      page: {
        nextCursor: hasMore ? encodeCursor(items[items.length - 1], fingerprint) : null,
        hasMore,
        total: count(comment.replyCount),
      },
    };
  }

  /**
   * POST /songs/{songId}/comments: a top-level comment by the signed-in account.
   * @param {object} auth `req.auth` (an account: the route refuses guests)
   * @param {{text: string}} body `CommentCreate`
   * @returns {Promise<object>} the `Comment` as saved (`replies: []`)
   */
  async function postSongComment(auth, songId, { text }) {
    const clean = textOf(text);
    const id = idOf(await readableSong(auth, songId));
    await contents.addComments(id, 1);
    let doc;
    try {
      doc = await comments.create({ songId: id, parentId: null, authorId: auth.userId, text: clean, createdAt: new Date(now()) });
    } catch (err) {
      await undo(() => contents.addComments(id, -1), 'a comment could not be stored and the song\'s count could not be put back');
      throw err;
    }
    const [comment] = await present(auth, [doc]);
    return comment;
  }

  /**
   * POST /comments/{commentId}/replies: a reply under the top-level comment (the comment itself, or the one a reply
   * belongs to).
   * @param {object} auth `req.auth` (an account)
   * @param {{text: string}} body `CommentCreate`
   * @returns {Promise<object>} the `Comment` as saved (no `replies`)
   */
  async function postCommentReply(auth, commentId, { text }) {
    const clean = textOf(text);
    const target = await readableComment(auth, commentId);
    const parentId = target.parentId ? lower(target.parentId) : idOf(target);
    const songId = lower(target.songId);
    await contents.addComments(songId, 1);
    if (!(await comments.addReplies(parentId, 1))) {
      // The top-level comment was deleted meanwhile.
      await undo(() => contents.addComments(songId, -1), 'a reply was refused and the song\'s count could not be put back');
      throw commentNotFound();
    }
    let reply;
    try {
      reply = await comments.create({ songId, parentId, authorId: auth.userId, text: clean, createdAt: new Date(now()) });
    } catch (err) {
      await undo(async () => {
        await comments.addReplies(parentId, -1);
        await contents.addComments(songId, -1);
      }, 'a reply could not be stored and the counts could not be put back');
      throw err;
    }
    // The comment may have been deleted while the reply was stored, its sweep of replies missing this one: then this
    // request deletes it (unless the sweep did) and the reply was never posted.
    if (!(await comments.exists(parentId))) {
      const id = idOf(reply);
      if (await comments.remove(id)) {
        await comments.removeLikesOf([id]);
        await contents.addComments(songId, -1);
      }
      throw commentNotFound();
    }
    const [comment] = await present(auth, [reply]);
    return comment;
  }

  /**
   * PUT /comments/{commentId}/like. Idempotent.
   * @returns {Promise<object>} `CommentLike` after the change
   */
  async function likeComment(auth, commentId) {
    const id = idOf(await readableComment(auth, commentId));
    const userId = viewerOf(auth);
    if (!(await comments.addLikes(id, 1))) throw commentNotFound();
    let added;
    try {
      added = await comments.addLike({ commentId: id, userId, createdAt: new Date(now()) });
    } catch (err) {
      await undo(() => comments.addLikes(id, -1), 'a like could not be stored and the comment\'s count could not be put back');
      throw err;
    }
    // Liked already: the count goes back.
    if (!added) await comments.addLikes(id, -1);
    const after = await comments.findById(id);
    if (!after) {
      // Deleted meanwhile, its likes with it, perhaps before this one was stored.
      await comments.removeLike({ commentId: id, userId });
      throw commentNotFound();
    }
    return { likeCount: count(after.likeCount), likedByMe: true };
  }

  /**
   * DELETE /comments/{commentId}/like. Idempotent.
   * @returns {Promise<object>} `CommentLike` after the change
   */
  async function unlikeComment(auth, commentId) {
    const id = idOf(await readableComment(auth, commentId));
    if (await comments.removeLike({ commentId: id, userId: viewerOf(auth) })) await comments.addLikes(id, -1);
    const after = await comments.findById(id);
    if (!after) throw commentNotFound();
    return { likeCount: count(after.likeCount), likedByMe: false };
  }

  /**
   * DELETE /comments/{commentId}: by its author or the song's artist. A top-level comment goes with its replies, and
   * every like of them; the song's `commentCount` (and a reply's comment's `replyCount`) drop by what this request
   * deleted.
   */
  async function deleteComment(auth, commentId) {
    const comment = await comments.findById(commentId);
    if (!comment) throw commentNotFound();
    const userId = viewerOf(auth);
    const songId = lower(comment.songId);
    if (lower(comment.authorId) !== userId) {
      const [song] = await contents.findByIds([songId], { type: 1, ownerId: 1 });
      if (!song || song.type !== 'song' || lower(song.ownerId) !== userId) throw forbidden();
    }
    const id = idOf(comment);
    // Deleted meanwhile (the other request lowered the counts): "already deleted", as the spec says.
    if (!(await comments.remove(id))) throw commentNotFound();
    if (comment.parentId) {
      await comments.removeLikesOf([id]);
      await comments.addReplies(lower(comment.parentId), -1);
      await contents.addComments(songId, -1);
      return;
    }
    const replyIds = await comments.replyIds({ songId, parentId: id });
    const removed = await comments.removeMany(replyIds);
    await comments.removeLikesOf([id, ...replyIds]);
    await contents.addComments(songId, -(1 + removed));
  }

  /**
   * `Song.latestComment` for these songs: each one's newest top-level comment (`replies: []`), for this viewer. The
   * caller asks only for songs whose comments the viewer may read.
   * @param {object | undefined} auth `req.auth`
   * @param {string[]} songIds
   * @returns {Promise<Map<string, object>>} song id (lower case) to its `Comment`; a song without comments is not in it
   */
  async function latestComments(auth, songIds) {
    const latest = await comments.latestTopLevel(songIds);
    const docs = [...latest.values()];
    const presented = await present(auth, docs);
    return new Map(docs.map((doc, i) => [lower(doc.songId), presented[i]]));
  }

  return {
    listSongComments, listCommentReplies, postSongComment, postCommentReply, likeComment, unlikeComment, deleteComment,
    latestComments,
  };
}

module.exports = {
  createCommentService,
  textOf,
  CURSOR_TTL_MS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  REPLIES_SHOWN,
  TEXT_MAX,
  ...createCommentService(),
};
