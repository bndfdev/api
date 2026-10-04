const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String },
  phone: { type: String, unique: true, sparse: true },
  dateOfBirth: { type: String },
  gender: { type: String, enum: ['male', 'female', 'other'], default: null },
  profileImage: { type: String, default: null },
  profileBanner: { type: String, default: null },
  mobileNumberVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  preferredLanguage: { type: String },
  deviceId: { type: String },
  deviceName: { type: String },
  failedLoginAttempts: { type: Number, default: 0 },
  isBlocked: { type: Boolean, default: false },
  blockedUntil: { type: Date, default: null },

  // Added for the v1 sign-up and login (src/modules/users). Additive only: the admin panel reads this
  // collection with its own model, so nothing above is renamed, removed or retyped, and every field
  // below is optional (older documents simply do not have it).
  // (The v1 API stores `email` itself already normalised: trimmed, lowercase, punycode domain. The unique
  // index on `email` above therefore also covers duplicates; see src/modules/users/repo.js for older mixed-case emails.)
  // Absent on older documents, which signed up through an emailed code and so count as verified.
  emailVerified: { type: Boolean },
  // Which scheme made `password`: 'argon2id' for v1, 'bcrypt' for the old API. Upgraded at the next good login.
  passwordAlgo: { type: String, enum: ['bcrypt', 'argon2id'] },
  // Password login lockout, kept apart from the admin's isBlocked / blockedUntil / failedLoginAttempts
  // above: attempts in the current window, when that window began, and the end of a lock.
  loginFailedCount: { type: Number, default: 0 },
  loginFailedSince: { type: Date, default: null },
  loginLockedUntil: { type: Date, default: null },
  updatedAt: { type: Date },
  // When the number in `phone` was verified with a code (v1). `mobileNumberVerified` above stays the flag the
  // admin panel and the old API read; v1 sets both.
  phoneVerifiedAt: { type: Date },
});

// Finds a user by email whatever the case it was stored in (older users may have mixed case). Not unique:
// it is only for lookups. Used by src/modules/users/repo.js, whose queries must give the same collation.
userSchema.index({ email: 1 }, { name: 'email_case_insensitive', collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
