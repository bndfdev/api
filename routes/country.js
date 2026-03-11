const express = require('express');
const router = express.Router();
const countryController = require('../controllers/countryController');


/**
 * @swagger
 * /countries/list:
 *   get:
 *     summary: Get all countries
 *     description: Returns a list of all countries with flag, code, and countryCode.
 *     tags:
 *       - Country
 *     responses:
 *       200:
 *         description: List of countries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 countries:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       code:
 *                         type: string
 *                       countryCode:
 *                         type: string
 *                       flag:
 *                         type: string
 */
router.get('/list', countryController.listAllCountries);

module.exports = router;
