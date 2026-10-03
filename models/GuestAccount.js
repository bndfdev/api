const mongoose = require('mongoose');

// A guest: someone using the app without an account (POST /auth/guest). One per app install.
// Kept apart from `users`, which the admin panel and the old API read as full accounts (email and
// password required). See src/modules/guests and docs/DB_CHANGES.md.
const guestAccountSchema = new mongoose.Schema({
  // The install the guest belongs to: the same install always gets the same guest back.
  installationId: { type: String, required: true, unique: true },
  // `YYYY-MM-DD`, checked against the minimum age when the guest was created.
  dateOfBirth: { type: String, required: true },
  // BCP 47 tag, when the app sent one.
  preferredLanguage: { type: String },
  createdAt: { type: Date, required: true },
  // The last sign-in or token refresh.
  lastActiveAt: { type: Date, required: true },
  // MongoDB deletes the guest then: 180 days after it was last active (the spec: "Guest accounts
  // unused for 180 days are deleted"). Moved forward on every sign-in and refresh.
  purgeAt: { type: Date, required: true },
}, { collection: 'guest_accounts' });

guestAccountSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.GuestAccount || mongoose.model('GuestAccount', guestAccountSchema);
