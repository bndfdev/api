const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const preLoginAuth = require('../middleware/preLoginAuth');

/**
 * @swagger
 * /user/unfollow-locations:
 *   post:
 *     summary: Unfollow locations for a user
 *     description: Removes one or more locations from the user's locations list.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - locations
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               locations:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["60f7c0b8e1d2c8a1b8e1d2c8", "60f7c0b8e1d2c8a1b8e1d2c9"]
 *     responses:
 *       200:
 *         description: Locations unfollowed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 locations:
 *                   type: array
 *                   items:
 *                     type: string
 */
router.post('/unfollow-locations', userController.unfollowLocations);

/**
 * @swagger
 * /user/set-locations:
 *   post:
 *     summary: Set user's followed locations
 *     description: Allows a user to follow (add) multiple locations.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - locations
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               locations:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["60f7c0b8e1d2c8a1b8e1d2c8", "60f7c0b8e1d2c8a1b8e1d2c9"]
 *     responses:
 *       200:
 *         description: Countries followed successfully
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
 *                     type: string
 */
router.post('/set-locations', userController.setCountries);

/**
 * @swagger
 * /user/unfollow-genres:
 *   post:
 *     summary: Unfollow genres for a user
 *     description: Removes one or more genres from the user's preferred genres list.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - genres
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               genres:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["60f7c0b8e1d2c8a1b8e1d2c8", "60f7c0b8e1d2c8a1b8e1d2c9"]
 *     responses:
 *       200:
 *         description: Genres unfollowed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 genres:
 *                   type: array
 *                   items:
 *                     type: string
 */
router.post('/unfollow-genres', userController.unfollowGenres);

/**
 * @swagger
 * /user/unfollow-artists:
 *   post:
 *     summary: Unfollow artists for a user
 *     description: Removes one or more artists from the user's followed artists list.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - artists
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               artists:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["60f7c0b8e1d2c8a1b8e1d2c8", "60f7c0b8e1d2c8a1b8e1d2c9"]
 *     responses:
 *       200:
 *         description: Artists unfollowed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: string
 */
router.post('/unfollow-artists', userController.unfollowArtists);

/**
 * @swagger
 * /user/set-artists:
 *   post:
 *     summary: Set user's followed artists
 *     description: Allows a user to select multiple artists to follow.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - artists
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               artists:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["60f7c0b8e1d2c8a1b8e1d2c8", "60f7c0b8e1d2c8a1b8e1d2c9"]
 *     responses:
 *       200:
 *         description: Artists updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: string
 */
router.post('/set-artists', require('../controllers/userController').setArtists);

/**
 * @swagger
 * /user/set-genres:
 *   post:
 *     summary: Set user's preferred genres
 *     description: Allows a user to select multiple genres. Updates genre counters accordingly.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - genres
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               genres:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["60f7c0b8e1d2c8a1b8e1d2c8", "60f7c0b8e1d2c8a1b8e1d2c9"]
 *     responses:
 *       200:
 *         description: Genres updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 genres:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Genre'
 *       400:
 *         description: Invalid or expired verification token, missing fields, or invalid genres
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to update genres
 */
router.post('/set-genres', userController.setGenres);



/**
 * @swagger
 * /user/set-preferred-language:
 *   post:
 *     summary: Set user's preferred language
 *     description: Updates the user's preferred language using the verification token.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - preferredLanguage
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               preferredLanguage:
 *                 type: string
 *                 example: English
 *     responses:
 *       200:
 *         description: Preferred language updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid or expired verification token, missing fields, or invalid language
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to update preferred language
 */
router.post('/set-preferred-language', preLoginAuth, userController.setPreferredLanguage);

/**
 * @swagger
 * /user/verify-mobile-otp:
 *   post:
 *     summary: Verify mobile OTP
 *     description: Verifies the OTP sent to the user's mobile number. Returns a verification token if successful.
 *     tags:
 *       - User
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - otp
 *               - verificationToken
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "+1234567890"
 *               otp:
 *                 type: string
 *                 example: "123456"
 *               verificationToken:
 *                 type: string
 *                 example: "your-verification-token"
 *     responses:
 *       200:
 *         description: OTP verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 verificationToken:
 *                   type: string
 *       400:
 *         description: Invalid or expired OTP
 *       500:
 *         description: Failed to verify OTP
 */
router.post('/verify-mobile-otp', userController.verifyMobileOtp);

