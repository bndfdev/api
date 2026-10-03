/**
 * The only place that reads and writes sessions, refresh tokens and grace
 * records (and the user's suspension flags). Returns plain objects; takes every
 * date as input.
 */
const mongoose = require('mongoose');
const Session = require('../../../models/Session');
const RefreshToken = require('../../../models/RefreshToken');
const RefreshGrace = require('../../../models/RefreshGrace');
const User = require('../../../models/User');
const guests = require('../guests/repo');

const MAX_LISTED_SESSIONS = 100;
const DUPLICATE_KEY = 11000;

/** A fresh ObjectId, so a session id can be used before the session is saved. */
function newId() {
  return new mongoose.Types.ObjectId();
}

async function insertSession(doc) {
  return (await Session.create(doc)).toObject();
}

async function insertRefreshToken(doc) {
  await RefreshToken.create(doc);
}

function findRefreshToken(tokenHash) {
  return RefreshToken.findOne({ tokenHash }).lean();
}

function findSession(sessionId) {
  return Session.findById(sessionId).lean();
}

function findUserSession(userId, sessionId) {
  return Session.findOne({ _id: sessionId, userId }).lean();
}

/**
 * Just what authentication needs to know about a session (`revokedAt`,
 * `expiresAt`), or null when the user has no such session. Looked up by _id.
 */
function findSessionState(userId, sessionId) {
  return Session.findOne({ _id: sessionId, userId }).select('revokedAt expiresAt').lean();
}

/**
 * Mark a guest active (which also pushes its deletion 180 days away).
 * @returns {Promise<object | null>} null when the guest no longer exists
 */
function touchGuest(guestId, at) {
  return guests.touch(guestId, at);
}

/** `{isBlocked, blockedUntil}` for the user, or null when there is no such user. */
function findUserBlockStatus(userId) {
  return User.findById(userId).select('isBlocked blockedUntil').lean();
}

/**
 * Reserve the grace record of a used token. The unique tokenHash lets exactly
 * one of several parallel refreshes succeed.
 * @returns {Promise<boolean>} false when a record for this token already exists
 */
async function insertGrace(doc) {
  try {
    await RefreshGrace.create(doc);
    return true;
  } catch (err) {
    if (err && err.code === DUPLICATE_KEY) return false;
    throw err;
  }
}

function findGrace(tokenHash) {
  return RefreshGrace.findOne({ tokenHash }).lean();
}

async function deleteGrace(tokenHash) {
  await RefreshGrace.deleteOne({ tokenHash });
}

/**
 * Atomically mark an unused refresh token as used and cap how long it is kept.
 * Resolves true for the one caller that wins; every concurrent caller gets false.
 */
async function claimRefreshToken({ tokenHash, usedAt, replacedByHash, retainUntil }) {
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, usedAt: null },
    { $set: { usedAt, replacedByHash }, $min: { expiresAt: retainUntil } },
    { projection: { _id: 1 } },
  ).lean();
  return claimed !== null;
}

async function deleteRefreshToken(tokenHash) {
  await RefreshToken.deleteOne({ tokenHash });
}

/** Record activity and push the expiry out. Does nothing for a revoked session. */
async function touchSession(sessionId, { lastActiveAt, expiresAt }) {
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { lastActiveAt, expiresAt } });
}

/**
 * Revoke the matching sessions that are still active. Their grace records are
 * deleted and their refresh tokens are kept only until `retainUntil`, so a
 * client that presents one still learns the session was revoked.
 * @returns {Promise<number>} how many sessions were newly revoked
 */
async function revokeSessions(filter, { reason, at, retainUntil }) {
  const active = await Session.find({ ...filter, revokedAt: null }).select('_id').lean();
  if (active.length === 0) return 0;
  const ids = active.map((s) => s._id);
  await Session.updateMany(
    { _id: { $in: ids }, revokedAt: null },
    { $set: { revokedAt: at, revokeReason: reason }, $min: { expiresAt: retainUntil } },
  );
  await Promise.all([
    RefreshToken.updateMany({ sessionId: { $in: ids } }, { $min: { expiresAt: retainUntil } }),
    RefreshGrace.deleteMany({ sessionId: { $in: ids } }),
  ]);
  return ids.length;
}

function revokeSession(sessionId, options) {
  return revokeSessions({ _id: sessionId }, options);
}

/** Revoke every active session of the user except `keepSessionId`. */
function revokeUserSessionsExcept(userId, keepSessionId, options) {
  return revokeSessions({ userId, _id: { $ne: keepSessionId } }, options);
}

/** Revoke every active session of the user. */
function revokeUserSessions(userId, options) {
  return revokeSessions({ userId }, options);
}

/**
 * Revoke the session a refresh token belongs to, if the token exists (and
 * belongs to `userId` when given).
 * @returns {Promise<number>} 1 when a session was revoked now, else 0
 */
async function revokeByRefreshTokenHash(tokenHash, { userId, ...options }) {
  const filter = { tokenHash };
  if (userId) filter.userId = userId;
  const stored = await RefreshToken.findOne(filter).select('sessionId').lean();
  return stored ? revokeSession(stored.sessionId, options) : 0;
}

/** Active sessions of the user, most recently active first. */
function listActiveSessions(userId, now) {
  return Session.find({ userId, revokedAt: null, expiresAt: { $gt: now } })
    .sort({ lastActiveAt: -1 })
    .limit(MAX_LISTED_SESSIONS)
    .lean();
}

module.exports = {
  newId,
  insertSession,
  insertRefreshToken,
  findRefreshToken,
  findSession,
  findUserSession,
  findSessionState,
  findUserBlockStatus,
  touchGuest,
  insertGrace,
  findGrace,
  deleteGrace,
  claimRefreshToken,
  deleteRefreshToken,
  touchSession,
  revokeSession,
  revokeUserSessionsExcept,
  revokeUserSessions,
  revokeByRefreshTokenHash,
  listActiveSessions,
};
