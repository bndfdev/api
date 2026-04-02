const mongoose = require('mongoose');

const publishedAudioSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  audio_title: {
    type: String,
    required: true,
  },
  audio_label: {
    type: String,
    required: true,
  },
  audio_file_url: {
    type: String,
    required: true,
  },
  audio_file_name: {
    type: String,
    required: true,
  },
  audio_image_url: {
    type: String,
    required: true,
  },
  audio_image_name: {
    type: String,
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

module.exports = mongoose.model('PublishedAudio', publishedAudioSchema);