/**
 * @swagger
 * /user/send-mobile-otp:
 *   post:
 *     summary: Send OTP to mobile (dev only)
 *     description: Always stores 123456 as OTP for the given phone number (for development/testing only). Requires a valid verification token.
 *     tags:
 *       - User
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - verificationToken
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "+1234567890"
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: Phone and verification token are required, or verification token is invalid/expired
 *       500:
 *         description: Failed to send OTP
 */
router.post('/send-mobile-otp', userController.sendMobileOtp);

/**
 * @swagger
 * /user/check-phone:
 *   post:
 *     summary: Check if phone number exists
 *     description: Checks if the provided phone number is already registered. No authentication required.
 *     tags:
 *       - User
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *             required:
 *               - phone
 *               - verificationToken
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "+1234567890"
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *     responses:
 *       200:
 *         description: Phone check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exists:
 *                   type: boolean
 *                   description: Whether the phone exists
 *       400:
 *         description: Phone or verification token is required
 *       500:
 *         description: Database error
 */
router.post('/check-phone', userController.checkPhone);

/**
 * @swagger
 * /user/set-gender:
 *   post:
 *     summary: Set user's gender
 *     description: Updates the user's gender using the verification token.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - gender
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               gender:
 *                 type: string
 *                 enum: [male, female, other]
 *                 example: male
 *     responses:
 *       200:
 *         description: Gender updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid or expired verification token, missing fields, or invalid gender
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to update gender
 */
router.post('/set-gender', preLoginAuth, userController.setGender);

/**
 * @swagger
 * /user/create-password:
 *   post:
 *     summary: Create password and register user
 *     description: Sets the password for a user after successful OTP verification. Hashes password and creates user.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 example: mySecretPassword123
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *     responses:
 *       200:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: Email or password missing, or user already exists
 *       500:
 *         description: Failed to create user
 */
router.post('/create-password', preLoginAuth, userController.createPassword);

/**
 * @swagger
 * /user/verify-otp:
 *   post:
 *     summary: Verify OTP
 *     description: Verifies the OTP sent to the user's email address.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               otp:
 *                 type: string
 *                 example: '123456'
 *     responses:
 *       200:
 *         description: OTP verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: Invalid or expired OTP
 */
router.post('/verify-otp', preLoginAuth, userController.verifyOtp);


/**
 * @swagger
 * /user/send-otp:
 *   post:
 *     summary: Send OTP to email
 *     description: Sends a one-time password (OTP) to the provided email address.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 otp:
 *                   type: string
 *                   description: The OTP sent (for demo only)
 *       400:
 *         description: Email is required
 *       500:
 *         description: Failed to send OTP
 */
router.post('/send-otp', preLoginAuth, userController.sendOtp);

/**
 * @swagger
 * /user/send-reset-password-otp:
 *   post:
 *     summary: Send OTP for password reset
 *     description: Sends a 6-digit OTP to the user's email for password reset. Email must be registered.
 *     tags: [User]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       400:
 *         description: Email is required
 *       404:
 *         description: Email not found
 *       429:
 *         description: Too many OTP requests
 *       500:
 *         description: Failed to send OTP
 */
router.post('/send-reset-password-otp', preLoginAuth, userController.sendResetPasswordOtp);

/**
 * @swagger
 * /user/verify-reset-password-otp:
 *   post:
 *     summary: Verify OTP for password reset
 *     description: Verifies the 6-digit OTP sent to user's email for password reset and returns a verification token.
 *     tags: [User]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *               example:
 *                 email: user@example.com
 *                 otp: '123456'
 *     responses:
 *       200:
 *         description: OTP verified successfully, returns verification token
 *       400:
 *         description: Invalid or expired OTP
 *       404:
 *         description: User not found
 */
router.post('/verify-reset-password-otp', preLoginAuth, userController.verifyResetPasswordOtp);

/**
 * @swagger
 * /user/reset-password:
 *   post:
 *     summary: Reset password using verification token
 *     description: Updates the user's password using the verification token returned from OTP verification.
 *     tags: [User]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               verificationToken:
 *                 type: string
 *               password:
 *                 type: string
 *             example:
 *               verificationToken: 'abcdef123456'
 *               password: 'NewP@ssw0rd!'
 *     responses:
 *       200:
 *         description: Password updated successfully
 *       400:
 *         description: Invalid request or weak password
 *       401:
 *         description: Invalid or expired verification token
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to reset password
 */
