const Recording = require('../models/Recording');
const User = require('../models/User');
const fs = require('fs');
const path = require('path');

exports.createRecording = async (req, res) => {
  try {
    const userEmail = req.user?.email;
    const { title, description, duration, isPublic } = req.body;

    console.log('[createRecording] Request body:', req.body);
    console.log('[createRecording] User email:', userEmail);
    console.log('[createRecording] File:', req.file);

    if (!req.file) {
      console.error('[createRecording] No file uploaded');
      return res.status(400).json({ error: 'No audio file provided' });
    }

    if (!title) {
      console.error('[createRecording] No title provided');
      return res.status(400).json({ error: 'Title is required' });
    }

    // Look up user by email
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      console.error('[createRecording] User not found:', userEmail);
      return res.status(401).json({ error: 'User not found' });
    }

    // Store file path relative to uploads directory
    const audioUrl = `/uploads/recordings/${req.file.filename}`;

    console.log('[createRecording] Creating recording with:', {
      userId: user._id,
      title,
      audioUrl,
      fileName: req.file.filename,
    });

    const recording = new Recording({
      userId: user._id,
      title,
      description: description || '',
      audioUrl,
      fileName: req.file.filename,
      duration: parseInt(duration) || 0,
      isPublic: isPublic === 'true' || isPublic === true,
    });

    const savedRecording = await recording.save();
    console.log('[createRecording] Recording saved:', savedRecording._id);

    res.json({
      success: true,
      message: 'Recording saved successfully',
      recording: savedRecording,
    });
  } catch (err) {
    console.error('[createRecording] Error:', err);
    res.status(500).json({ error: 'Failed to save recording: ' + err.message });
  }
};

exports.getUserRecordings = async (req, res) => {
  try {
    const userEmail = req.user?.email;

    // Look up user by email
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      console.error('[getUserRecordings] User not found:', userEmail);
      return res.status(401).json({ error: 'User not found' });
    }

    const recordings = await Recording.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({
      success: true,
      recordings,
    });
  } catch (err) {
    console.error('[getUserRecordings] Error:', err);
    res.status(500).json({ error: 'Failed to fetch recordings' });
  }
};

exports.deleteRecording = async (req, res) => {
  try {
    const userEmail = req.user?.email;
    const { recordingId } = req.params;

    // Look up user by email
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      console.error('[deleteRecording] User not found:', userEmail);
      return res.status(401).json({ error: 'User not found' });
    }

    const recording = await Recording.findById(recordingId);
    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    if (recording.userId.toString() !== user._id.toString()) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Delete file from disk
    const filePath = path.join(__dirname, '../public', recording.audioUrl);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await Recording.findByIdAndDelete(recordingId);

    res.json({
      success: true,
      message: 'Recording deleted',
    });
  } catch (err) {
    console.error('[deleteRecording] Error:', err);
    res.status(500).json({ error: 'Failed to delete recording' });
  }
};

exports.getRecordingById = async (req, res) => {
  try {
    const { recordingId } = req.params;
    const recording = await Recording.findById(recordingId).populate('userId', 'name email');

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    res.json({
      success: true,
      recording,
    });
  } catch (err) {
    console.error('[getRecordingById] Error:', err);
    res.status(500).json({ error: 'Failed to fetch recording' });
  }
};
