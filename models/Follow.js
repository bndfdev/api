const mongoose = require('mongoose');

// One account following an artist (v1, the Artist page's Follow button: PUT /v1/me/following/artists/{artistId}).
// An artist is an account that has published a song, so both ids are `users` ids. Following twice keeps one row
// (and its first `followedAt`); unfollowing deletes it. Accounts only: guests cannot follow.
const followSchema = new mongoose.Schema({
  followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  artistId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  followedAt: { type: Date, required: true },
}, { collection: 'follows' });

// An artist once per follower (following twice at once stores one row), "does the viewer follow this artist", and
// how many artists an account follows (`Artist.followingCount`).
followSchema.index({ followerId: 1, artistId: 1 }, { name: 'follower_artist', unique: true });
// How many accounts follow an artist (`Artist.followerCount`), and a followers list newest first if one is added.
followSchema.index({ artistId: 1, followedAt: -1, _id: -1 }, { name: 'artist_followers' });

module.exports = mongoose.models.Follow || mongoose.model('Follow', followSchema);
