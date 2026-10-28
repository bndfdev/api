/**
 * The only place that reads and writes idempotency records.
 * Takes every date as input.
 *
 * Every record has an `owner`: a random value chosen by the request that holds
 * it. Completing or releasing a record needs the matching owner, so a request
 * that was taken over (see `takeOverStale`) cannot touch its successor's record.
 */
const IdempotencyKey = require('../../../models/IdempotencyKey');

const DUPLICATE_KEY = 11000;

/**
 * Reserve a key for the request about to run. The unique `lookup` lets exactly
 * one of several identical concurrent requests win.
 * @returns {Promise<boolean>} false when a record for this key already exists
 */
async function insertPending({ lookup, requestHash, owner, createdAt }) {
  try {
    await IdempotencyKey.create({ lookup, requestHash, owner, state: 'pending', createdAt });
    return true;
  } catch (err) {
    if (err && err.code === DUPLICATE_KEY) return false;
    throw err;
  }
}

function find(lookup) {
  return IdempotencyKey.findOne({ lookup }).lean();
}

/**
 * Take over a `pending` record whose request never finished (it started at or
 * before `staleBefore`): the record gets the new `owner` and its clock restarts.
 * Exactly one caller can win.
 * @returns {Promise<boolean>}
 */
async function takeOverStale({ lookup, staleBefore, owner, now }) {
  const taken = await IdempotencyKey.findOneAndUpdate(
    { lookup, state: 'pending', createdAt: { $lte: staleBefore } },
    { $set: { owner, createdAt: now } },
    { projection: { _id: 1 } },
  ).lean();
  return taken !== null;
}

/** Store the response and mark the record `done`, if `owner` still holds it. */
async function complete({ lookup, owner, status, headers, body }) {
  await IdempotencyKey.updateOne({ lookup, owner, state: 'pending' }, { $set: { state: 'done', status, headers, body } });
}

/** Drop a `pending` record so the same key can be tried again (the request failed), if `owner` still holds it. */
async function release({ lookup, owner }) {
  await IdempotencyKey.deleteOne({ lookup, owner, state: 'pending' });
}

module.exports = { insertPending, find, takeOverStale, complete, release };
