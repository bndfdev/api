const mongoose = require('mongoose');

// One like of a comment or a reply by a user (v1, PUT /v1/comments/{commentId}/like). A comment is liked at most once
// per user; unliking deletes the row, and so does deleting the comment. The comment's `likeCount` counts these rows.
// Accounts only: guests cannot like.
const commentLikeSchema = new mongoose.Schema({
  commentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, required: true },
}, { collection: 'comment_likes' });

// A comment once per user (liking twice at once stores one row); "which of these comments did the viewer like"
// (`likedByMe` on a page); a deleted comment's likes.
commentLikeSchema.index({ commentId: 1, userId: 1 }, { name: 'comment_user', unique: true });

module.exports = mongoose.models.CommentLike || mongoose.model('CommentLike', commentLikeSchema);
