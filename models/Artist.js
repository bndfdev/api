const mongoose = require('mongoose');

const artistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  bio: { type: String },
  image: { type: String }, // URL or path to image
  active: { type: Boolean, default: true },
});

module.exports = mongoose.models.Artist || mongoose.model('Artist', artistSchema);
