/**
 * The only place that reads and writes the notification switches. They are kept on the account's own document,
 * as `users.notificationSettings`: only the switches the user changed, plus when they last changed. Six booleans,
 * so it never makes the document large, and it goes with the account.
 */
const User = require('../../../models/User');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * The stored switches.
 * @param {string} userId
 * @returns {Promise<object | null>} `{}` when the user never saved any; null when the account does not exist
 */
async function find(userId) {
  if (!OBJECT_ID.test(String(userId))) return null;
  const doc = await User.findById(userId).select('notificationSettings').lean();
  if (!doc) return null;
  return doc.notificationSettings || {};
}

/**
 * Set some switches in one atomic update; the others keep their value.
 * @param {string} userId
 * @param {object} changes switch name to boolean
 * @param {number} at epoch ms
 * @returns {Promise<object | null>} every stored switch after the change; null when the account does not exist
 */
async function update(userId, changes, at) {
  if (!OBJECT_ID.test(String(userId))) return null;
  const set = Object.fromEntries(Object.entries(changes).map(([key, value]) => [`notificationSettings.${key}`, value]));
  set['notificationSettings.updatedAt'] = new Date(at);
  const doc = await User.findOneAndUpdate(
    { _id: userId },
    { $set: set },
    { projection: { notificationSettings: 1 }, returnDocument: 'after' },
  ).lean();
  if (!doc) return null;
  return doc.notificationSettings || {};
}

module.exports = { find, update };
