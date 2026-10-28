const mongoose = require('mongoose');

// Proof that an email address was verified, handed out when the sign-up code is
// accepted and used once, by POST /auth/signup/complete. Only a hash of the token is
// stored. See src/modules/signupTokens/service.js.
const signupTokenSchema = new mongoose.Schema({
  // SHA-256 of the token that was given to the client.
  tokenHash: { type: String, required: true, unique: true },
  // The verified, normalised address the account will be created for.
  email: { type: String, required: true },
  // The token only works from the install that verified the code.
  installationId: { type: String, required: true },
  createdAt: { type: Date, required: true },
  // When the token stops working (30 minutes after it was issued).
  expiresAt: { type: Date, required: true },
  // Set by the one request that uses the token.
  usedAt: { type: Date, default: null },
  // MongoDB deletes the document then. Kept a while past expiresAt so a late request still gets "expired", not "invalid".
  purgeAt: { type: Date, required: true },
}, { collection: 'signup_tokens' });

signupTokenSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.SignupToken || mongoose.model('SignupToken', signupTokenSchema);
