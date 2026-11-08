const { config } = require('../src/config');
const { logger } = require('../src/lib/logger');
const { createEmailProvider } = require('../src/providers/email');

// Generate a random 6-digit OTP
exports.generateOtp = function() {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const emailProvider = createEmailProvider({ config });

function maskedUser(user) {
  if (!user) return undefined;
  const [name, domain] = String(user).split('@');
  if (!domain) return '[configured]';
  return `${name.slice(0, 1)}***@${domain}`;
}

exports.sendOtpEmail = async (to, otp) => {
  try {
    await emailProvider.send({
      to,
      purpose: 'signup_email',
      code: otp,
      expiresInMinutes: 10,
    });
    return true;
  } catch (err) {
    logger.error({
      err: {
        message: err.message,
        code: err.code,
        command: err.command,
        responseCode: err.responseCode,
        response: err.response,
      },
      smtp: {
        host: config.email.smtp.host,
        port: config.email.smtp.port,
        secure: config.email.smtp.secure,
        requireTls: config.email.smtp.requireTls,
        user: maskedUser(config.email.smtp.user),
        from: config.email.smtp.from,
      },
    }, 'Error sending OTP email');
    return false;
  }
};
