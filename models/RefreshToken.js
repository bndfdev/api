const mongoose = require('mongoose');

// A refresh token is single use. Only its SHA-256 hash is stored. A used token
// stays for a while (see the service) so that presenting it again is detected
// as reuse. The data that lets a repeated refresh succeed lives in RefreshGrace.
const refreshTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  replacedByHash: { type: String, default: null },
}, { collection: 'refresh_tokens' });

// MongoDB removes the document once expiresAt has passed.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RefreshToken || mongoose.model('RefreshToken', refreshTokenSchema);
