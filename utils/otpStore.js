

const Otp = require('../models/Otp');
const bcrypt = require('bcryptjs');

exports.saveOtp = async (email, otp, ttlSeconds = 300) => {
  const expires = new Date(Date.now() + ttlSeconds * 1000);
  const salt = await bcrypt.genSalt(10);
  const otpStr = otp.toString();
  const otpHash = await bcrypt.hash(otpStr, salt);
  await Otp.findOneAndUpdate(
    { email },
    { otp: otpHash, expires },
    { upsert: true, new: true }
  );
};

exports.verifyOtp = async (email, otp) => {
  const entry = await Otp.findOne({ email });
  if (!entry) return false;
  if (new Date() > entry.expires) {
    await Otp.deleteOne({ email });
    return false;
  }
  const otpStr = otp.toString();
  const valid = await bcrypt.compare(otpStr, entry.otp);
  if (valid) await Otp.deleteOne({ email });
  return valid;
};
