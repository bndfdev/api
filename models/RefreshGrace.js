const mongoose = require('mongoose');

// The successor token pair handed out when a refresh token is used, kept only
// for the grace window so that a repeated or racing refresh from the same
// install gets the same pair. One record per used token; the unique tokenHash
// also decides which of several parallel refreshes wins.
const refreshGraceSchema = new mongoose.Schema({
  // Hash of the refresh token that was used (not of its successor).
  tokenHash: { type: String, required: true, unique: true },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
  graceUntil: { type: Date, required: true },
  // The successor pair as JSON, AES-256-GCM encrypted.
  cipher: { type: String, required: true },
}, { collection: 'refresh_grace' });

// MongoDB removes the record once the grace window has passed.
refreshGraceSchema.index({ graceUntil: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RefreshGrace || mongoose.model('RefreshGrace', refreshGraceSchema);
