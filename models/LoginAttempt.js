const mongoose = require('mongoose');

// Failed password logins for an email that has no account, counted exactly like the ones kept on a
// user (loginFailedCount / loginFailedSince / loginLockedUntil), so that an unknown email locks after
// the same number of attempts and answers the same way as a real account and tells nobody which
// addresses have accounts. See src/modules/auth/service.js.
const loginAttemptSchema = new mongoose.Schema({
  // SHA-256 of the normalised email: the address itself is never stored here.
  _id: { type: String },
  loginFailedCount: { type: Number, default: 0 },
  loginFailedSince: { type: Date, default: null },
  loginLockedUntil: { type: Date, default: null },
  // MongoDB deletes the document then: nothing it records matters any more.
  purgeAt: { type: Date, required: true },
}, { collection: 'login_attempts' });

loginAttemptSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.LoginAttempt || mongoose.model('LoginAttempt', loginAttemptSchema);
