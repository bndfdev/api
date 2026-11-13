const mongoose = require('mongoose');

// A comment on a song, or a reply to one (v1, the player drawer's Comments tab: GET/POST /v1/songs/{songId}/comments,
// GET/POST /v1/comments/{commentId}/replies). Replies are one level deep: a reply's `parentId` is always a top-level
// comment (a reply to a reply is stored under the same top-level comment). Deleting a top-level comment deletes its
// replies. Written only by src/modules/player/comments.js (and, locally, tools.local/e2e/seed_player.js).
const commentSchema = new mongoose.Schema({
  // The song (`contents`, type `song`).
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  // The top-level comment this replies to; null for a top-level comment.
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // As posted, trimmed: 1 to 500 characters (checked by the comments service), line breaks kept.
  text: { type: String, required: true },
  // How many `comment_likes` it has. Changed atomically, never below 0.
  likeCount: { type: Number, default: 0, min: 0 },
  // Top-level comments only: how many replies it has (always 0 on a reply). Changed atomically, never below 0.
  replyCount: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, required: true },
}, { collection: 'comments' });

// One index for both lists, `_id` breaking ties so a page can start just after the last comment of the previous one:
// a song's top-level comments (`parentId` null) newest first, and a comment's replies (same song, `parentId` the
// comment) oldest first, the index read backwards. Also the newest top-level comment of a song (`Song.latestComment`)
// and the replies deleted with their comment.
commentSchema.index({ songId: 1, parentId: 1, createdAt: -1, _id: -1 }, { name: 'song_thread' });

module.exports = mongoose.models.Comment || mongoose.model('Comment', commentSchema);
