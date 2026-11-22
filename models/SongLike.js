const mongoose = require('mongoose');

// One song a user liked (v1, the player's heart: PUT /v1/me/liked-songs/{songId}). The user's Liked songs are these
// rows, the most recently liked first (GET /v1/me/liked-songs). A song is liked at most once per user; unliking
// deletes the row. Accounts only: guests cannot like.
const songLikeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  likedAt: { type: Date, required: true },
}, { collection: 'song_likes' });

// A song once per user (liking twice at once stores one row), and "which of these songs did the viewer like".
songLikeSchema.index({ userId: 1, songId: 1 }, { name: 'user_song', unique: true });
// The Liked songs page, newest like first, `_id` breaking ties, so a page can start just after the last row shown.
songLikeSchema.index({ userId: 1, likedAt: -1, _id: -1 }, { name: 'user_liked' });

module.exports = mongoose.models.SongLike || mongoose.model('SongLike', songLikeSchema);
