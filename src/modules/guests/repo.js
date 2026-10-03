/**
 * The only place that reads and writes guest accounts. Returns plain objects;
 * takes every time as epoch milliseconds or a Date.
 */
const GuestAccount = require('../../../models/GuestAccount');

const DUPLICATE_KEY = 11000;
const DAY = 24 * 60 * 60 * 1000;
/** The spec: "Guest accounts unused for 180 days are deleted." */
const GUEST_RETENTION_MS = 180 * DAY;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

function findByInstallation(installationId) {
  return GuestAccount.findOne({ installationId }).lean();
}

function findById(guestId) {
  if (!OBJECT_ID.test(String(guestId))) return Promise.resolve(null);
  return GuestAccount.findById(guestId).lean();
}

/**
 * Create the guest for an install. Resolves null when the install already has one
 * (two first requests at once: the unique index lets only one create it).
 */
async function create({ installationId, dateOfBirth, preferredLanguage, at }) {
  try {
    const doc = await GuestAccount.create({
      installationId,
      dateOfBirth,
      ...(preferredLanguage ? { preferredLanguage } : {}),
      createdAt: new Date(at),
      lastActiveAt: new Date(at),
      purgeAt: new Date(at + GUEST_RETENTION_MS),
    });
    return doc.toObject();
  } catch (err) {
    if (err && err.code === DUPLICATE_KEY) return null;
    throw err;
  }
}

/**
 * Mark the guest active now, which also pushes its deletion 180 days away.
 * @returns {Promise<object | null>} the guest, or null when it no longer exists
 */
function touch(guestId, at) {
  if (!OBJECT_ID.test(String(guestId))) return Promise.resolve(null);
  return GuestAccount.findOneAndUpdate(
    { _id: guestId },
    { $set: { lastActiveAt: new Date(at), purgeAt: new Date(at + GUEST_RETENTION_MS) } },
    { returnDocument: 'after' },
  ).lean();
}

/** Delete the guest (after it became a real account). */
async function remove(guestId) {
  await GuestAccount.deleteOne({ _id: guestId });
}

module.exports = { findByInstallation, findById, create, touch, remove, GUEST_RETENTION_MS };
