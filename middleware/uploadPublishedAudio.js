const multer = require('multer');
const path = require('path');
const fs = require('fs');

const audioDir = path.join(__dirname, '../public/uploads/published_audio/audio');
const imageDir = path.join(__dirname, '../public/uploads/published_audio/images');

if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}
if (!fs.existsSync(imageDir)) {
  fs.mkdirSync(imageDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'audio_file') {
      cb(null, audioDir);
    } else if (file.fieldname === 'audio_image') {
      cb(null, imageDir);
    } else {
      cb(new Error('Unknown field: ' + file.fieldname));
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(7);
    const ext = path.extname(file.originalname);
    const prefix = file.fieldname === 'audio_file' ? 'audio' : 'image';
    cb(null, `${prefix}_${timestamp}_${randomStr}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'audio_file') {
    const allowedMimes = [
      'audio/mpeg',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/wav',
      'audio/ogg',
      'audio/flac',
      'audio/aac',
    ];
    const name = file.originalname.toLowerCase();
    const audioExts = ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.mp4'];
    if (allowedMimes.includes(file.mimetype) || audioExts.some((e) => name.endsWith(e))) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed for audio_file'));
    }
  } else if (file.fieldname === 'audio_image') {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const name = file.originalname.toLowerCase();
    const imgExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (allowedMimes.includes(file.mimetype) || imgExts.some((e) => name.endsWith(e))) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for audio_image'));
    }
  } else {
    cb(new Error('Unknown field: ' + file.fieldname));
  }
};

const uploadPublishedAudio = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per file
  },
  fileFilter,
});

module.exports = uploadPublishedAudio;
