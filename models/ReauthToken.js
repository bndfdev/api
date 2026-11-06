const mongoose = require('mongoose');

// Proof, handed out by POST /auth/reauthenticate, that the user has just confirmed who they are. A sensitive
// call (setting a first password, later deleting the account or unlinking a login) takes it once, as
// X-Reauth-Token. Only a hash of the token is stored. See src/modules/reauthTokens/service.js.
const reauthTokenSchema = new mongoose.Schema({
  // SHA-256 of the token that was given to the client.
  tokenHash: { type: String, required: true, unique: true },
  // The account that re-authenticated.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // The session (signed-in device) it was issued to: it only works there.
  sessionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, required: true },
  // When the token stops working (5 minutes after it was issued). MongoDB deletes the document then.
  expiresAt: { type: Date, required: true },
  // Set by the one request that uses the token.
  usedAt: { type: Date, default: null },
}, { collection: 'reauth_tokens' });

reauthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ReauthToken || mongoose.model('ReauthToken', reauthTokenSchema);
