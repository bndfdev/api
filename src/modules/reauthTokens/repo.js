/**
 * The only place that reads and writes re-authentication tokens. Returns plain
 * objects; takes every time as a Date. Using a token is one atomic update, which
 * is what makes it single-use.
 */
const ReauthToken = require('../../../models/ReauthToken');

async function insert(doc) {
  await ReauthToken.create(doc);
}

/**
 * Mark an unused, unexpired token of this user's session as used. Exactly one
 * caller can win, however many requests arrive at once.
 * @returns {Promise<object | null>} the token as it was, or null when it could not be used
 */
function claim({ tokenHash, userId, sessionId, at }) {
  return ReauthToken.findOneAndUpdate(
    { tokenHash, userId, sessionId, usedAt: null, expiresAt: { $gt: at } },
    { $set: { usedAt: at } },
    { returnDocument: 'before' },
  ).lean();
}

/** Undo `claim`, for a request that could not finish and whose token should still work. */
async function unclaim(tokenHash) {
  await ReauthToken.updateOne({ tokenHash }, { $set: { usedAt: null } });
}

module.exports = { insert, claim, unclaim };
