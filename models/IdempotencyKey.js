const mongoose = require('mongoose');

const RETENTION_SECONDS = 24 * 60 * 60;

// The first response to a request that carried an Idempotency-Key, kept for 24
// hours so a retry gets the same answer instead of repeating the action.
// `lookup` is a SHA-256 of key + method + path + caller, so no raw key, user or
// IP is stored. A record is `pending` while the first request is running.
// The response body is stored AES-256-GCM encrypted, because it can hold tokens.
const idempotencyKeySchema = new mongoose.Schema({
  lookup: { type: String, required: true, unique: true },
  // SHA-256 of the canonical body and query: a retry must repeat the same request.
  requestHash: { type: String, required: true },
  state: { type: String, enum: ['pending', 'done'], required: true },
  // Random per attempt: only the request that holds the record may complete or release it.
  owner: { type: String, required: true },
  status: { type: Number },
  // Only the safe response headers (content type, location, ...), lower-case names.
  headers: { type: mongoose.Schema.Types.Mixed },
  // Encrypted with the lookup as additional authenticated data (see lib/secrets.js).
  body: { type: String },
  createdAt: { type: Date, required: true },
}, { collection: 'idempotency_keys' });

// MongoDB removes the record 24 hours after createdAt.
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

module.exports = mongoose.models.IdempotencyKey || mongoose.model('IdempotencyKey', idempotencyKeySchema);
