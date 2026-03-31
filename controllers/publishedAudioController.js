const PublishedAudio = require('../models/PublishedAudio');
const fs = require('fs');

exports.postPublishAudio = async (req, res) => {
  try {
    const { audio_title, audio_label } = req.body;

    if (!audio_title) {
      return res.status(400).json({ error: 'audio_title is required' });
    }
    if (!audio_label) {
      return res.status(400).json({ error: 'audio_label is required' });
    }

    const audioFile = req.files?.audio_file?.[0];
    const imageFile = req.files?.audio_image?.[0];

    if (!audioFile) {
      return res.status(400).json({ error: 'audio_file is required' });
    }
    if (!imageFile) {
      // Clean up audio file if image is missing
      fs.unlink(audioFile.path, () => {});
      return res.status(400).json({ error: 'audio_image is required' });
    }

    const audio_file_url = `/uploads/published_audio/audio/${audioFile.filename}`;
    const audio_image_url = `/uploads/published_audio/images/${imageFile.filename}`;

    const publishedAudio = new PublishedAudio({
      audio_title,
      audio_label,
      audio_file_url,
      audio_file_name: audioFile.filename,
      audio_image_url,
      audio_image_name: imageFile.filename,
    });

    const saved = await publishedAudio.save();

    res.status(201).json({
      success: true,
      message: 'Audio published successfully',
      data: saved,
    });
  } catch (err) {
    console.error('[postPublishAudio] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
