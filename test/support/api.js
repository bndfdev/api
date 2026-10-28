/**
 * Helpers for tests that call the HTTP API with a signed-in user. Needs a
 * database: require this file only from tests that call `db.connect`.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const User = require('../../models/User');
const sessionService = require('../../src/modules/sessions/service');

// The headers every /v1 request carries (docs/api/components/parameters.yaml).
const CLIENT = Object.freeze({
  'X-Client-Platform': 'ios',
  'X-Client-Version': '1.4.0',
  'X-Installation-Id': '3f2b8c1e-9d4a-4b6e-8f10-1a2b3c4d5e6f',
});

const DEVICE = Object.freeze({ platform: 'ios', model: 'iPhone 16', appVersion: '1.4.0+42' });

/** A user straight in the database (sign-up does not exist yet). */
async function makeUser(extra = {}) {
  return User.create({ email: `${crypto.randomUUID()}@example.com`, password: 'x', ...extra });
}

/**
 * Sign a user in on a fresh install through the session service.
 * @returns {Promise<{user: object, installationId: string, pair: object, session: object, headers: object}>}
 *   `headers` are the client headers for this install plus its access token.
 */
async function signIn(user, { installationId = crypto.randomUUID(), signInMethod = 'password', device = DEVICE } = {}) {
  const { tokens: pair, session } = await sessionService.createSession({
    userId: String(user._id), signInMethod, device, installationId,
  });
  return {
    user,
    installationId,
    pair,
    session,
    headers: { ...CLIENT, 'X-Installation-Id': installationId, Authorization: `Bearer ${pair.accessToken}` },
  };
}

/** The response is an RFC 9457 problem with this status and code, tied to its request. */
function assertProblem(res, status, code) {
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status} ${res.text}`);
  assert.match(res.headers['content-type'], /^application\/problem\+json/);
  assert.equal(res.body.code, code);
  assert.equal(res.body.status, status);
  assert.equal(res.body.requestId, res.headers['x-request-id']);
}

module.exports = { CLIENT, DEVICE, makeUser, signIn, assertProblem };
