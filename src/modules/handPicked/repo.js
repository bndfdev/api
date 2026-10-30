/**
 * The only place that reads and writes `users.handPicked` (models/User.js): the ids of the user's own content picked
 * for the Profile's "Hand-picked by <name>", in the order chosen. Kept on the account's own document (at most 3 ids,
 * so it never makes the document large, and it goes with the account). The items themselves are read through the
 * content module's repo, the only place that reads `contents`.
 */
const User = require('../../../models/User');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** The stored ids as strings, in order; `[]` when nothing was ever stored. */
const idsOf = (doc) => (Array.isArray(doc.handPicked) ? doc.handPicked.map(String) : []);

/**
 * The stored ids.
 * @param {string} userId
 * @returns {Promise<string[] | null>} in order; `[]` when the user never picked any; null when the account does not exist
 */
async function find(userId) {
  if (!OBJECT_ID.test(String(userId))) return null;
  const doc = await User.findById(userId).select('handPicked').lean();
  if (!doc) return null;
  return idsOf(doc);
}

/**
 * Replace the whole list in one atomic update. The model refuses more than 3 ids (a safety net behind the spec's
 * validator).
 * @param {string} userId
 * @param {string[]} ids content ids in the order to show, already checked (the user's own, no repeats); `[]` clears it
 * @returns {Promise<string[] | null>} the stored ids after the change; null when the account does not exist
 */
async function replace(userId, ids) {
  if (!OBJECT_ID.test(String(userId))) return null;
  const doc = await User.findOneAndUpdate(
    { _id: userId },
    { $set: { handPicked: ids } },
    { projection: { handPicked: 1 }, returnDocument: 'after', runValidators: true },
  ).lean();
  if (!doc) return null;
  return idsOf(doc);
}

module.exports = { find, replace };
