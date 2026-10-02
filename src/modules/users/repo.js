/**
 * The only place that reads and writes users for sign-up and login. Returns
 * plain objects; takes every time as epoch milliseconds or a Date.
 *
 * The `users` collection is shared with the admin panel and with the old API.
 * New accounts store `email` already normalised (trimmed, lowercase), so the
 * unique index on `email` covers duplicates. Older accounts may have a mixed-case
 * `email`, so an address is looked up through a case-insensitive index (see
 * models/User.js), which finds both.
 */
const User = require('../../../models/User');
const LoginAttempt = require('../../../models/LoginAttempt');

const DUPLICATE_KEY = 11000;
// Must be the collation of the `email_case_insensitive` index, or the lookup cannot use it.
const CASE_INSENSITIVE = Object.freeze({ locale: 'en', strength: 2 });
// How many times an upsert that lost a race for the same new document is repeated.
const UPSERT_TRIES = 3;

/**
 * The user whose email is this normalised address, or null: one indexed lookup that ignores case,
 * so an older user whose stored email differs from the normalised one only in case is found too.
 * (One query whether or not the address exists, so the answer does not take longer for one than the other.)
 *
 * If two older accounts differ only in case ("Ann@x.com" and "ann@x.com"; the old API made emails
 * lowercase, so this needs an import or an edit by hand) the OLDEST wins, by `createdAt` and then `_id`,
 * so the answer is always the same one. The other can no longer sign in through v1; see "Database notes"
 * in docs/ONBOARDING.md for the query that finds such pairs before the first deploy.
 * @param {string} email normalised (see lib/destination.js)
 */
function findByEmail(email) {
  return User.findOne({ email }).collation(CASE_INSENSITIVE).sort({ createdAt: 1, _id: 1 }).lean();
}

/**
 * Create a user. Resolves null instead of throwing when the email is taken.
 * @returns {Promise<object | null>}
 */
async function create(doc) {
  try {
    return (await User.create(doc)).toObject();
  } catch (err) {
    if (err && err.code === DUPLICATE_KEY) return null;
    throw err;
  }
}

/**
 * The two update stages that count one password attempt (see `countLoginAttempt`), written once so a real
 * account and an unknown email are counted by exactly the same rules.
 * One window: it starts at the first attempt and lasts `windowMs`. When the count reaches `maxAttempts`
 * the lock lasts until `lockMs` after that attempt. A lock that is in force leaves the counters alone.
 */
function attemptStages({ at, windowMs, maxAttempts, lockMs }) {
  const now = new Date(at);
  const windowStart = new Date(at - windowMs);
  const lockUntil = new Date(at + lockMs);
  // `$gt` with a missing or null field is false: a user who never failed is "not in a window".
  const locked = { $gt: ['$loginLockedUntil', now] };
  const inWindow = { $gt: ['$loginFailedSince', windowStart] };
  const count = { $ifNull: ['$loginFailedCount', 0] };
  return [
    {
      $set: {
        loginFailedCount: { $cond: [locked, count, { $cond: [inWindow, { $add: [count, 1] }, 1] }] },
        loginFailedSince: { $cond: [locked, '$loginFailedSince', { $cond: [inWindow, '$loginFailedSince', now] }] },
      },
    },
    {
      $set: {
        loginLockedUntil: {
          $cond: [{ $and: [{ $not: [locked] }, { $gte: ['$loginFailedCount', maxAttempts] }] }, lockUntil, '$loginLockedUntil'],
        },
      },
    },
  ];
}

const BEFORE_FIELDS = Object.freeze({ loginFailedCount: 1, loginFailedSince: 1, loginLockedUntil: 1 });

/**
 * Count one password attempt, atomically, and say what the user's lock looked like just before it
 * (`returnDocument: 'before'`). The attempt is counted before the password is checked, so however many
 * guesses arrive at the same moment, no more than `maxAttempts` of them get as far as being checked.
 * @param {string} userId
 * @param {{at: number, windowMs: number, maxAttempts: number, lockMs: number}} rules `at` is epoch ms
 * @returns {Promise<{loginFailedCount?: number, loginFailedSince?: Date | null, loginLockedUntil?: Date | null} | null>}
 *   null when there is no such user
 */
function countLoginAttempt(userId, rules) {
  return User.findOneAndUpdate(
    { _id: userId },
    attemptStages(rules),
    { returnDocument: 'before', updatePipeline: true, projection: BEFORE_FIELDS },
  ).lean();
}

/**
 * The same as `countLoginAttempt` for an email that has no account, kept in a small collection that
 * cleans itself up (`login_attempts`), under `key`, a hash of the normalised email. Nothing is written to a user.
 * @param {string} key
 * @param {{at: number, windowMs: number, maxAttempts: number, lockMs: number}} rules
 * @returns {Promise<{loginFailedCount?: number, loginFailedSince?: Date | null, loginLockedUntil?: Date | null}>}
 *   what the counters were before; empty for the first attempt
 */
async function countUnknownLoginAttempt(key, rules) {
  // The stored record is deleted once nothing it says can matter: after the lock and the window.
  const purgeAt = new Date(rules.at + rules.lockMs + rules.windowMs);
  const stages = [...attemptStages(rules), { $set: { purgeAt: { $max: [{ $ifNull: ['$purgeAt', new Date(0)] }, purgeAt] } } }];
  for (let attempt = 1; ; attempt += 1) {
    try {
      const before = await LoginAttempt.findOneAndUpdate(
        { _id: key },
        stages,
        { returnDocument: 'before', upsert: true, updatePipeline: true, projection: BEFORE_FIELDS },
      ).lean();
      return before || {};
    } catch (err) {
      // Two first attempts at once: one of the upserts loses the race to create the record. Count again.
      if (!err || err.code !== DUPLICATE_KEY || attempt >= UPSERT_TRIES) throw err;
    }
  }
}

/** Forget the failed attempts and any lock (after a good password). */
async function resetLoginAttempts(userId) {
  await User.updateOne(
    { _id: userId },
    { $set: { loginFailedCount: 0, loginFailedSince: null, loginLockedUntil: null } },
  );
}

/**
 * Store a new password hash, but only if the stored one is still `oldHash`, so a password
 * changed in the meantime is never overwritten by an upgrade of the old one.
 * @returns {Promise<boolean>}
 */
async function replacePasswordHash(userId, { oldHash, newHash, algo, at }) {
  const result = await User.updateOne(
    { _id: userId, password: oldHash },
    { $set: { password: newHash, passwordAlgo: algo, updatedAt: new Date(at) } },
  );
  return result.modifiedCount === 1;
}

module.exports = { findByEmail, create, countLoginAttempt, countUnknownLoginAttempt, resetLoginAttempts, replacePasswordHash };
