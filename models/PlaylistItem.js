const mongoose = require('mongoose');

// One song in a playlist (v1, the media player: GET /v1/playlists/{id}/songs). A playlist is a `contents` item of
// type `playlist`; its songs are these rows, in `position` order (a song added later gets a higher position, so it
// comes last). A song is in a playlist at most once. Read by the player; written by Add to Playlist (PUT
// /v1/me/library/songs/{id}/playlists, src/modules/player/library.js) and, locally, by tools.local/e2e/seed_player.js.
const playlistItemSchema = new mongoose.Schema({
  playlistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  position: { type: Number, required: true },
  addedAt: { type: Date, required: true },
}, { collection: 'playlist_items' });

// A song at most once per playlist.
playlistItemSchema.index({ playlistId: 1, songId: 1 }, { name: 'playlist_song', unique: true });
// The playlist's order, `_id` breaking ties, so a page can start just after the last item of the previous one.
playlistItemSchema.index({ playlistId: 1, position: 1, _id: 1 }, { name: 'playlist_order' });

module.exports = mongoose.models.PlaylistItem || mongoose.model('PlaylistItem', playlistItemSchema);
