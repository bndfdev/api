const mongoose = require('mongoose');

const passwordResetTokenSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  token: {
    type: String,
    required: true,
  },
  expires: {
    type: Date,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expire: 3600, // Auto-delete after 1 hour
  },
});

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema);
