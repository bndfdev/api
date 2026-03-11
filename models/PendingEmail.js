const mongoose = require('mongoose');

const PendingEmailSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PendingEmail', PendingEmailSchema);
