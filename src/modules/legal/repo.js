/**
 * The only place that reads and writes consent records. Returns plain objects; takes times as Dates.
 */
const Consent = require('../../../models/Consent');

const DUPLICATE_KEY = 11000;

function find(userId, documentType, version) {
  return Consent.findOne({ userId, documentType, version }).lean();
}

/**
 * Record an acceptance, or return the one already there.
 * @returns {Promise<{consent: object, created: boolean}>}
 */
async function record(doc) {
  try {
    return { consent: (await Consent.create(doc)).toObject(), created: true };
  } catch (err) {
    if (!err || err.code !== DUPLICATE_KEY) throw err;
    return { consent: await find(doc.userId, doc.documentType, doc.version), created: false };
  }
}

/** The account's consents, newest first. */
function list(userId) {
  return Consent.find({ userId }).sort({ acceptedAt: -1, _id: -1 }).lean();
}

/** Move a guest's consents to the account it became. */
async function moveToAccount(guestId, userId) {
  await Consent.updateMany({ userId: guestId }, { $set: { userId, accountType: 'user' } });
}

module.exports = { find, record, list, moveToAccount };
