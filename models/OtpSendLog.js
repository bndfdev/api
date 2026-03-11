const mongoose = require('mongoose');

const OtpSendLogSchema = new mongoose.Schema({
  email: { type: String, required: true },
  sentAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('OtpSendLog', OtpSendLogSchema);
