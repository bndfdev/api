const mongoose = require('mongoose');

const SIGN_IN_METHODS = ['password', 'apple', 'google', 'facebook', 'guest', 'password_reset'];
const PLATFORMS = ['ios', 'android', 'web'];

// One signed-in device. Raw tokens are never stored on it.
const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  signInMethod: { type: String, enum: SIGN_IN_METHODS, required: true },
  device: {
    platform: { type: String, enum: PLATFORMS },
    model: { type: String },
    appVersion: { type: String },
  },
  installationId: { type: String, required: true },
  createdAt: { type: Date, required: true },
  lastActiveAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  revokeReason: { type: String, default: null },
  expiresAt: { type: Date, required: true },
}, { collection: 'sessions' });

// Covers lookups by user, and "active sessions of a user".
sessionSchema.index({ userId: 1, revokedAt: 1 });
// MongoDB removes the document once expiresAt has passed.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.Session || mongoose.model('Session', sessionSchema);
