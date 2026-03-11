const mongoose = require('mongoose');

const userPreferenceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, unique: true },
  genres: [{ type: mongoose.Schema.Types.ObjectId, ref: 'genres' }],
  artists: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Artist' }],
  locations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Country' }],
});

module.exports = mongoose.models.UserPreference || mongoose.model('userpreferences', userPreferenceSchema);
