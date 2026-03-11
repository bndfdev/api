const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads/recordings directory exists in API public folder
const uploadDir = path.join(__dirname, '../public/uploads/recordings');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('Created upload directory:', uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(7);
    const filename = `recording_${timestamp}_${randomStr}.m4a`;
    cb(null, filename);
  },
});

const uploadRecording = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept audio files - be more lenient with mime types
    const allowedMimes = ['audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a'];
    const fileName = file.originalname.toLowerCase();
    
    if (allowedMimes.includes(file.mimetype) || fileName.endsWith('.m4a') || fileName.endsWith('.mp3') || fileName.endsWith('.wav')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

module.exports = uploadRecording;
