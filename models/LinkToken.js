const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  provider: { type: String, required: true },
  providerUserId: { type: String, required: true },
  email: String,
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { collection: 'link_tokens' });

module.exports = mongoose.models.LinkToken || mongoose.model('LinkToken', schema);
