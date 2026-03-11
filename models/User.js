const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String },
  phone: { type: String, unique: true, sparse: true },
  dateOfBirth: { type: String },
  gender: { type: String, enum: ['male', 'female', 'other'], default: null },
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
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
