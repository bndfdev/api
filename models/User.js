const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String },
  phone: { type: String, unique: true, sparse: true },
  dateOfBirth: { type: String },
  // 'other' is the old API's; the v1 values are female, male, non_binary and prefer_not_to_say (the spec's Gender).
  gender: { type: String, enum: ['male', 'female', 'other', 'non_binary', 'prefer_not_to_say'], default: null },
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
  // Date of birth (v1, `YYYY-MM-DD` in `dateOfBirth` above): when it was first set, and how many times it was
  // changed since. One change (a typo fix) is allowed within 30 days; after that only support can change it.
  dateOfBirthSetAt: { type: Date },
  dateOfBirthChanges: { type: Number },
  // When a date of birth under the minimum age was entered (the date itself is not stored).
  ageCheckFailedAt: { type: Date },
  // Onboarding steps the user marked themselves: "Later" (skipped) or done, for the two optional steps.
  onboardingSteps: {
    interests: { status: { type: String, enum: ['completed', 'skipped'] }, updatedAt: { type: Date } },
    profile: { status: { type: String, enum: ['completed', 'skipped'] }, updatedAt: { type: Date } },
  },
  // When onboarding was first finished. It then stays finished, even if a field is cleared later.
  onboardingCompletedAt: { type: Date },
  // Moves on with every profile change through v1 (PATCH /me), so two changes worked out from the same state
  // cannot both be saved.
  profileRevision: { type: Number },
});

// Finds a user by email whatever the case it was stored in (older users may have mixed case). Not unique:
// it is only for lookups. Used by src/modules/users/repo.js, whose queries must give the same collation.
userSchema.index({ email: 1 }, { name: 'email_case_insensitive', collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
