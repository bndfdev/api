const mongoose = require('mongoose');

const VerificationTokenSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  token: { type: String, required: true },
  expires: { type: Date, required: true },
  lastRefreshed: { type: Date, default: Date.now },
});

module.exports = mongoose.model('VerificationToken', VerificationTokenSchema);
