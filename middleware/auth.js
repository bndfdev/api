const VerificationToken = require('../models/VerificationToken');

module.exports = async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

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
      console.error('[auth] Invalid or expired token');
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Check if token is expired
    if (verificationRecord.expires && new Date() > new Date(verificationRecord.expires)) {
      console.error('[auth] Token has expired:', verificationRecord.expires);
      return res.status(403).json({ error: 'Token has expired' });
    }

    // Token is valid, attach user email to request
    console.log('[auth] Authentication successful');
    req.user = { email: verificationRecord.email };
    req.userToken = verificationRecord;
    next();
  } catch {
    console.error('[authenticateToken] Token validation failed');
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};
