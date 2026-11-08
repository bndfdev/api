const { config } = require('../src/config');
const { createEmailProvider } = require('../src/providers/email');

// Generate a random 6-digit OTP
exports.generateOtp = function() {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const emailProvider = createEmailProvider({ config });

exports.sendOtpEmail = async (to, otp) => {
  try {
    await emailProvider.send({
      to,
      purpose: 'signup_email',
      code: otp,
      expiresInMinutes: 10,
    });
    return true;
  } catch {
    console.error('Error sending OTP email');
    return false;
  }
};
