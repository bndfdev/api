const mongoose = require('mongoose');

const LISTENER_TYPES = ['user', 'guest'];
const SOURCE_TYPES = ['album', 'playlist', 'liked_songs', 'song'];

// One listen reported by the app (v1, POST /v1/me/listens): a song that stopped being the current one. Raw events,
// kept so a resend is recognised (same listener, song and `endedAt`) and never counts twice. `counted` says whether
// it met the counting rule (30 seconds or played to the end) when it was received; the song's `contents.listens`
// was then moved by one. How long events are kept is not decided yet (docs/api/PLAYER.md), so there is no TTL; it
// must stay longer than the 30 days for which an event is accepted, or a late resend would count again.
const listenSchema = new mongoose.Schema({
  // The account (`users`) or guest (`guest_accounts`) that listened.
  listenerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  listenerType: { type: String, enum: LISTENER_TYPES, required: true },
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  listenedMs: { type: Number, required: true, min: 0 },
  completed: { type: Boolean, required: true },
  // When it stopped being the current song, by the device's clock.
  endedAt: { type: Date, required: true },
  // Where it was played from, when the app said and it was usable: `album` and `playlist` with the item's id,
  // `liked_songs` and `song` without one.
  source: {
    type: new mongoose.Schema({
      type: { type: String, enum: SOURCE_TYPES, required: true },
      id: { type: mongoose.Schema.Types.ObjectId },
    }, { _id: false }),
    default: null,
  },
  counted: { type: Boolean, required: true },
  receivedAt: { type: Date, required: true },
}, { collection: 'listens' });

// The same event sent again (a retry, a resend after a crash) is refused by this index and so ignored.
listenSchema.index({ listenerId: 1, songId: 1, endedAt: 1 }, { name: 'listener_song_end', unique: true });

module.exports = mongoose.models.Listen || mongoose.model('Listen', listenSchema);
module.exports.LISTENER_TYPES = LISTENER_TYPES;
module.exports.SOURCE_TYPES = SOURCE_TYPES;
