const mongoose = require('mongoose');

const OtpSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  otp: { type: String, required: true },
  expires: { type: Date, required: true },
  blocked: { type: Boolean, default: false },
  blockReason: { type: String },
});

module.exports = mongoose.model('Otp', OtpSchema);
