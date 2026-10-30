const mongoose = require('mongoose');

const TYPES = ['playlist', 'album', 'song', 'story'];
const BADGES = ['trending', 'top10'];

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
}, { collection: 'contents', timestamps: true });

contentSchema.pre('validate', function setTitleLower() {
  if (typeof this.title === 'string') this.titleLower = sortableTitle(this.title);
});

// One per sort of GET /me/content (recent, popular, title), each ending in `_id` so the order is total and a page
// can start just after the last item of the previous one.
contentSchema.index({ ownerId: 1, createdAt: -1, _id: -1 }, { name: 'owner_recent' });
contentSchema.index({ ownerId: 1, listens: -1, _id: -1 }, { name: 'owner_popular' });
contentSchema.index({ ownerId: 1, titleLower: 1, _id: 1 }, { name: 'owner_title' });

module.exports = mongoose.models.Content || mongoose.model('Content', contentSchema);
module.exports.sortableTitle = sortableTitle;
module.exports.TYPES = TYPES;
module.exports.BADGES = BADGES;
