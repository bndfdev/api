const mongoose = require('mongoose');

const KINDS = ['playlist', 'liked_songs'];

// What a user's library keeps about one of its entries (v1, GET /v1/me/library/playlists). The library itself is
// the user's own playlists (`contents`, no row needed), the playlists saved from others (a row each) and Liked songs
// (made from `song_likes`). A row holds what those do not:
// - kind `playlist`, someone else's playlist: it was saved (`savedAt`, when), so it is in the library.
// - kind `playlist`, one of the user's own: made the first time it is played from, for `playedAt` (`savedAt` is
//   then the playlist's creation, which is what the library shows for own playlists anyway).
// - kind `liked_songs` (no `playlistId`): made the first time Liked songs is played from or a song is unliked, for
//   `playedAt` and `unlikedAt`. Its size and newest like come from `song_likes`.
// `playedAt` only moves forward, with listens played from the entry (POST /v1/me/listens, `source`).
// Nothing in v1 saves others' playlists yet (not specified); locally, tools.local/e2e/seed_player.js does.
// No defaults: the library's writes are upserts, which must not meet a default on the same path.
const libraryEntrySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: KINDS, required: true },
  // The playlist (`contents`), for kind `playlist`; null for `liked_songs`.
  playlistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required() { return this.kind === 'playlist'; } },
  // When it joined the library, for kind `playlist`.
  savedAt: { type: Date, required() { return this.kind === 'playlist'; } },
  // When the user last played from it; absent if never.
  playedAt: { type: Date },
  // Liked songs only: when a song was last taken out (unliked); absent if never.
  unlikedAt: { type: Date },
}, { collection: 'library_entries' });

// One row per playlist per user, and one Liked songs row per user (its `playlistId` is null).
libraryEntrySchema.index({ userId: 1, playlistId: 1 }, { name: 'user_playlist', unique: true });

module.exports = mongoose.models.LibraryEntry || mongoose.model('LibraryEntry', libraryEntrySchema);
module.exports.KINDS = KINDS;
