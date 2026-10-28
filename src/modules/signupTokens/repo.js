/**
 * The only place that reads and writes sign-up tokens. Returns plain objects;
 * takes every time as a Date. Using a token is one atomic update, which is what
 * makes it single-use.
 */
const SignupToken = require('../../../models/SignupToken');

async function insert(doc) {
  await SignupToken.create(doc);
}

function findByHash(tokenHash) {
  return SignupToken.findOne({ tokenHash }).lean();
}

/**
 * Mark an unused, unexpired token as used for this install. Exactly one caller
 * can win, however many requests arrive at once.
 * @returns {Promise<object | null>} the token as it was, or null when it could not be used
 */
function claim({ tokenHash, installationId, at }) {
  return SignupToken.findOneAndUpdate(
    { tokenHash, installationId, usedAt: null, expiresAt: { $gt: at } },
    { $set: { usedAt: at } },
    { returnDocument: 'before' },
  ).lean();
}

/** Undo `claim`, for a request that could not finish and whose token should still work. */
async function unclaim(tokenHash) {
  await SignupToken.updateOne({ tokenHash }, { $set: { usedAt: null } });
}

module.exports = { insert, findByHash, claim, unclaim };
