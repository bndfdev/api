const mongoose = require('mongoose');

const TYPES = ['playlist', 'album', 'song', 'story'];
const BADGES = ['trending', 'top10'];
/** A song's audio file: being processed, ready to play, or unusable. */
const AUDIO_STATUSES = ['processing', 'ready', 'failed'];

/**
 * A title as the A-to-Z sort compares it: accents removed, lower case. Kept in `titleLower` so the sort can use an
 * index. Anything that writes `title` without going through `save` (an update, a seed script) must set it too.
 */
const sortableTitle = (title) => String(title).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

// One playlist, album, song or story a user published (v1, GET /me/content). New collection: nothing in the old
// API or the admin panel reads it. There is no create endpoint yet; content is created elsewhere later (locally,
// tools.local/e2e/seed_content.js seeds it).
const contentSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: TYPES, required: true },
  title: { type: String, required: true },
  titleLower: { type: String, required: true },
  // The artwork, already processed: its address and the size of that file.
  image: {
    type: new mongoose.Schema({
      url: { type: String, required: true },
      width: { type: Number, required: true },
      height: { type: Number, required: true },
      // The picture's colours (colour rules v1, src/lib/palette.js) and BlurHash, worked out when the artwork is
      // stored, as for profile photos (the player's `Song.image` and `Album.image`). Absent on artwork stored
      // before they existed: the player then sends null and the app works the colours out itself.
      palette: {
        type: new mongoose.Schema({
          version: { type: Number, required: true },
          seed: { type: String, required: true },
          accent: { type: String, required: true },
          neutral: { type: Boolean, required: true },
        }, { _id: false }),
        default: undefined,
      },
      blurhash: { type: String },
    }, { _id: false }),
    default: null,
  },
  year: { type: Number, default: null },
  // Playlists and albums only.
  songCount: { type: Number, default: null },
  durationSec: { type: Number, default: 0, min: 0 },
  listens: { type: Number, default: 0, min: 0 },
  badge: { type: String, enum: [...BADGES, null], default: null },
  // Privacy > Hide Content and Restrict Content.
  hidden: { type: Boolean, default: false },
  followersOnly: { type: Boolean, default: false },

  // The media player (v1, docs/api/PLAYER.md). Songs only, all optional: absent on other types and on songs stored
  // before. No defaults, so documents created through this model do not get them.
  // The audio file, by storage key (never an address: GET /v1/songs/{id}/playback makes one when it is played).
  // A song plays only once `status` is `ready`; `durationMs` is then the file's length.
  audio: {
    type: new mongoose.Schema({
      key: { type: String, required: true },
      mimeType: { type: String },
      sizeBytes: { type: Number, min: 1 },
      durationMs: { type: Number, min: 0 },
      status: { type: String, enum: AUDIO_STATUSES, required: true },
      uploadedAt: { type: Date, required: true },
    }, { _id: false }),
    default: undefined,
  },
  // Loudness across the song for the seek bar: levels from 0 to 1, evenly spaced in time (128 when the audio is
  // processed).
  waveform: { type: [Number], default: undefined },
  // Languages the song has a transcript in (`transcripts`), the original first, then the translations by tag. Kept
  // in step with `transcripts` by whatever writes them.
  transcriptLanguages: { type: [String], default: undefined },
  // The album the song is on (an album of the same owner) and its place there. A song is on one album at most.
  albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
  trackNumber: { type: Number, min: 1 },
  // Every comment on the song, replies included (written by the comments, a later step). Absent reads as 0.
  commentCount: { type: Number, min: 0 },
}, { collection: 'contents', timestamps: true });

contentSchema.pre('validate', function setTitleLower() {
  if (typeof this.title === 'string') this.titleLower = sortableTitle(this.title);
});

// One per sort of GET /me/content (recent, popular, title), each ending in `_id` so the order is total and a page
// can start just after the last item of the previous one.
contentSchema.index({ ownerId: 1, createdAt: -1, _id: -1 }, { name: 'owner_recent' });
contentSchema.index({ ownerId: 1, listens: -1, _id: -1 }, { name: 'owner_popular' });
contentSchema.index({ ownerId: 1, titleLower: 1, _id: 1 }, { name: 'owner_title' });
// An album's songs in album order (GET /v1/albums/{id}), `_id` breaking ties. Only songs on an album are indexed.
contentSchema.index(
  { albumId: 1, trackNumber: 1, _id: 1 },
  { name: 'album_order', partialFilterExpression: { albumId: { $exists: true } } },
);

module.exports = mongoose.models.Content || mongoose.model('Content', contentSchema);
module.exports.sortableTitle = sortableTitle;
module.exports.TYPES = TYPES;
module.exports.BADGES = BADGES;
module.exports.AUDIO_STATUSES = AUDIO_STATUSES;
