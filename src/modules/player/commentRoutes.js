const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const { idempotency: defaultIdempotency } = require('../../middleware/idempotency');
const defaultComments = require('./comments');

/**
 * Each operation's `x-rate-limit` (docs/api/paths/comments.yaml), per account (a guest counts as one): reads 120 a
 * minute, likes and unlikes 60, deletes 30. Posting is 10 a minute "comments and replies together": one counter
 * (`postComment`) shared by postSongComment and postCommentReply. Every other operation has its own counter.
 */
const LIMITS = Object.freeze({
  listSongComments: { name: 'comments-list:account', points: 120, durationSeconds: 60, key: byUser },
  postComment: { name: 'comments-post:account', points: 10, durationSeconds: 60, key: byUser },
  listCommentReplies: { name: 'comments-replies:account', points: 120, durationSeconds: 60, key: byUser },
  likeComment: { name: 'comments-like:account', points: 60, durationSeconds: 60, key: byUser },
  unlikeComment: { name: 'comments-unlike:account', points: 60, durationSeconds: 60, key: byUser },
  deleteComment: { name: 'comments-delete:account', points: 30, durationSeconds: 60, key: byUser },
});

/**
 * Comments on songs (`docs/api/paths/comments.yaml`, tag Comments). Reading is open to guests (a guest's token
 * works like an account's); posting, liking and deleting are for accounts: a guest's token gets 403
 * GUEST_NOT_ALLOWED (before the rate limit counts it). No token is 401.
 * @param {{comments?: object, auth?: {requireAuth: Function}, idempotency?: Function, storeFactory?: Function}} [deps]
 *   `storeFactory` replaces the rate limiters' counter store (tests)
 */
function createCommentRouter({
  comments = defaultComments,
  auth = defaultAuth,
  idempotency = defaultIdempotency,
  storeFactory,
} = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  const limit = Object.fromEntries(Object.entries(LIMITS)
    .map(([operation, rule]) => [operation, rateLimit({ ...rule, ...(storeFactory ? { storeFactory } : {}) })]));
  // `likedByMe` and `isMine` are the viewer's: never stored by shared caches.
  const privateCache = 'private, no-cache';
  const page = (req) => ({ limit: req.query.limit, cursor: req.query.cursor });

  router.get('/songs/:songId/comments', requireAuth, limit.listSongComments, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await comments.listSongComments(req.auth, req.params.songId, page(req)));
  }));

  // 201 with the comment as saved. The Idempotency-Key replays that answer.
  router.post('/songs/:songId/comments', requireAuth, accountOnly, limit.postComment, idempotency,
    asyncHandler(async (req, res) => {
      res.status(201).set('Cache-Control', privateCache)
        .json(await comments.postSongComment(req.auth, req.params.songId, req.body));
    }));

  router.get('/comments/:commentId/replies', requireAuth, limit.listCommentReplies, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await comments.listCommentReplies(req.auth, req.params.commentId, page(req)));
  }));

  router.post('/comments/:commentId/replies', requireAuth, accountOnly, limit.postComment, idempotency,
    asyncHandler(async (req, res) => {
      res.status(201).set('Cache-Control', privateCache)
        .json(await comments.postCommentReply(req.auth, req.params.commentId, req.body));
    }));

  // Likes: idempotent both ways; both answer the likes after the change.
  router.put('/comments/:commentId/like', requireAuth, accountOnly, limit.likeComment, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await comments.likeComment(req.auth, req.params.commentId));
  }));

  router.delete('/comments/:commentId/like', requireAuth, accountOnly, limit.unlikeComment, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await comments.unlikeComment(req.auth, req.params.commentId));
  }));

  router.delete('/comments/:commentId', requireAuth, accountOnly, limit.deleteComment, asyncHandler(async (req, res) => {
    await comments.deleteComment(req.auth, req.params.commentId);
    res.status(204).end();
  }));

  return router;
}

module.exports = { createCommentRouter, LIMITS, router: createCommentRouter() };
