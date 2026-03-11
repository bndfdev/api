const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads/avatars directory exists in API public folder
const uploadDir = path.join(__dirname, '../public/uploads/avatars');
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
    const ext = path.extname(file.originalname);
    const filename = `avatar_${timestamp}_${randomStr}${ext}`;
    cb(null, filename);
  },
});

const uploadAvatar = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for avatar
  },
  fileFilter: (req, file, cb) => {
    // Accept image files
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const fileName = file.originalname.toLowerCase();
    
    if (allowedMimes.includes(file.mimetype) || 
        fileName.endsWith('.jpg') || 
        fileName.endsWith('.jpeg') || 
        fileName.endsWith('.png') || 
        fileName.endsWith('.webp') || 
        fileName.endsWith('.gif')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

module.exports = uploadAvatar;
