/**
 * Re-authentication and password change (docs/api: `reauthenticate` in paths/auth.yaml, `mePassword` in
 * paths/me.yaml). The rules only: no HTTP, and no database access of its own. It works through the users,
 * session and re-authentication token modules; the clock, password hashing, email provider and logger are injected.
 * Both are for accounts only (the routes refuse guests).
 *
 * - reauthenticate: the password again gives a 5-minute, single-use `reauthToken` for a sensitive call.
 * - changePassword: with `currentPassword`, or, for an account that has no password yet (social-only), with that
 *   token instead. Other devices are signed out unless `signOutOtherSessions` is false; this one stays signed in.
 *
 * A wrong password is 422 PASSWORD_INCORRECT, not 401, which would sign the user out. Every password attempt here
 * counts towards the same lock as login (5 failures in 15 minutes lock it for 15 minutes, 423 ACCOUNT_LOCKED),
 * so a stolen session cannot be used to guess the password faster than login allows.
 *
 * Social re-authentication ("a fresh provider credential") needs the provider checks of the social login PR;
 * until then it is refused with 422 SOCIAL_PROVIDER_UNSUPPORTED.
 */
const { logger: defaultLogger } = require('../../lib/logger');
const { ApiError } = require('../../lib/problem');
const { normalizeEmail } = require('../../lib/destination');
const defaultPasswords = require('../../lib/passwords');
const { iso } = require('../../lib/time');
const { createEmailProvider } = require('../../providers/email');
const defaultSessions = require('../sessions/service');
const defaultUsers = require('../users/repo');
const { createReauthTokenService } = require('../reauthTokens/service');
const { LOGIN_RULES, accountLocked } = require('../auth/service');

const SECOND = 1000;

// ---------------------------------------------------------------------------
// Problems (codes from ErrorCode in docs/api/components/schemas.yaml)
// ---------------------------------------------------------------------------

const passwordIncorrect = (field) => new ApiError({
  status: 422, code: 'PASSWORD_INCORRECT', title: 'Password is incorrect', detail: 'Check your password and try again.',
  errors: [{ field, code: 'PASSWORD_INCORRECT', message: 'Check your password and try again.' }],
});
const currentPasswordRequired = () => new ApiError({
  status: 422, code: 'VALIDATION_FAILED', title: 'Some details need fixing',
  errors: [{ field: '/currentPassword', code: 'VALIDATION_FAILED', message: 'Enter your current password.' }],
});
const passwordReused = () => new ApiError({
  status: 422, code: 'VALIDATION_FAILED', title: 'Some details need fixing',
  errors: [{ field: '/newPassword', code: 'PASSWORD_REUSED', message: 'Choose a password you have not used for this account.' }],
});
const socialUnsupported = () => new ApiError({
  status: 422, code: 'SOCIAL_PROVIDER_UNSUPPORTED', title: 'Sign-in method not available',
  detail: 'Confirming with Apple, Google or Facebook is not available yet.',
  errors: [{ field: '/social', code: 'SOCIAL_PROVIDER_UNSUPPORTED', message: 'Confirming with Apple, Google or Facebook is not available yet.' }],
});
// The access token's account no longer exists: the same answer requireAuth gives for a session that is gone.
const sessionRevoked = () => new ApiError({
  status: 401, code: 'SESSION_REVOKED', title: 'Session revoked', detail: 'This session was signed out. Sign in again.',
});

/**
 * @param {{now?: () => number, users?: object, sessions?: object, reauthTokens?: object, passwords?: object,
 *   emailProvider?: object, logger?: object}} [deps]
 *   `now` returns epoch ms and is shared with the re-authentication token service unless that is given.
 *   `users` is the users repo; `sessions` needs `revokeAllOtherSessions`; `passwords` is lib/passwords.js.
 */
