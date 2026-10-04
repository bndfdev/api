const mongoose = require('mongoose');

// One row per code sent, so "5 sends per address per 24 hours" can be enforced
// as a rolling window. (Challenges are deleted soon after they expire, so they
// cannot be used for that.) The destination is kept only as an HMAC.
const codeSendLogSchema = new mongoose.Schema({
  // HMAC of "<channel>:<destination>" (see the challenge service).
  key: { type: String, required: true },
  purpose: { type: String, required: true },
  challengeId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sentAt: { type: Date, required: true },
}, { collection: 'code_send_logs' });

codeSendLogSchema.index({ key: 1, sentAt: 1 });
// The window is 24 hours; MongoDB removes older rows.
codeSendLogSchema.index({ sentAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.models.CodeSendLog || mongoose.model('CodeSendLog', codeSendLogSchema);
