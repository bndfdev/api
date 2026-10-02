/**
 * The only place that reads and writes challenges and the code send log.
 * Returns plain objects; takes every time as epoch milliseconds. Each
 * conditional update here is one atomic MongoDB operation, which is what makes
 * a code single-use and attempts and resends race-free.
 */
const mongoose = require('mongoose');
const Challenge = require('../../../models/Challenge');
const CodeSendLog = require('../../../models/CodeSendLog');

/** A fresh ObjectId, so the challenge id can go into the code hash before the challenge is saved. */
function newId() {
  return new mongoose.Types.ObjectId();
}

async function insertChallenge(doc) {
  return (await Challenge.create(doc)).toObject();
}

function findById(id) {
  return Challenge.findById(id).lean();
}

function deleteChallenge(id) {
  return Challenge.deleteOne({ _id: id });
}

const DUPLICATE_KEY = 11000;

/** True when an insert failed because another challenge holds the same `activeKey`. */
function isDuplicateKey(err) {
  return Boolean(err) && err.code === DUPLICATE_KEY;
}

/** The challenge that currently holds this `activeKey` (it may be expired, locked or used), or null. */
function findByActiveKey(activeKey) {
  return Challenge.findOne({ activeKey }).lean();
}

/** Free an `activeKey` held by a challenge that is no longer usable. The challenge itself stays until its TTL. */
async function releaseActiveKey(id) {
  await Challenge.updateOne({ _id: id }, { $unset: { activeKey: 1 } });
}

/**
 * Count one attempt, but only while the challenge is usable (not verified, not
 * expired, attempts left). Atomic, so at most `maxAttempts` guesses are ever
 * compared per code, however many requests arrive at once.
 * @returns {Promise<object | null>} the challenge after the increment, or null when it was not usable
 */
function registerAttempt({ id, at }) {
  return Challenge.findOneAndUpdate(
    {
      _id: id,
      verifiedAt: null,
      expiresAt: { $gt: new Date(at) },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
    },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean();
}

/**
 * Mark the challenge verified. Exactly one caller can win: it only matches an
 * unused challenge that still has the code that was checked.
 * @returns {Promise<boolean>}
 */
async function markVerified({ id, codeHash, at }) {
  const result = await Challenge.updateOne(
    { _id: id, codeHash, verifiedAt: null, expiresAt: { $gt: new Date(at) } },
    { $set: { verifiedAt: new Date(at) } },
  );
  return result.modifiedCount === 1;
}

/**
 * Undo `markVerified` (and the attempt it counted) for a verification whose follow-up failed, so the user
 * keeps the code they entered. Only the verification made at `at` is undone.
 * @returns {Promise<boolean>}
 */
async function unmarkVerified({ id, at }) {
  const result = await Challenge.updateOne(
    { _id: id, verifiedAt: new Date(at) },
    { $set: { verifiedAt: null }, $inc: { attempts: -1 } },
  );
  return result.modifiedCount === 1;
}

/**
 * Step 1 of a resend: take the right to send, and start the cooldown. Only an
 * unused, unexpired challenge whose last send is at least `cooldownMs` old can
 * be claimed, and only one of several simultaneous requests wins. The code and
 * the attempts are NOT touched: a code that has not reached the user must never
 * be checkable, and a failed send must not give anyone more guesses.
 * @returns {Promise<object | null>} the challenge as it was, or null when the claim was lost
 */
function claimResend({ id, at, cooldownMs }) {
  return Challenge.findOneAndUpdate(
    {
      _id: id,
      verifiedAt: null,
      expiresAt: { $gt: new Date(at) },
      lastSentAt: { $lte: new Date(at - cooldownMs) },
    },
    { $set: { lastSentAt: new Date(at) } },
    { returnDocument: 'before' },
  ).lean();
}

/**
 * Step 2 of a resend, after the new code was delivered: make it the code, start
 * the attempts again and move the expiry. Only the request that made the claim
 * at `at` can do it, and not if the challenge was used meanwhile.
 * @returns {Promise<boolean>}
 */
async function commitResend({ id, at, codeHash, expiresAt, purgeAt }) {
  const result = await Challenge.updateOne(
    { _id: id, verifiedAt: null, lastSentAt: new Date(at) },
    { $set: { codeHash, attempts: 0, expiresAt, purgeAt }, $inc: { sendCount: 1 } },
  );
  return result.modifiedCount === 1;
}

/**
 * Record a send and report whether it fits the limit. The window is the last
 * `windowMs` exactly: a send made precisely `windowMs` ago no longer counts.
 *
 * The row is written first, then every row in the window (including this one)
 * is counted, and the send is refused (and its row removed) if there are more
 * than `limit`. Whichever concurrent caller inserts last always sees all of the
 * others, so the limit is never exceeded, whatever the interleaving. The price
 * is that callers racing at the limit may all be refused; the caller can ask again.
 * @returns {Promise<{ok: true, id: object, sendsRemaining: number} | {ok: false, retryAfterMs: number}>}
 */
async function reserveSend({ key, purpose, challengeId, at, limit, windowMs }) {
  const entry = await CodeSendLog.create({ key, purpose, challengeId, sentAt: new Date(at) });
  const inWindow = await CodeSendLog
    .find({ key, sentAt: { $gt: new Date(at - windowMs) } })
    .sort({ sentAt: 1, _id: 1 })
    .select('sentAt')
    .lean();
  if (inWindow.length > limit) {
    await CodeSendLog.deleteOne({ _id: entry._id });
    // Without this send there are inWindow.length - 1 rows; it fits once enough of the oldest have left the window.
    const frees = inWindow[inWindow.length - 1 - limit].sentAt.getTime() + windowMs;
    return { ok: false, retryAfterMs: Math.max(0, frees - at) };
  }
  return { ok: true, id: entry._id, sendsRemaining: limit - inWindow.length };
}

/** Forget a reserved send (it was never delivered). */
async function releaseSend(id) {
  await CodeSendLog.deleteOne({ _id: id });
}

/** Sends recorded for this key inside the window. */
function countSends({ key, at, windowMs }) {
  return CodeSendLog.countDocuments({ key, sentAt: { $gt: new Date(at - windowMs) } });
}

module.exports = {
  newId,
  insertChallenge,
  findById,
  deleteChallenge,
  isDuplicateKey,
  findByActiveKey,
  releaseActiveKey,
  registerAttempt,
  markVerified,
  unmarkVerified,
  claimResend,
  commitResend,
  reserveSend,
  releaseSend,
  countSends,
};
