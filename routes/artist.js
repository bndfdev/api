const express = require('express');
const router = express.Router();

const artistController = require('../controllers/artistController');

/**
 * @swagger
 * /artists:
 *   get:
 *     summary: Get all active artists
 *     description: Returns a list of all active artists with name, bio, image, and status.
 *     tags:
 *       - Artist
 *     responses:
 *       200:
 *         description: List of active artists
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   bio:
 *                     type: string
 *                   image:
 *                     type: string
 *                   status:
 *                     type: string
 *                     enum: [active, inactive]
 */
router.get('/artists', artistController.getActiveArtists);


module.exports = router;
