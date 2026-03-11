// Generate a random 6-digit OTP
exports.generateOtp = function() {
  return Math.floor(100000 + Math.random() * 900000).toString();
};
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail', // or use another SMTP provider
  auth: {
    user: process.env.EMAIL_USER, // your email address
    pass: process.env.EMAIL_PASS, // your email password or app password
  },
});

exports.sendOtpEmail = async (to, otp) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to,
    subject: 'Your Bondfire OTP Code',
    text: `Your OTP code is: ${otp}\n\nThis code is valid for 10 minutes. If you did not request this, please ignore this email.`,
  };
  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Error sending OTP email:', error);
    return false;
  }
};
