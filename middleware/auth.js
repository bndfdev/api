const VerificationToken = require('../models/VerificationToken');

module.exports = async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  console.log('[auth] Authorization header:', authHeader);
  console.log('[auth] Token extracted:', token);

  if (!token) {
    console.error('[auth] No token provided');
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    // Verify the token in the database
    console.log('[auth] Looking up token in database...');
    const verificationRecord = await VerificationToken.findOne({ token });
    
    console.log('[auth] Verification record found:', !!verificationRecord);
    if (!verificationRecord) {
      console.error('[auth] Invalid or expired token:', token);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Check if token is expired
    if (verificationRecord.expires && new Date() > new Date(verificationRecord.expires)) {
      console.error('[auth] Token has expired:', verificationRecord.expires);
      return res.status(403).json({ error: 'Token has expired' });
    }

    // Token is valid, attach user email to request
    console.log('[auth] Token valid for email:', verificationRecord.email);
    req.user = { email: verificationRecord.email };
    req.userToken = verificationRecord;
    next();
  } catch (err) {
    console.error('[authenticateToken] Error:', err.message);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};
