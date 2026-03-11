const mongoose = require('mongoose');

const guestUserSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
  },
  deviceName: {
    type: String,
    required: true,
  },
  preferredLanguage: {
    type: String,
    enum: ['English', 'Spanish'],
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('GuestUser', guestUserSchema);
