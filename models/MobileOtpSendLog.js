const mongoose = require('mongoose');

const mobileOtpSendLogSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  sentAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.MobileOtpSendLog || mongoose.model('MobileOtpSendLog', mobileOtpSendLogSchema);
