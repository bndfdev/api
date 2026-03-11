const express = require('express');
const router = express.Router();
const genreController = require('../controllers/genreController');

/**
 * @swagger
 * /genres:
 *   get:
 *     summary: Get all active genres
 *     description: Returns a list of all active genres with name, description, image, and status.
 *     tags:
 *       - Genre
 *     responses:
 *       200:
 *         description: List of active genres
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   description:
 *                     type: string
 *                   image:
 *                     type: string
 *                   status:
 *                     type: string
 *                     enum: [active, inactive]
 */
router.get('/genres', genreController.getActiveGenres);

module.exports = router;
