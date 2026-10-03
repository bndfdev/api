/**
 * Adding or changing the account's phone number (docs/api/paths/me.yaml:
 * startPhoneVerification, removePhone; the code is checked by verifyChallenge
 * in the auth module). The rules only: no HTTP and no database access of its
 * own. It works through the users repo and the challenge service.
 *
 * - The number must be a real E.164 number of an allowed region (config
 *   PHONE_REGIONS until GET /countries says which) and of a type that can get a
 *   text: no premium-rate, shared-cost, pager, voicemail or landline numbers,
 *   and no VoIP when PHONE_REFUSE_VOIP is on.
 * - The verified number replaces the old one only once the code is accepted.
 * - A number another account has verified is PHONE_TAKEN. A number another
 *   account only typed in (the old API stored numbers before checking them) is
 *   taken from that account when this one verifies it: proof of ownership wins.
 */
const { config: defaultConfig } = require('../../config');
const { ApiError } = require('../../lib/problem');
const { parsePhone, typeAllowed } = require('../../lib/phone');
const { iso } = require('../../lib/time');
const defaultUsers = require('../users/repo');

const phoneInvalid = () => new ApiError({
  status: 422, code: 'PHONE_INVALID', title: 'Phone number invalid', detail: 'Enter a valid phone number.',
  errors: [{ field: '/phoneNumber', code: 'PHONE_INVALID', message: 'Enter a valid phone number.' }],
});
const regionUnsupported = () => new ApiError({
  status: 422, code: 'PHONE_REGION_UNSUPPORTED', title: 'Country not supported',
  detail: 'Phone numbers from this country cannot be used yet.',
  errors: [{ field: '/phoneNumber', code: 'PHONE_REGION_UNSUPPORTED', message: 'Phone numbers from this country cannot be used yet.' }],
});
const typeNotAllowed = () => new ApiError({
  status: 422, code: 'PHONE_TYPE_NOT_ALLOWED', title: 'Use a mobile number',
  detail: 'This number cannot receive text messages. Use a mobile number.',
  errors: [{ field: '/phoneNumber', code: 'PHONE_TYPE_NOT_ALLOWED', message: 'Use a mobile number.' }],
});
const phoneTaken = () => new ApiError({
  status: 409, code: 'PHONE_TAKEN', title: 'Phone number already in use',
  detail: 'Another account already uses this phone number.',
});
const alreadyVerified = () => new ApiError({
  status: 409, code: 'CONFLICT', title: 'Phone number already verified',
  detail: 'This phone number is already verified on your account.',
});

/**
 * @param {{config?: object, users?: object, challenges: object, now?: () => number}} deps
 *   `challenges` is the challenge service (the auth module's, so codes and limits are shared).
 */
function createPhoneService({ config = defaultConfig, users = defaultUsers, challenges, now = Date.now }) {
  /** The number, parsed and checked, or a 422. */
  function checkNumber(phoneNumber) {
    const parsed = parsePhone(phoneNumber);
    if (!parsed) throw phoneInvalid();
    const regions = config.phone.regions;
    if (regions.length > 0 && !regions.includes(parsed.region)) throw regionUnsupported();
    if (!typeAllowed(parsed.type, { refuseVoip: config.phone.refuseVoip })) throw typeNotAllowed();
    return parsed;
  }

  /** PHONE_TAKEN when an account other than `userId` has verified this number. */
  async function assertNotTakenByOthers(e164, userId) {
    const holder = await users.findByPhone(e164);
    if (holder && String(holder._id) !== String(userId) && holder.mobileNumberVerified === true) throw phoneTaken();
  }

  /**
   * Send an SMS code to add or change the account's number.
   * @param {{userId: string, phoneNumber: string, installationId: string}} input
   * @returns {Promise<object>} `Challenge`
   */
  async function startVerification({ userId, phoneNumber, installationId }) {
    const { e164 } = checkNumber(phoneNumber);
    const user = await users.findById(userId);
    if (!user) throw phoneInvalid(); // the session outlived its account: nothing sensible to verify
    if (user.phone === e164 && user.mobileNumberVerified === true) throw alreadyVerified();
    await assertNotTakenByOthers(e164, userId);
    return challenges.start({ purpose: 'phone_verification', channel: 'sms', destination: e164, installationId, userId: String(userId) });
  }

  /**
   * The code was right: make the number the account's verified number. Called by verifyChallenge.
   * @param {{userId: string, phoneNumber: string}} input `phoneNumber` is the challenge's (normalised) destination
   * @returns {Promise<object>} `PhoneVerified`
   */
  async function applyVerified({ userId, phoneNumber }) {
    const at = now();
    // Someone else verified it while the code was on its way.
    await assertNotTakenByOthers(phoneNumber, userId);
    await users.releaseUnverifiedPhone(phoneNumber, userId, at);
    const saved = await users.setVerifiedPhone(userId, phoneNumber, at);
    if (saved === 'taken') throw phoneTaken();
    if (saved !== 'saved') throw phoneInvalid();
    return { purpose: 'phone_verification', phoneNumber, verifiedAt: iso(Math.floor(at / 1000) * 1000) };
  }

  /** Remove the account's number (idempotent). */
  async function removePhone({ userId }) {
    await users.removePhone(userId, now());
  }

  return { startVerification, applyVerified, removePhone };
}

module.exports = { createPhoneService };
