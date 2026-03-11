const express = require('express');
const router = express.Router();
const recordingController = require('../controllers/recordingController');
const authenticateToken = require('../middleware/auth');
const uploadRecording = require('../middleware/uploadRecording');

/**
 * @swagger
 * /user/recordings:
 *   post:
 *     summary: Upload and save a recording
 *     tags: [Recordings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               duration:
 *                 type: number
 *               isPublic:
 *                 type: boolean
 *               audioFile:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Recording saved successfully
 */
router.post('/user/recordings', authenticateToken, uploadRecording.single('audioFile'), recordingController.createRecording);

/**
 * @swagger
 * /user/recordings:
 *   get:
 *     summary: Get all recordings for the logged-in user
 *     tags: [Recordings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of user's recordings
 */
router.get('/user/recordings', authenticateToken, recordingController.getUserRecordings);

/**
 * @swagger
 * /user/recordings/{recordingId}:
 *   delete:
 *     summary: Delete a recording
 *     tags: [Recordings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: recordingId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Recording deleted
 */
router.delete('/user/recordings/:recordingId', authenticateToken, recordingController.deleteRecording);

/**
 * @swagger
 * /recordings/{recordingId}:
 *   get:
 *     summary: Get recording details by ID
 *     tags: [Recordings]
 *     parameters:
 *       - in: path
 *         name: recordingId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Recording details
 */
router.get('/recordings/:recordingId', recordingController.getRecordingById);

module.exports = router;
