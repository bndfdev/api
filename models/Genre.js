const mongoose = require('mongoose');

const genreSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  image: { type: String }, // URL or path to image
  active: { type: Boolean, default: true },
  counter: { type: Number, default: 0 }, // Number of users who selected this genre
});

module.exports = mongoose.models.Genre || mongoose.model('genres', genreSchema);
