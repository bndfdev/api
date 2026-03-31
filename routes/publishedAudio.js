const express = require('express');
const router = express.Router();
const publishedAudioController = require('../controllers/publishedAudioController');
const authenticateToken = require('../middleware/auth');
const uploadPublishedAudio = require('../middleware/uploadPublishedAudio');

/**
 * @swagger
 * /post_publish_audio:
 *   post:
 *     summary: Publish an audio track
 *     description: Uploads an audio file and a cover image, then stores the record in the database.
 *     tags:
 *       - Published Audio
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - audio_title
 *               - audio_label
 *               - audio_file
 *               - audio_image
 *             properties:
 *               audio_title:
 *                 type: string
 *               audio_label:
 *                 type: string
 *               audio_file:
 *                 type: string
 *                 format: binary
 *               audio_image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Audio published successfully
 *       400:
 *         description: Missing required fields
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post(
  '/post_publish_audio',
  authenticateToken,
  uploadPublishedAudio.fields([
    { name: 'audio_file', maxCount: 1 },
    { name: 'audio_image', maxCount: 1 },
  ]),
  publishedAudioController.postPublishAudio
);

module.exports = router;
