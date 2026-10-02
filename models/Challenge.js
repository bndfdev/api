const mongoose = require('mongoose');

// A one-time code that was sent to an email address or phone number (the
// spec's "challenge"). Only an HMAC of the code is stored, never the code. A
// resend keeps the document and replaces the hash. See
// src/modules/challenges/service.js for the rules.
const challengeSchema = new mongoose.Schema({
  purpose: { type: String, required: true, enum: ['signup_email', 'password_reset', 'phone_verification'] },
  channel: { type: String, required: true, enum: ['email', 'sms'] },
  // Normalised (see src/lib/destination.js). Stored in full because a resend needs it; masked in every response.
  destination: { type: String, required: true },
  // A code can only be verified or resent from the install that asked for it.
  installationId: { type: String, required: true },
  // Set for challenges that belong to a signed-in user (phone verification).
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // HMAC-SHA256 of "<challenge id>:<code>" with CODE_HMAC_KEY.
  codeHash: { type: String, required: true },
  // Wrong codes since the last send. Reaching maxAttempts locks the challenge until the next resend.
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, required: true },
  // Codes sent for this challenge (the first send counts).
  sendCount: { type: Number, default: 1 },
  lastSentAt: { type: Date, required: true },
  // When the current code stops working.
  expiresAt: { type: Date, required: true },
  // Set once, by the one request that sends the correct code (single use).
  verifiedAt: { type: Date, default: null },
  // A decoy was never sent anywhere and has no code (its hash cannot be matched): it exists so that
  // asking for a code for an address with no account looks exactly like asking for a real one.
  decoy: { type: Boolean, default: false },
  // Present only while this is the challenge a new request for the same destination, purpose, install (and user)
  // would be handed. The unique index lets exactly one of several simultaneous starts create it.
  activeKey: { type: String },
  createdAt: { type: Date, default: Date.now },
  // MongoDB deletes the document then. Kept a while past expiresAt so a late request still gets "expired", not "not found".
  purgeAt: { type: Date, required: true },
}, { collection: 'challenges' });

challengeSchema.index({ activeKey: 1 }, { unique: true, sparse: true });
challengeSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.Challenge || mongoose.model('Challenge', challengeSchema);
