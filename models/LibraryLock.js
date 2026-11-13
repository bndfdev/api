const mongoose = require('mongoose');

// A per-account lock (v1, PUT /v1/me/library/songs/{songId}/playlists): an account's changes to which playlists hold
// a song run one at a time, so two sent at once never leave a mix of both. `_id` is the account's id, so at most one
// lock exists per account. A request holds it for the few milliseconds of its writes and deletes it; one left behind
// (a crash) can be taken over once `expiresAt` has passed, and the TTL index removes it soon after.
const libraryLockSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, required: true },
  // A random value chosen by the request holding it: only that request can give it back.
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { collection: 'library_locks', versionKey: false });

libraryLockSchema.index({ expiresAt: 1 }, { name: 'expires', expireAfterSeconds: 0 });

module.exports = mongoose.models.LibraryLock || mongoose.model('LibraryLock', libraryLockSchema);
