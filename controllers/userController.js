// POST /user/unfollow-locations
exports.unfollowLocations = async (req, res) => {
  const { verificationToken, locations } = req.body;
  if (!verificationToken || !Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: 'Verification token and locations array are required' });
  }
  try {
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    const UserPreference = require('../models/UserPreference');
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    let userPref = await UserPreference.findOne({ user: user._id });
    if (userPref && Array.isArray(userPref.locations)) {
      userPref.locations = userPref.locations.filter(lid => !locations.includes(lid.toString()));
      await userPref.save();
      return res.json({ success: true, locations: userPref.locations });
    } else {
      return res.status(404).json({ error: 'No locations found for user' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to unfollow locations' });
  }
};
// POST /user/set-countries
exports.setCountries = async (req, res) => {
  const { verificationToken, locations } = req.body;
  if (!verificationToken || !Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: 'Verification token and locations array are required' });
  }
  try {
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    const UserPreference = require('../models/UserPreference');
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    let userPref = await UserPreference.findOne({ user: user._id });
    if (userPref) {
      userPref.locations = locations;
      await userPref.save();
    } else {
      userPref = await UserPreference.create({ user: user._id, locations: locations });
    }
    res.json({ success: true, locations: userPref.locations });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save followed countries' });
  }
};
// POST /user/unfollow-genres
exports.unfollowGenres = async (req, res) => {
  const { verificationToken, genres } = req.body;
  if (!verificationToken || !Array.isArray(genres) || genres.length === 0) {
    return res.status(400).json({ error: 'Verification token and genres array are required' });
  }
  try {
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    const UserPreference = require('../models/UserPreference');
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    let userPref = await UserPreference.findOne({ user: user._id });
    if (userPref && Array.isArray(userPref.genres)) {
      userPref.genres = userPref.genres.filter(gid => !genres.includes(gid.toString()));
      await userPref.save();
      return res.json({ success: true, genres: userPref.genres });
    } else {
      return res.status(404).json({ error: 'No preferred genres found for user' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to unfollow genres' });
  }
};
// POST /user/unfollow-artists
exports.unfollowArtists = async (req, res) => {
  const { verificationToken, artists } = req.body;
  if (!verificationToken || !Array.isArray(artists) || artists.length === 0) {
    return res.status(400).json({ error: 'Verification token and artists array are required' });
  }
  try {
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    const UserPreference = require('../models/UserPreference');
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    let userPref = await UserPreference.findOne({ user: user._id });
    if (userPref && Array.isArray(userPref.artists)) {
      userPref.artists = userPref.artists.filter(aid => !artists.includes(aid.toString()));
      await userPref.save();
      return res.json({ success: true, artists: userPref.artists });
    } else {
      return res.status(404).json({ error: 'No followed artists found for user' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to unfollow artists' });
  }
};
// POST /user/set-artists
exports.setArtists = async (req, res) => {
  debugger;
  const { verificationToken, artists } = req.body;
  console.log('[set-artists] Body:', req.body);
  if (!verificationToken || !Array.isArray(artists) || artists.length === 0) {
    console.log('[set-artists] Missing verificationToken or artists array');
    return res.status(400).json({ error: 'Verification token and artists array are required' });
  }
  try {
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    const UserPreference = require('../models/UserPreference');
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      console.log('[set-artists] Invalid or expired verification token');
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      console.log('[set-artists] User not found for email:', normalizedEmail);
      return res.status(404).json({ error: 'User not found' });
    }
    let userPref = await UserPreference.findOne({ user: user._id });
    if (userPref) {
      userPref.artists = artists;
      await userPref.save();
      console.log('[set-artists] Updated artists for userPref:', userPref._id, artists);
    } else {
      userPref = await UserPreference.create({ user: user._id });
      console.log('[set-artists] Created new userPref for user:', user._id);
    }
    res.json({ success: true, artists: userPref.artists });
  } catch (err) {
    console.log('[set-artists] Error:', err);
    res.status(500).json({ error: 'Failed to save followed artists' });
  }
};
// POST /user/set-genres
exports.setGenres = async (req, res) => {
  const { verificationToken, genres } = req.body;
  if (!verificationToken || !Array.isArray(genres) || genres.length === 0) {
    return res.status(400).json({ error: 'Verification token and genres array are required' });
  }
  try {
    // Validate verification token
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    const Genre = require('../models/Genre');
    const UserPreference = require('../models/UserPreference');
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Find previous preferences
    let userPref = await UserPreference.findOne({ user: user._id });
    const prevGenres = userPref ? userPref.genres.map(g => g.toString()) : [];
    // Update or create user preference
    if (userPref) {
      userPref.genres = genres;
      await userPref.save();
    } else {
      userPref = await UserPreference.create({ user: user._id, genres });
    }
    // Update genre counters
    // 1. Decrement counters for genres that were previously selected but are not in the new selection
    const toDecrement = prevGenres.filter(gid => !genres.includes(gid));
    // 2. Increment counters for genres newly selected
    const toIncrement = genres.filter(gid => !prevGenres.includes(gid));
    if (toDecrement.length > 0) {
      await Genre.updateMany(
        { _id: { $in: toDecrement } },
        { $inc: { counter: -1 } }
      );
    }
    if (toIncrement.length > 0) {
      await Genre.updateMany(
        { _id: { $in: toIncrement } },
        { $inc: { counter: 1 } }
      );
    }
    // Populate genres for response and filter fields
    const genresPopulated = await Genre.find({ _id: { $in: userPref.genres } });
    // Set image as full URL if present
    const apiBaseUrl = process.env.API_BASE_URL || 'http://192.168.29.39:3000';
    const filteredGenres = genresPopulated.map(g => ({
      name: g.name,
      description: g.description,
      image: g.image ? `${apiBaseUrl}/uploads/genres/${g.image}` : null
    }));
    res.json({ success: true, genres: filteredGenres });
  } catch (err) {
    console.error('[setGenres] Error:', err);
    res.status(500).json({ error: 'Failed to set genres' });
  }
};
// POST /user/set-preferred-language
exports.setPreferredLanguage = async (req, res) => {
  const { verificationToken, preferredLanguage } = req.body;
  if (!verificationToken || !preferredLanguage) {
    return res.status(400).json({ error: 'Verification token and preferred language are required' });
  }
  try {
    // Validate verification token
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { preferredLanguage },
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Filter out sensitive fields
    const filteredUser = {
      email: user.email,
      name: user.name,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      preferredLanguage: user.preferredLanguage
    };
    res.json({ success: true, user: filteredUser });
  } catch (err) {
    console.error('[setPreferredLanguage] Error:', err);
    res.status(500).json({ error: 'Failed to set preferred language' });
  }
};

// POST /user/save-guest-user
exports.saveGuestUser = async (req, res) => {
  const { deviceId, deviceName, preferredLanguage } = req.body;
  if (!deviceId || !deviceName || !preferredLanguage) {
    return res.status(400).json({ error: 'Device ID, device name, and preferred language are required' });
  }

  if (!['English', 'Spanish'].includes(preferredLanguage)) {
    return res.status(400).json({ error: 'Invalid preferred language' });
  }

  try {
    const existingGuest = await GuestUser.findOne({ deviceId });
    let guest;

    if (existingGuest) {
      // Update existing guest user
      guest = await GuestUser.findOneAndUpdate(
        { deviceId },
        {
          deviceName,
          preferredLanguage,
          updatedAt: new Date(),
        },
        { new: true }
      );
    } else {
      // Create new guest user
      guest = await GuestUser.create({
        deviceId,
        deviceName,
        preferredLanguage,
      });
    }

    res.json({ success: true, guest });
  } catch (err) {
    console.error('[saveGuestUser] Error:', err);
    res.status(500).json({ error: 'Failed to save guest user' });
  }
};
// POST /user/verify-mobile-otp
exports.verifyMobileOtp = async (req, res) => {
  const { phone, otp, verificationToken } = req.body;
  if (!phone || !otp || !verificationToken) {
    return res.status(400).json({ error: 'Phone, OTP, and verification token are required' });
  }
  try {
    // Validate verification token
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    // Find OTP entry for phone
    const otpEntry = await MobileOtp.findOne({ phone });
    if (!otpEntry || otpEntry.otp !== otp || new Date() > otpEntry.expires) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }
    // Check if phone is already used by another user
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const existingUserWithPhone = await User.findOne({ phone, email: { $ne: normalizedEmail } });
    if (existingUserWithPhone) {
      return res.status(400).json({ error: 'Phone number is already registered to another account.' });
    }
    // Update user's mobile number and mark as verified
    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { phone, mobileNumberVerified: true },
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
};
// Models
const MobileOtp = require('../models/MobileOtp');
const MobileOtpSendLog = require('../models/MobileOtpSendLog');
// POST /user/send-mobile-otp
exports.sendMobileOtp = async (req, res) => {
  const { phone, verificationToken } = req.body;
  if (!phone || !verificationToken) {
    return res.status(400).json({ error: 'Phone and verification token are required' });
  }
  try {
    // Validate verification token
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    // Check if phone already exists in users collection
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({ error: 'Phone number is already registered' });
    }

    // Check if account is blocked (in MobileOtp)
    const otpDoc = await MobileOtp.findOne({ phone });
    if (otpDoc && otpDoc.blocked) {
      return res.status(403).json({ error: 'Account is blocked due to too many failed OTP attempts.' });
    }

    // Count OTP send attempts in the last 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sendCount = await MobileOtpSendLog.countDocuments({ phone, sentAt: { $gte: since } });
    if (sendCount >= 5) {
      // Block the account in MobileOtp
      await MobileOtp.findOneAndUpdate(
        { phone },
        { blocked: true, blockReason: 'Too many OTP requests' },
        { upsert: true }
      );
      return res.status(403).json({ error: 'Account is blocked due to too many failed OTP attempts.' });
    }

    // Store OTP '123456' for 10 minutes (600 seconds) in MobileOtp collection
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    await MobileOtp.findOneAndUpdate(
      { phone },
      { phone, otp: '123456', expires },
      { upsert: true, new: true }
    );
    // Log mobile OTP send event
    await MobileOtpSendLog.create({ phone });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
};
// External dependencies
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Models
const User = require('../models/User');
const GuestUser = require('../models/GuestUser');
const PendingEmail = require('../models/PendingEmail');
const VerificationToken = require('../models/VerificationToken');
const PasswordResetToken = require('../models/PasswordResetToken');
const EmailOtpSendLog = require('../models/OtpSendLog');

// Utils
const mailer = require('../utils/mailer');
const otpStore = require('../utils/otpStore');

// POST /user/set-gender
exports.setGender = async (req, res) => {
  const { verificationToken, gender } = req.body;
  if (!verificationToken || !gender) {
    return res.status(400).json({ error: 'Verification token and gender are required' });
  }
  if (!['male', 'female', 'other'].includes(gender)) {
    return res.status(400).json({ error: 'Invalid gender value' });
  }
  try {
    // Find verification token entry
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    console.log('[setGender] verificationToken:', verificationToken);
    console.log('[setGender] tokenEntry:', tokenEntry);
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      console.log('[setGender] Invalid or expired verification token');
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    console.log('[setGender] normalizedEmail:', normalizedEmail);
    // Update user's gender
    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { gender },
      { new: true }
    );
    console.log('[setGender] user lookup result:', user);
    if (!user) {
      console.log('[setGender] User not found for email:', normalizedEmail);
      return res.status(404).json({ error: 'User not found' });
    }
    // Filter out sensitive fields
    const filteredUser = {
      email: user.email,
      name: user.name,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      preferredLanguage: user.preferredLanguage
    };
    res.json({ success: true, user: filteredUser });
  } catch (err) {
    console.error('[setGender] Error:', err);
    res.status(500).json({ error: 'Failed to update gender' });
  }
};


// POST /user/send-otp
exports.sendOtp = async (req, res) => {
  const { email } = req.body;
  console.log("[sendOtp] Request received for email:", email);
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  // Normalize email
  const normalizedEmail = email.trim().toLowerCase();
  // Check if email already exists in users collection
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    return res.status(400).json({ error: 'Email is already registered' });
  }

  // Count OTP send attempts in the last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sendCount = await EmailOtpSendLog.countDocuments({ email: normalizedEmail, sentAt: { $gte: since } });
  if (sendCount >= 5) {
    return res.status(429).json({ error: 'Too many OTP requests. Please try again after 24 hours.' });
  }

  // Store email in PendingEmail if not already present
  try {
    await PendingEmail.updateOne(
      { email: normalizedEmail },
      { $setOnInsert: { email: normalizedEmail } },
      { upsert: true }
    );
  } catch (err) {
    // Ignore duplicate errors
  }
  const otp = mailer.generateOtp();
  // Store OTP for 10 minutes (600 seconds)
  await otpStore.saveOtp(normalizedEmail, otp, 600);
  const sent = await mailer.sendOtpEmail(normalizedEmail, otp);
  if (sent) {
    // Log OTP send event
    console.log("[sendOtp] Creating EmailOtpSendLog for email:", normalizedEmail);
    await EmailOtpSendLog.create({ email: normalizedEmail });
    console.log("[sendOtp] EmailOtpSendLog created for email:", normalizedEmail);
    res.json({ success: true }); // Do NOT send OTP back to client
  } else {
    console.error("[sendOtp] Failed to send OTP email for:", normalizedEmail);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
};

// POST /user/send-reset-password-otp
exports.sendResetPasswordOtp = async (req, res) => {
  const { email } = req.body;
  console.log("[sendResetPasswordOtp] Request received for email:", email);
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  // Normalize email
  const normalizedEmail = email.trim().toLowerCase();
  // Check if email exists in users collection
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (!existingUser) {
    return res.status(404).json({ error: 'Email not found' });
  }

  // Count OTP send attempts in the last 1 hour
  const since = new Date(Date.now() - 1 * 60 * 60 * 1000);
  const sendCount = await EmailOtpSendLog.countDocuments({ email: normalizedEmail, sentAt: { $gte: since } });
  if (sendCount >= 5) {
    return res.status(429).json({ error: 'Too many OTP requests. Please try again after 1 hour.' });
  }

  const otp = mailer.generateOtp();
  // Store OTP for 10 minutes (600 seconds)
  await otpStore.saveOtp(normalizedEmail, otp, 600);
  const sent = await mailer.sendOtpEmail(normalizedEmail, otp);
  if (sent) {
    // Log OTP send event
    console.log("[sendResetPasswordOtp] Creating EmailOtpSendLog for email:", normalizedEmail);
    await EmailOtpSendLog.create({ email: normalizedEmail });
    console.log("[sendResetPasswordOtp] EmailOtpSendLog created for email:", normalizedEmail);
    res.json({ success: true }); // Do NOT send OTP back to client
  } else {
    console.error("[sendResetPasswordOtp] Failed to send OTP email for:", normalizedEmail);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
};

// POST /user/verify-otp
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }
  const valid = await otpStore.verifyOtp(email, otp);
  if (valid) {
    // Generate a secure random token
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    const lastRefreshed = new Date();
    await VerificationToken.findOneAndUpdate(
      { email },
      { token, expires, lastRefreshed },
      { upsert: true, new: true }
    );
    res.json({ success: true, verificationToken: token });
  } else {
    res.status(400).json({ error: 'Invalid or expired OTP' });
  }
};

// POST /user/verify-reset-password-otp
exports.verifyResetPasswordOtp = async (req, res) => {
  const { email, otp } = req.body;
  console.log("[verifyResetPasswordOtp] Request received for email:", email);
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  // Verify OTP
  const valid = await otpStore.verifyOtp(normalizedEmail, otp);
  if (valid) {
    // Check if user exists
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Generate a secure random token for password reset
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour for password reset
    await PasswordResetToken.findOneAndUpdate(
      { email: normalizedEmail },
      { token, expires },
      { upsert: true, new: true }
    );
    console.log("[verifyResetPasswordOtp] Password reset token created for:", normalizedEmail);
    res.json({ success: true, verificationToken: token, resetToken: token });
  } else {
    console.log("[verifyResetPasswordOtp] Invalid or expired OTP for:", normalizedEmail);
    res.status(400).json({ error: 'Invalid or expired OTP' });
  }
};

// POST /user/reset-password
exports.resetPassword = async (req, res) => {
  const { verificationToken, password } = req.body;
  if (!verificationToken || !password) {
    return res.status(400).json({ error: 'Verification token and password are required' });
  }

  // Password strength validation
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
  if (!passwordRegex.test(password)) {
    return res.status(400).json({
      error:
        'Password must be at least 8 characters long and contain at least 1 uppercase letter, 1 lowercase letter, 1 number, and 1 special character.',
    });
  }

  try {
    const tokenEntry = await PasswordResetToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }

    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    user.password = hashedPassword;
    await user.save();

    await PasswordResetToken.deleteOne({ email: normalizedEmail });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
};

// POST /user/create-password
exports.createPassword = async (req, res) => {
  const { verificationToken, password, deviceId, deviceName } = req.body;
  if (!verificationToken || !password) {
    return res.status(400).json({ error: 'Verification token and password are required' });
  }
  // Password strength validation
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
  if (!passwordRegex.test(password)) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters long and contain at least 1 uppercase letter, 1 lowercase letter, 1 number, and 1 special character.'
    });
  }
  try {
    // Find verification token entry
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    // Check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    // Create user
    const user = new User({ 
      email: normalizedEmail, 
      password: hashedPassword,
      deviceId: deviceId || null,
      deviceName: deviceName || null
    });
    await user.save();
    // Remove from PendingEmail
    await exports.removePendingEmail(normalizedEmail);
    // Do NOT invalidate verification token (keep it in DB)
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
};

// POST /user/check-email
exports.checkEmail = async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  // const { verificationToken } = req.body;
  // if (!verificationToken) {
  //   return res.status(400).json({ error: 'Verification token is required' });
  // }
  try {
    const user = await User.findOne({ email });
    res.json({ exists: !!user });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
};

// POST /user/set-dob
exports.setDob = async (req, res) => {
  const { verificationToken, dateOfBirth } = req.body;
  if (!verificationToken || !dateOfBirth) {
    return res.status(400).json({ error: 'Verification token and dateOfBirth are required' });
  }
  try {
    // Find verification token entry
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    // If dateOfBirth is an ISO string, extract only the date part (YYYY-MM-DD)
    let dobString = dateOfBirth;
    if (typeof dobString === 'string' && dobString.includes('T')) {
      dobString = dobString.split('T')[0];
    }
    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { dateOfBirth: dobString },
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Filter out sensitive fields
    const filteredUser = {
      email: user.email,
      name: user.name,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      preferredLanguage: user.preferredLanguage
    };
    res.json({ success: true, user: filteredUser });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update date of birth' });
  }
};

// Utility: Remove email from PendingEmail after registration
exports.removePendingEmail = async (email) => {
  try {
    const normalizedEmail = email.trim().toLowerCase();
    await PendingEmail.deleteOne({ email: normalizedEmail });
  } catch (err) {
    // Ignore errors
  }
};

// POST /user/check-phone
exports.checkPhone = async (req, res) => {
  const { verificationToken, phone } = req.body;
  if (!verificationToken || !phone) {
    return res.status(400).json({ error: 'Verification token and phone are required' });
  }
  try {
    // Find verification token entry
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    if (!tokenEntry || new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Invalid or expired verification token' });
    }
    // Check if phone exists for any user
    const existingUser = await User.findOne({ phone });
    res.json({ exists: !!existingUser });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
};

// POST /user/login
exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const normalizedEmail = email.trim().toLowerCase();
    // Find user by email
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Check if account is blocked and if block period has expired
    if (user.isBlocked) {
      console.log('[login] User is blocked:', user.email, 'blockedUntil:', user.blockedUntil);
      if (user.blockedUntil && new Date() < user.blockedUntil) {
        const minutesLeft = Math.ceil((user.blockedUntil - new Date()) / 60000);
        return res.status(403).json({ error: `Account is blocked due to too many failed login attempts. Try again in ${minutesLeft} minutes.` });
      } else {
        // Unblock after 1 hour
        // Remove block fields after unblock
        user.isBlocked = undefined;
        user.blockedUntil = undefined;
        user.failedLoginAttempts = undefined;
        await user.save();
        console.log('[login] User unblocked and block fields removed:', user.email);
      }
    }
    // Compare password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      console.log('[login] Failed login attempt:', user.email, 'failedLoginAttempts:', user.failedLoginAttempts);
      if (user.failedLoginAttempts >= 5) {
        user.isBlocked = true;
        user.blockedUntil = new Date(Date.now() + 60 * 60 * 1000); // Block for 1 hour
        console.log('[login] User blocked:', user.email, 'blockedUntil:', user.blockedUntil);
      }
      await user.save();
      if (user.isBlocked) {
        return res.status(403).json({ error: 'Account is blocked due to too many failed login attempts. Try again in 60 minutes.' });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Reset failed attempts on successful login
    if (user.failedLoginAttempts > 0) {
      // Remove block fields after successful login
      user.isBlocked = undefined;
      user.blockedUntil = undefined;
      user.failedLoginAttempts = undefined;
      await user.save();
      console.log('[login] Block fields removed after successful login:', user.email);
    }
    // Generate a new verification token and return it in the response
    const VerificationToken = require('../models/VerificationToken');
    const UserPreference = require('../models/UserPreference');
    const crypto = require('crypto');
    
    // Check if we need to refresh the token (once per day)
    let existingToken = await VerificationToken.findOne({ email: user.email });
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    let token;
    let shouldRefresh = !existingToken || 
                        !existingToken.lastRefreshed || 
                        existingToken.lastRefreshed < oneDayAgo;
    
    if (shouldRefresh) {
      // Refresh token expiration to 30 days from now
      token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
      await VerificationToken.findOneAndUpdate(
        { email: user.email },
        { token, expires, lastRefreshed: now },
        { upsert: true, new: true }
      );
    } else {
      // Use existing token without refreshing
      token = existingToken.token;
    }

    // Fetch user preferences
    let userPref = await UserPreference.findOne({ user: user._id })
      .populate('genres')
      .populate('locations')
      .populate('artists');

    // Prepare preferences for response
    let preferences = null;
    if (userPref) {
      preferences = {
        genres: Array.isArray(userPref.genres)
          ? userPref.genres.map(g => typeof g === 'object' && g !== null && g.name ? { id: g._id, name: g.name } : g)
          : [],
        locations: Array.isArray(userPref.locations)
          ? userPref.locations.map(l => typeof l === 'object' && l !== null && l.name ? { id: l._id, name: l.name } : l)
          : [],
        artists: Array.isArray(userPref.artists)
          ? userPref.artists.map(a => typeof a === 'object' && a !== null && a.name ? { id: a._id, name: a.name } : a)
          : [],
      };
    }

    res.json({
      success: true,
      verificationToken: token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name ? user.name : null,
        profileImage: user.profileImage ? user.profileImage : null,
        phone: user.phone,
        mobileNumberVerified: user.mobileNumberVerified || false,
        dateOfBirth: user.dateOfBirth ? user.dateOfBirth : null,
        gender: user.gender ? user.gender : null,
        preferences,
      },
    });
  } catch (err) {
    console.error('[login] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /user/update-name
exports.updateName = async (req, res) => {
  const { verificationToken, name } = req.body;
  if (!verificationToken || !name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Verification token and name are required' });
  }
  try {
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    
    console.log('[updateName] Received token:', verificationToken);
    console.log('[updateName] Received name:', name);
    
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    console.log('[updateName] Token entry found:', !!tokenEntry);
    
    if (!tokenEntry) {
      return res.status(401).json({ error: 'Invalid verification token' });
    }
    
    if (new Date() > tokenEntry.expires) {
      return res.status(401).json({ error: 'Verification token expired' });
    }
    
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    console.log('[updateName] Finding user with email:', normalizedEmail);
    
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    console.log('[updateName] User found:', user.email);
    user.name = name.trim();
    const savedUser = await user.save();
    console.log('[updateName] User saved with name:', savedUser.name);
    
    res.json({ success: true, name: savedUser.name });
  } catch (err) {
    console.error('[updateName] Error:', err);
    res.status(500).json({ error: 'Failed to update name', details: err.message });
  }
}

// POST /user/upload-avatar
exports.uploadAvatar = async (req, res) => {
  console.log('\n=== [uploadAvatar] Request START ===');
  console.log('[uploadAvatar] Body:', req.body);
  console.log('[uploadAvatar] File:', req.file);
  
  const { verificationToken } = req.body;
  
  if (!verificationToken) {
    console.error('[uploadAvatar] ❌ No verification token provided');
    return res.status(400).json({ success: false, error: 'Verification token is required' });
  }

  if (!req.file) {
    console.error('[uploadAvatar] ❌ No image file provided');
    return res.status(400).json({ success: false, error: 'No image file provided' });
  }

  try {
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    
    console.log('[uploadAvatar] ✓ Models loaded');
    console.log('[uploadAvatar] Received token:', verificationToken);
    console.log('[uploadAvatar] File details:', {
      filename: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
    
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    console.log('[uploadAvatar] Token lookup result:', tokenEntry ? `✓ Found for email: ${tokenEntry.email}` : '❌ Not found');
    
    if (!tokenEntry) {
      console.error('[uploadAvatar] ❌ Invalid verification token');
      return res.status(401).json({ success: false, error: 'Invalid verification token' });
    }
    
    if (new Date() > tokenEntry.expires) {
      console.error('[uploadAvatar] ❌ Verification token expired');
      return res.status(401).json({ success: false, error: 'Verification token expired' });
    }
    
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    console.log('[uploadAvatar] ✓ Token valid, normalized email:', normalizedEmail);
    
    const user = await User.findOne({ email: normalizedEmail });
    console.log('[uploadAvatar] User lookup result:', user ? `✓ Found user: ${user.email}` : `❌ Not found for email: ${normalizedEmail}`);
    
    if (!user) {
      console.error('[uploadAvatar] ❌ User not found with email:', normalizedEmail);
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    console.log('[uploadAvatar] ✓ User found:', user._id, user.email);
    
    // Construct the image URL path
    const imageUrl = `/uploads/avatars/${req.file.filename}`;
    console.log('[uploadAvatar] Setting profileImage to:', imageUrl);
    user.profileImage = imageUrl;
    console.log('[uploadAvatar] profileImage property set, about to save...');
    
    const savedUser = await user.save();
    
    console.log('[uploadAvatar] ✓ User saved successfully');
    console.log('[uploadAvatar] savedUser.profileImage:', savedUser.profileImage);
    console.log('=== [uploadAvatar] SUCCESS ===\n');
    
    res.json({ success: true, profileImage: savedUser.profileImage });
  } catch (err) {
    console.error('=== [uploadAvatar] EXCEPTION ===');
    console.error('[uploadAvatar] Error name:', err.name);
    console.error('[uploadAvatar] Error message:', err.message);
    console.error('[uploadAvatar] Error stack:', err.stack);
    console.error('=== [uploadAvatar] FAILED ===\n');
    res.status(500).json({ success: false, error: 'Failed to upload avatar', details: err.message });
  }
}

// POST /user/upload-banner
exports.uploadBanner = async (req, res) => {
  console.log('\n=== [uploadBanner] Request START ===');
  console.log('[uploadBanner] Body:', req.body);
  console.log('[uploadBanner] File:', req.file);
  
  const { verificationToken } = req.body;
  
  if (!verificationToken) {
    console.error('[uploadBanner] ❌ No verification token provided');
    return res.status(400).json({ success: false, error: 'Verification token is required' });
  }

  if (!req.file) {
    console.error('[uploadBanner] ❌ No image file provided');
    return res.status(400).json({ success: false, error: 'No image file provided' });
  }

  try {
    const VerificationToken = require('../models/VerificationToken');
    const User = require('../models/User');
    
    console.log('[uploadBanner] ✓ Models loaded');
    console.log('[uploadBanner] Received token:', verificationToken);
    console.log('[uploadBanner] File details:', {
      filename: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
    
    const tokenEntry = await VerificationToken.findOne({ token: verificationToken });
    console.log('[uploadBanner] Token lookup result:', tokenEntry ? `✓ Found for email: ${tokenEntry.email}` : '❌ Not found');
    
    if (!tokenEntry) {
      console.error('[uploadBanner] ❌ Invalid verification token');
      return res.status(401).json({ success: false, error: 'Invalid verification token' });
    }
    
    if (new Date() > tokenEntry.expires) {
      console.error('[uploadBanner] ❌ Verification token expired');
      return res.status(401).json({ success: false, error: 'Verification token expired' });
    }
    
    const normalizedEmail = tokenEntry.email.trim().toLowerCase();
    console.log('[uploadBanner] ✓ Token valid, normalized email:', normalizedEmail);
    
    const user = await User.findOne({ email: normalizedEmail });
    console.log('[uploadBanner] User lookup result:', user ? `✓ Found user: ${user.email}` : `❌ Not found for email: ${normalizedEmail}`);
    
    if (!user) {
      console.error('[uploadBanner] ❌ User not found with email:', normalizedEmail);
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    console.log('[uploadBanner] ✓ User found:', user._id, user.email);
    
    // Construct the image URL path
    const imageUrl = `/uploads/banners/${req.file.filename}`;
    console.log('[uploadBanner] Setting profileBanner to:', imageUrl);
    user.profileBanner = imageUrl;
    console.log('[uploadBanner] profileBanner property set, about to save...');
    
    const savedUser = await user.save();
    
    console.log('[uploadBanner] ✓ User saved successfully');
    console.log('[uploadBanner] savedUser.profileBanner:', savedUser.profileBanner);
    console.log('=== [uploadBanner] SUCCESS ===\n');
    
    res.json({ success: true, profileBanner: savedUser.profileBanner });
  } catch (err) {
    console.error('=== [uploadBanner] EXCEPTION ===');
    console.error('[uploadBanner] Error name:', err.name);
    console.error('[uploadBanner] Error message:', err.message);
    console.error('[uploadBanner] Error stack:', err.stack);
    console.error('=== [uploadBanner] FAILED ===\n');
    res.status(500).json({ success: false, error: 'Failed to upload banner', details: err.message });
  }
}