router.post('/reset-password', preLoginAuth, userController.resetPassword);

/**
 * @swagger
 * /user/save-guest-user:
 *   post:
 *     summary: Save guest user
 *     description: Creates or updates a guest user with device info and preferred language.
 *     tags: [User]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - deviceId
 *               - deviceName
 *               - preferredLanguage
 *             properties:
 *               deviceId:
 *                 type: string
 *               deviceName:
 *                 type: string
 *               preferredLanguage:
 *                 type: string
 *                 enum: [English, Spanish]
 *     responses:
 *       200:
 *         description: Guest user saved successfully
 *       400:
 *         description: Missing required fields or invalid language
 *       500:
 *         description: Failed to save guest user
 */
router.post('/save-guest-user', preLoginAuth, userController.saveGuestUser);

/**
 * @swagger
 * /user/check-email:
 *   post:
 *     summary: Check if email exists
 *     description: Checks if the provided email is already registered.
 *     tags:
 *       - User
 *     parameters:
 *       - in: header
 *         name: x-api-key
 *         schema:
 *           type: string
 *         required: true
 *         description: Pre-login API key (see .env PRE_LOGIN_API_KEY)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *     responses:
 *       200:
 *         description: Email check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exists:
 *                   type: boolean
 *                   description: Whether the email exists
 *       400:
 *         description: Email is required
 *       500:
 *         description: Database error
 */
router.post('/check-email', preLoginAuth, userController.checkEmail);

/**
 * @swagger
 * /user/set-dob:
 *   post:
 *     summary: Set user's date of birth
 *     description: Updates the user's date of birth using the verification token.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - dateOfBirth
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               dateOfBirth:
 *                 type: string
 *                 format: date
 *                 example: 1990-01-01
 *     responses:
 *       200:
 *         description: Date of birth updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid or expired verification token, or missing fields
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to update date of birth
 */
router.post('/set-dob', preLoginAuth, userController.setDob);

/**
 * @swagger
 * /user/login:
 *   post:
 *     summary: Login with email and password
 *     description: Authenticates user with email and password. Returns user data and mobile verification status.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 example: mySecretPassword123
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     email:
 *                       type: string
 *                     name:
 *                       type: string
 *                     phone:
 *                       type: string
 *                     mobileNumberVerified:
 *                       type: boolean
 *                     dateOfBirth:
 *                       type: string
 *                       format: date
 *                     gender:
 *                       type: string
 *       400:
 *         description: Email or password missing
 *       401:
 *         description: Invalid email or password
 *       500:
 *         description: Failed to login
 */
router.post('/login', preLoginAuth, userController.login);

/**
 * @swagger
 * /user/update-name:
 *   post:
 *     summary: Update user's name
 *     description: Allows a user to update their profile name.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - name
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               name:
 *                 type: string
 *                 example: John Doe
 *     responses:
 *       200:
 *         description: Name updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 name:
 *                   type: string
 *       400:
 *         description: Verification token and name are required
 *       401:
 *         description: Invalid or expired verification token
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to update name
 */
router.post('/update-name', userController.updateName);

/**
 * @swagger
 * /user/upload-avatar:
 *   post:
 *     summary: Upload user's avatar image
 *     description: Allows a user to upload a profile avatar image.
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - verificationToken
 *               - image
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 example: 0123456789abcdef
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Image file (JPEG, PNG, WebP, GIF)
 *     responses:
 *       200:
 *         description: Avatar uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 profileImage:
 *                   type: string
 *       400:
 *         description: Verification token or image file missing
 *       401:
 *         description: Invalid or expired verification token
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to upload avatar
 */
const uploadAvatar = require('../middleware/uploadAvatar');
router.post('/upload-avatar', uploadAvatar.single('image'), userController.uploadAvatar);

/**
 * @swagger
 * /user/upload-banner:
 *   post:
 *     summary: Upload user profile banner
 *     description: Upload and save user profile banner image
 *     tags:
 *       - User
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               verificationToken:
 *                 type: string
 *                 description: User verification token
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Banner image file
 *     responses:
 *       200:
 *         description: Banner uploaded successfully
 *       400:
 *         description: Invalid request (missing token or image)
 *       401:
 *         description: Invalid or expired verification token
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to upload banner
 */
const uploadBanner = require('../middleware/uploadBanner');
router.post('/upload-banner', uploadBanner.single('image'), userController.uploadBanner);

module.exports = router;
