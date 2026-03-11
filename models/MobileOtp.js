const mongoose = require('mongoose');

const mobileOtpSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  otp: { type: String, required: true },
  expires: { type: Date, required: true },
  blocked: { type: Boolean, default: false },
  blockReason: { type: String },
});

module.exports = mongoose.models.MobileOtp || mongoose.model('MobileOtp', mobileOtpSchema);
