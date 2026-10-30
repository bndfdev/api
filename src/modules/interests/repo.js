/**
 * The only place that reads and writes a person's chosen interests. Returns plain objects; takes every time as
 * epoch milliseconds.
 *
 * The selection is kept on the owner's own document: `users.interests` for an account, `guest_accounts.interests`
 * for a guest (`owner.accountType`), as `[{id, addedAt}]` in the order chosen, with `interestsUpdatedAt`. It is
 * at most GET /config's `maxInterests` (100) short entries, so it never makes the document large; a guest's goes
 * when the guest is deleted, and moves with the rest of the guest at sign-up (auth service).
 */
const User = require('../../../models/User');
const GuestAccount = require('../../../models/GuestAccount');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const modelFor = (owner) => (owner.accountType === 'guest' ? GuestAccount : User);
const validId = (owner) => OBJECT_ID.test(String(owner.userId));

/**
 * The owner's selection and, for an account, its onboarding marks.
 * @param {{userId: string, accountType: string}} owner
 * @returns {Promise<{interests?: Array<{id: string, addedAt: Date}>, interestsUpdatedAt?: Date, onboardingSteps?: object} | null>}
 *   null when the account or guest does not exist
 */
function find(owner) {
  if (!validId(owner)) return Promise.resolve(null);
  return modelFor(owner).findById(owner.userId).select('interests interestsUpdatedAt onboardingSteps').lean();
}

/**
 * Replace the whole selection.
 * @param {{userId: string, accountType: string}} owner
 * @param {Array<{id: string, addedAt: Date}>} items
 * @returns {Promise<boolean>} false when the account or guest does not exist
 */
async function replace(owner, items, at) {
  if (!validId(owner)) return false;
  const result = await modelFor(owner).updateOne(
    { _id: owner.userId },
    { $set: { interests: items, interestsUpdatedAt: new Date(at) } },
  );
  return result.matchedCount === 1;
}

/**
 * Add one interest at the end, in one atomic update that also checks the limit, so two adds at once can never
 * go over it.
 * @returns {Promise<'added' | 'present' | 'full' | 'missing'>} 'present' when it was already chosen (nothing
 *   written), 'full' when the selection already holds `max`
 */
async function add(owner, id, { at, max }) {
  if (!validId(owner)) return 'missing';
  const model = modelFor(owner);
  const result = await model.updateOne(
    { _id: owner.userId, 'interests.id': { $ne: id }, $expr: { $lt: [{ $size: { $ifNull: ['$interests', []] } }, max] } },
    { $push: { interests: { id, addedAt: new Date(at) } }, $set: { interestsUpdatedAt: new Date(at) } },
  );
  if (result.matchedCount === 1) return 'added';
  const doc = await model.findById(owner.userId).select('interests').lean();
  if (!doc) return 'missing';
  return (doc.interests || []).some((item) => item.id === id) ? 'present' : 'full';
}

/**
 * Remove one interest.
 * @returns {Promise<'removed' | 'absent' | 'missing'>} 'absent' when it was not chosen (nothing written)
 */
async function remove(owner, id, at) {
  if (!validId(owner)) return 'missing';
  const model = modelFor(owner);
  const result = await model.updateOne(
    { _id: owner.userId, 'interests.id': id },
    { $pull: { interests: { id } }, $set: { interestsUpdatedAt: new Date(at) } },
  );
  if (result.matchedCount === 1) return 'removed';
  return (await model.exists({ _id: owner.userId })) ? 'absent' : 'missing';
}

module.exports = { find, replace, add, remove };
