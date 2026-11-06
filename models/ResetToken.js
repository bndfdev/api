const mongoose = require('mongoose');

// Proof, handed out when a password-reset code is accepted, that the person controls the account's
// email. POST /auth/password-reset/complete takes it once. Only a hash of the token is stored.
// See src/modules/resetTokens/service.js.
const resetTokenSchema = new mongoose.Schema({
  // SHA-256 of the token that was given to the client.
  tokenHash: { type: String, required: true, unique: true },
  // The account whose password the token may change.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // The token only works from the install that verified the code.
  installationId: { type: String, required: true },
  createdAt: { type: Date, required: true },
  // When the token stops working (15 minutes after it was issued).
  expiresAt: { type: Date, required: true },
  // Set by the one request that uses the token.
  usedAt: { type: Date, default: null },
  // MongoDB deletes the document then. Kept a while past expiresAt so a late request still gets "expired", not "invalid".
  purgeAt: { type: Date, required: true },
}, { collection: 'reset_tokens' });

resetTokenSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ResetToken || mongoose.model('ResetToken', resetTokenSchema);