function createCredentialsService({
  now = Date.now,
  users = defaultUsers,
  sessions = defaultSessions,
  reauthTokens = createReauthTokenService({ now }),
  passwords = defaultPasswords,
  emailProvider,
  logger = defaultLogger,
} = {}) {
  // The "password changed" notice goes through the email provider; built on first use, like the auth service's.
  let mailer = emailProvider;
  const notices = () => (mailer ??= createEmailProvider());

  async function signedInUser(userId) {
    const user = await users.findById(userId);
    if (!user) throw sessionRevoked();
    return user;
  }

  /**
   * Check the account's password, counted like a login attempt (before the check, so guesses sent at the same
   * moment cannot get past the limit). While the account is locked even the right password is refused.
   * An account with no password this API can read is checked against the dummy hash and never matches.
   * A good password clears the failed attempts, as at login.
   * @param {object} user
   * @param {string} password
   * @param {string} field JSON pointer of the password field, for PASSWORD_INCORRECT
   */
  async function checkPassword(user, password, field) {
    const at = now();
    const counted = await users.countLoginAttempt(String(user._id), { at, ...LOGIN_RULES });
    if (!counted) throw sessionRevoked();

    const lockedUntil = counted.loginLockedUntil ? new Date(counted.loginLockedUntil).getTime() : 0;
    if (lockedUntil > at) throw accountLocked(Math.ceil((lockedUntil - at) / SECOND));
    const inWindow = counted.loginFailedSince && new Date(counted.loginFailedSince).getTime() > at - LOGIN_RULES.windowMs;
    const attempt = (inWindow ? (counted.loginFailedCount || 0) : 0) + 1;

    const usable = passwords.identify(user.password) !== null;
    const matches = await passwords.verify(usable ? user.password : await passwords.dummyHash(), password);
    if (!usable || !matches) {
      // This attempt reached the limit, so the account is now locked (the counting step set the lock).
      if (attempt >= LOGIN_RULES.maxAttempts) throw accountLocked(LOGIN_RULES.lockMs / SECOND);
      throw passwordIncorrect(field);
    }
    await users.resetLoginAttempts(user._id);
  }

  /**
   * Confirm who the signed-in user is before a sensitive call: the account's password again.
   * @param {{auth: {userId: string, sessionId: string}, password?: string, social?: object}} input
   *   exactly one of `password` and `social` (the spec validator enforces it)
   * @returns {Promise<object>} `ReauthToken`
   */
  async function reauthenticate({ auth, password, social }) {
    if (social !== undefined) throw socialUnsupported();
    const user = await signedInUser(auth.userId);
    await checkPassword(user, password, '/password');
    const { reauthToken, expiresAt } = await reauthTokens.issue({ userId: String(user._id), sessionId: auth.sessionId });
    return { reauthToken, expiresAt: iso(expiresAt) };
  }

  /**
   * Change the password, or set a first one.
   * - An account that has a password must send `currentPassword` (VALIDATION_FAILED without it). The new one must
   *   meet the policy and differ from it (PASSWORD_REUSED).
   * - An account without one (social-only) omits `currentPassword` and sends a reauth token (REAUTH_REQUIRED
   *   without a usable one). A weak password does not use the token up, so the user can fix it and send again.
   * - Other devices are signed out first, unless `signOutOtherSessions` is false, so a failure in between never
   *   leaves a changed password with the old devices still signed in (and once more afterwards, for a session
   *   refreshed while the new password was being saved). This device stays signed in. The login lock is cleared.
   * - The account's email gets the "your password was changed" notice (best effort, not awaited).
   * @param {{auth: {userId: string, sessionId: string}, currentPassword?: string, newPassword: string,
   *   signOutOtherSessions?: boolean, reauthToken?: string}} input
   */
  async function changePassword({ auth, currentPassword, newPassword, signOutOtherSessions = true, reauthToken }) {
    const user = await signedInUser(auth.userId);
    const unmet = passwords.unmetRules(newPassword);
    if (unmet.length > 0) throw passwords.policyViolation(unmet, '/newPassword');

    const hasPassword = passwords.identify(user.password) !== null;
    let tokenHash = null;
    if (currentPassword !== undefined) {
      await checkPassword(user, currentPassword, '/currentPassword');
      if (await passwords.verify(user.password, newPassword)) throw passwordReused();
    } else if (hasPassword) {
      throw currentPasswordRequired();
    } else {
      ({ tokenHash } = await reauthTokens.consume({ reauthToken, userId: String(user._id), sessionId: auth.sessionId }));
    }

    const userId = String(user._id);
    const signOut = () => sessions.revokeAllOtherSessions({ userId, keepSessionId: auth.sessionId, reason: 'password_changed' });
    try {
      const hash = await passwords.hash(newPassword);
      if (signOutOtherSessions) await signOut();
      const at = now();
      if (!await users.changePassword(userId, { oldHash: user.password, hash, algo: 'argon2id', at })) {
        // The password changed since it was read: what was sent no longer proves anything.
        throw tokenHash ? currentPasswordRequired() : passwordIncorrect('/currentPassword');
      }
    } catch (err) {
      // A failure that is not the client's fault: the token keeps working, so the same request can be repeated.
      if (tokenHash && !(err instanceof ApiError)) {
        await reauthTokens.release(tokenHash).catch((releaseErr) => logger.warn({ err: releaseErr.name }, 'could not give a reauth token back'));
      }
      throw err;
    }

    if (signOutOtherSessions) {
      await signOut().catch((err) => logger.warn({ err: err && err.name }, 'could not repeat the sign-out after a password change'));
    }
    if (typeof user.email === 'string' && user.email !== '') {
      // Not awaited: a slow mail server must not hold up the answer.
      Promise.resolve()
        .then(() => notices().sendNotice({ to: normalizeEmail(user.email), notice: 'password_changed' }))
        .catch((err) => logger.warn({ err: err && (err.code || err.name) }, 'password-changed email failed'));
    }
  }

  return { reauthenticate, changePassword };
}

module.exports = { createCredentialsService };
