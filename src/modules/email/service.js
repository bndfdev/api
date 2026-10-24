/**
 * Changing the account's email (docs/api/paths/me.yaml: startEmailChange; the code is checked by verifyChallenge
 * in the auth module, purpose `change_email`). The rules only: no HTTP and no database access of its own. It works
 * through the users repo, the challenge service and the email provider.
 *
 * - The new address is normalised like at sign-up (trimmed, lowercased, punycode domain) and compared
 *   case-insensitively, with the account's own address too (that one is 409 CONFLICT, as for phone).
 * - The code goes to the new address. The account keeps its current email until the code is accepted; the new
 *   address is not reserved meanwhile, so if another account takes it first the code gives EMAIL_TAKEN.
 * - Once accepted, the new address replaces the old one (still verified; password login uses it from then on) and
 *   the old address gets a security notice. Sessions are left alone: the spec signs nobody out here.
 * - The reauth token (X-Reauth-Token) is checked by the route, before anything here runs.
 */
const { logger: defaultLogger } = require('../../lib/logger');
const { ApiError } = require('../../lib/problem');
const { normalizeEmail, validateDestination } = require('../../lib/destination');
const { iso } = require('../../lib/time');
const { createEmailProvider } = require('../../providers/email');
const defaultUsers = require('../users/repo');

// How often the change is tried again when the email keeps being changed elsewhere at the same moment.
const MAX_SAVE_TRIES = 3;

const emailInvalid = () => new ApiError({
  status: 422, code: 'EMAIL_INVALID', title: 'Email address invalid', detail: 'Enter a valid email address.',
  errors: [{ field: '/email', code: 'EMAIL_INVALID', message: 'Enter a valid email address.' }],
});
const emailTaken = () => new ApiError({
  status: 409, code: 'EMAIL_TAKEN', title: 'Email already in use',
  detail: 'Another account already uses this email address.',
});
const alreadyYours = () => new ApiError({
  status: 409, code: 'CONFLICT', title: 'This is already your email',
  detail: 'This email address is already the one on your account.',
});
const accountGone = () => new ApiError({
  status: 401, code: 'SESSION_REVOKED', title: 'Session revoked', detail: 'Sign in again.',
  headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
});
const challengeNotFound = () => new ApiError({
  status: 404, code: 'CHALLENGE_NOT_FOUND', title: 'Code not found',
  detail: 'This code request does not exist. Start again.',
});

/** Whether two stored or typed addresses are the same address (case-insensitive, like every lookup). */
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && normalizeEmail(a) === normalizeEmail(b);

/**
 * @param {{users?: object, challenges: object, emailProvider?: object, now?: () => number, logger?: object}} deps
 *   `challenges` is a challenge service; `emailProvider` sends the notice (`sendNotice`), built on first use if not given.
 */
function createEmailChangeService({ users = defaultUsers, challenges, emailProvider, now = Date.now, logger = defaultLogger }) {
  let mailer = emailProvider;
  const notices = () => (mailer ??= createEmailProvider());

  /** EMAIL_TAKEN when an account other than `userId` has this address, in any case. */
  async function assertNotTakenByOthers(email, userId) {
    const holder = await users.findByEmail(email);
    if (holder && String(holder._id) !== String(userId)) throw emailTaken();
  }

  /**
   * Send a code to the new address.
   * @param {{userId: string, email: string, installationId: string}} input
   * @returns {Promise<object>} `Challenge`
   */
  async function startChange({ userId, email, installationId }) {
    const normalised = validateDestination('email', email);
    if (normalised === null) throw emailInvalid();
    const user = await users.findById(userId);
    if (!user) throw accountGone();
    if (sameAddress(user.email, normalised)) throw alreadyYours();
    await assertNotTakenByOthers(normalised, userId);
    return challenges.start({ purpose: 'change_email', channel: 'email', destination: normalised, installationId, userId: String(userId) });
  }

  /** "Your email was changed", to the old address. Best effort and not awaited: a slow mail server must not hold up the answer. */
  function sendNotice(oldEmail) {
    if (typeof oldEmail !== 'string' || oldEmail === '') return;
    Promise.resolve()
      .then(() => notices().sendNotice({ to: normalizeEmail(oldEmail), notice: 'email_changed' }))
      .catch((err) => logger.warn({ err: err && (err.code || err.name) }, 'email-changed notice failed'));
  }

  /**
   * The code was right: make the address the account's verified email and tell the old one. Called by verifyChallenge.
   * @param {{userId: string, email: string}} input `email` is the challenge's (normalised) destination
   * @returns {Promise<object>} `EmailChanged`
   */
  async function applyVerified({ userId, email }) {
    for (let attempt = 1; attempt <= MAX_SAVE_TRIES; attempt += 1) {
      // Someone else took it while the code was on its way.
      await assertNotTakenByOthers(email, userId);
      const user = await users.findById(userId);
      // The account has gone since: the code no longer leads anywhere.
      if (!user) throw challengeNotFound();
      const at = now();
      const changed = { purpose: 'change_email', email, verifiedAt: iso(Math.floor(at / 1000) * 1000) };
      // Already this address (a second code for it, verified from another install): nothing changes and nobody is told.
      if (sameAddress(user.email, email)) return changed;

      const saved = await users.setEmail(userId, { from: user.email, email, at });
      if (saved === 'saved') {
        sendNotice(user.email);
        return changed;
      }
      if (saved === 'taken') throw emailTaken();
      if (saved === 'missing') throw challengeNotFound();
      // 'stale': the email changed elsewhere in between; work it out again from what is stored now.
    }
    throw new Error('Could not change the email: it kept changing at the same time');
  }

  return { startChange, applyVerified };
}

module.exports = { createEmailChangeService };
