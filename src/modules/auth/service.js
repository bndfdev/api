/**
 * Email sign-up and login (docs/api/paths/auth.yaml: checkEmailAvailability,
 * startEmailSignup, getChallenge, resendChallenge, verifyChallenge,
 * completeSignup, login). The rules only: no HTTP, and no database access of
 * its own. It works through the users, challenges, sign-up token and session
 * modules, and the clock, password hashing and logger are injected.
 *
 * Sign-up is four steps, none of which creates anything in `users` until the last:
 *   1. startEmailSignup   sends a 6-digit code to the address (a "challenge");
 *   2. verifyChallenge    checks the code and hands back a one-time `signupToken`;
 *   3. completeSignup     takes the token and a password, creates the account and signs in.
 * (checkEmailAvailability is the optional "is this address free?" check before step 1.)
 *
 * Password reset is three steps, mirroring sign-up:
 *   1. startPasswordReset     sends a 6-digit code, but only if the email has an account with a password
 *                             (otherwise a decoy: the same answer and timing, nothing sent, no code works);
 *   2. verifyChallenge        checks the code and hands back a one-time `resetToken`;
 *   3. completePasswordReset  sets the new password, signs out every device and signs in this one.
 *
 * Guests (startGuestSession): one limited account per app install, with a date of birth. Completing
 * sign-up with a guest's access token moves its date of birth and language to the new account, ends the
 * guest's sessions and deletes the guest.
 *
 * A phone code (sent by the phone module) is checked here too, with its owner's access token; a correct
 * one makes the number the account's verified number.
 *
 * Social login is not here yet.
 *
 * Numbers come from docs/api (the spec): the login lockout from `login` ("5 failures in 15 minutes
 * lock password login for 15 minutes"), the password policy from `Password`.
 */
const { logger: defaultLogger } = require('../../lib/logger');
const { ApiError } = require('../../lib/problem');
const { sha256 } = require('../../lib/secrets');
const { normalizeEmail, validateDestination } = require('../../lib/destination');
const { suggestEmail } = require('../../lib/emailSuggestion');
const defaultPasswords = require('../../lib/passwords');
const { iso } = require('../../lib/time');
const { createChallengeService } = require('../challenges/service');
const { createSignupTokenService } = require('../signupTokens/service');
const { createResetTokenService } = require('../resetTokens/service');
const { createEmailProvider } = require('../../providers/email');
const defaultSessions = require('../sessions/service');
const defaultUsers = require('../users/repo');
const { toUserResponse, toGuestResponse, isSuspended } = require('../users/service');
const defaultGuests = require('../guests/repo');
const { checkDateOfBirth } = require('../../lib/dateOfBirth');
const { createPhoneService } = require('../phone/service');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The login lockout, from the spec's description of `login`. */
const LOGIN_RULES = Object.freeze({
  maxAttempts: 5,
  windowMs: 15 * MINUTE,
  lockMs: 15 * MINUTE,
});

// ---------------------------------------------------------------------------
// Problems (codes from ErrorCode in docs/api/components/schemas.yaml)
// ---------------------------------------------------------------------------

const emailTaken = () => new ApiError({
  status: 409, code: 'EMAIL_TAKEN', title: 'Email already registered',
  detail: 'An account already uses this email. Try signing in instead.',
});
const emailInvalid = () => new ApiError({
  status: 422, code: 'EMAIL_INVALID', title: 'Email address invalid', detail: 'Enter a valid email address.',
  errors: [{ field: '/email', code: 'EMAIL_INVALID', message: 'Enter a valid email address.' }],
});
const invalidCredentials = () => new ApiError({
  status: 401, code: 'INVALID_CREDENTIALS', title: 'Email or password is incorrect',
  detail: 'Check your email and password and try again.',
});
const accountLocked = (retryAfterSeconds) => new ApiError({
  status: 423, code: 'ACCOUNT_LOCKED', title: 'Too many attempts',
  detail: `Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minutes, or reset your password.`,
  retryAfterSeconds,
});
const accountSuspended = () => new ApiError({
  status: 403, code: 'ACCOUNT_SUSPENDED', title: 'Account suspended',
});
const challengeNotFound = () => new ApiError({
  status: 404, code: 'CHALLENGE_NOT_FOUND', title: 'Code not found',
  detail: 'This code request does not exist. Start again.',
});
const passwordReused = () => new ApiError({
  status: 422, code: 'VALIDATION_FAILED', title: 'Some details need fixing',
  errors: [{ field: '/newPassword', code: 'PASSWORD_REUSED', message: 'Choose a password you have not used for this account.' }],
});
const deviceMismatch = () => new ApiError({
  status: 422, code: 'VALIDATION_FAILED', title: 'Some details need fixing',
  errors: [{ field: '/device/installationId', code: 'VALIDATION_FAILED', message: 'This must be the same as the X-Installation-Id header.' }],
});

/** The parts of `DeviceInfo` that a session keeps (for the session list). */
function sessionDevice(device) {
  const kept = {};
  for (const key of ['platform', 'model', 'appVersion']) {
    if (device[key] !== undefined) kept[key] = device[key];
  }
  return kept;
}

/** The install is named twice, in the header and in the body; they must be the same install. */
function assertSameInstall(device, installationId) {
  if (String(device.installationId).toLowerCase() !== String(installationId).toLowerCase()) throw deviceMismatch();
}

/**
 * @param {{now?: () => number, users?: object, guests?: object, challenges?: object, phone?: object, signupTokens?: object,
 *   resetTokens?: object, sessions?: object, passwords?: object, emailProvider?: object, logger?: object}} [deps]
 *   `now` returns epoch ms and is shared with the challenge and sign-up token services unless those are given.
 *   `users` is the users repo; `sessions` needs `createSession`; `passwords` is lib/passwords.js.
 */
function createAuthService({
  now = Date.now,
  users = defaultUsers,
  guests = defaultGuests,
  challenges = createChallengeService({ now }),
  phone = createPhoneService({ challenges, now }),
  signupTokens = createSignupTokenService({ now }),
  resetTokens = createResetTokenService({ now }),
  sessions = defaultSessions,
  passwords = defaultPasswords,
  emailProvider,
  logger = defaultLogger,
} = {}) {
  // Account notices (no code) go through the email provider; built on first use, like the challenge service's.
  let mailer = emailProvider;
  const notices = () => (mailer ??= createEmailProvider());

  /** Start a session for the user and build the `Session` response. */
  async function signIn({ user, device, installationId, isNewUser, signInMethod = 'password' }) {
    const { tokens, session } = await sessions.createSession({
      userId: String(user._id),
      signInMethod,
      device: sessionDevice(device),
      installationId,
    });
    return { tokens, session, user: toUserResponse(user), isNewUser };
  }

  // -------------------------------------------------------------------------
  // Sign-up
  // -------------------------------------------------------------------------

  /**
   * Whether an address can be used to sign up. This tells anyone who asks whether an address has an
   * account; the route limits it hard (see x-rate-limit), and the app may skip it (startEmailSignup answers EMAIL_TAKEN too).
   * @param {{email: string}} input
   * @returns {Promise<object>} `EmailAvailability`
   */
  async function checkEmailAvailability({ email }) {
    const normalised = validateDestination('email', email);
    if (normalised === null) throw emailInvalid();
    const existing = await users.findByEmail(normalised);
    return { email: normalised, available: !existing, suggestion: suggestEmail(normalised) };
  }

  /**
   * Send a sign-up code. Asking again from the same install while a usable code exists returns that
   * challenge and sends nothing. Nothing is created in `users`.
   * @param {{email: string, installationId: string}} input
   * @returns {Promise<object>} `Challenge`
   */
  async function startEmailSignup({ email, installationId }) {
    const normalised = validateDestination('email', email);
    if (normalised === null) throw emailInvalid();
    if (await users.findByEmail(normalised)) throw emailTaken();
    return challenges.start({ purpose: 'signup_email', channel: 'email', destination: normalised, installationId });
  }

  /** @returns {Promise<object>} `Challenge` */
  function getChallenge({ challengeId, installationId, userId }) {
    return challenges.get({ challengeId, installationId, userId });
  }

  /** @returns {Promise<object>} `Challenge` */
  function resendChallenge({ challengeId, installationId, userId }) {
    return challenges.resend({ challengeId, installationId, userId });
  }

  /**
   * Check a code. A correct code uses the challenge up and returns what it unlocks:
   * - sign-up: the one-time sign-up token;
   * - password reset: the one-time reset token (a decoy challenge never gets here: no code matches it);
   * - phone: the number becomes the account's verified number (`PhoneVerified`). Only the owner's token
   *   reaches a phone challenge: for anyone else it "does not exist".
   * @param {{challengeId: string, code: string, installationId: string, userId?: string}} input
   * @returns {Promise<object>} `ChallengeVerification`
   */
  async function verifyChallenge({ challengeId, code, installationId, userId }) {
    const verified = await challenges.verify({
      challengeId, code, installationId, userId, allowedPurposes: ['signup_email', 'password_reset', 'phone_verification'],
    });
    // Every purpose allowed above is handled here; a new purpose must be added here before it is added to that list.
    if (verified.purpose === 'signup_email') {
      const { signupToken, expiresAt } = await issueOrGiveBack(verified, () => signupTokens.issue({ email: verified.destination, installationId }));
      return { purpose: 'signup_email', email: verified.destination, signupToken, signupTokenExpiresAt: iso(expiresAt) };
    }
    if (verified.purpose === 'password_reset') {
      const { resetToken, expiresAt } = await issueOrGiveBack(verified, async () => {
        // The account the code was sent to. One that has gone since gets nothing: a code that "does not exist" any more.
        const user = await users.findByEmail(verified.destination);
        if (!user) throw challengeNotFound();
        return resetTokens.issue({ userId: String(user._id), installationId });
      });
      return { purpose: 'password_reset', resetToken, resetTokenExpiresAt: iso(expiresAt) };
    }
    if (verified.purpose === 'phone_verification') {
      return issueOrGiveBack(verified, () => phone.applyVerified({ userId: verified.userId, phoneNumber: verified.destination }));
    }
    throw challengeNotFound();
  }

  /**
   * Hand out what a verified code unlocks. If that fails, give the code back, so the user can enter it again
   * (a correct code must never be lost to a failure on our side).
   */
  async function issueOrGiveBack(verified, issue) {
    try {
      return await issue();
    } catch (err) {
      await challenges.reopen({ challengeId: verified.challenge.id, verifiedAt: verified.verifiedAt })
        .catch((reopenErr) => logger.warn({ err: reopenErr && reopenErr.name }, 'could not give a verified code back'));
      throw err;
    }
  }

  /**
   * Create the account for a verified email and sign in. The password is checked first, so a weak one
   * can be fixed and sent again with the same token. The token works once.
   * With a guest's access token (`auth.accountType === 'guest'`) the guest becomes the account: its date of
   * birth and language move over (a language in the request wins), then its sessions end and the guest is deleted.
   * TODO(profile and onboarding PR): interests and consents move over too, once they are stored.
   * TODO(config PR): LANGUAGE_UNSUPPORTED once GET /config serves the supported languages (the tag's format is already checked).
   * @param {{signupToken: string, password: string, device: object, preferredLanguage?: string, installationId: string,
   *   auth?: {userId: string, accountType: string}}} input `auth` is the caller's verified access token, if any
   * @returns {Promise<object>} `Session`, with `isNewUser: true`
   */
  async function completeSignup({ signupToken, password, device, preferredLanguage, installationId, auth }) {
    assertSameInstall(device, installationId);
    const unmet = passwords.unmetRules(password);
    if (unmet.length > 0) throw passwords.policyViolation(unmet);

    const { email, tokenHash } = await signupTokens.consume({ signupToken, installationId });
    // A guest whose account has since been deleted simply signs up from scratch.
    const guest = auth && auth.accountType === 'guest' ? await guests.findById(auth.userId) : null;
    const language = preferredLanguage || (guest && guest.preferredLanguage);
    let user;
    try {
      // Someone may have signed up with this address since the code was sent.
      if (await users.findByEmail(email)) throw emailTaken();
      const at = now();
      user = await users.create({
        email,
        emailVerified: true,
        password: await passwords.hash(password),
        passwordAlgo: 'argon2id',
        ...(language ? { preferredLanguage: language } : {}),
        ...(guest ? { dateOfBirth: guest.dateOfBirth } : {}),
        createdAt: new Date(at),
        updatedAt: new Date(at),
      });
      // Two requests for the same address at once: the unique index lets only one create it.
      if (!user) throw emailTaken();
    } catch (err) {
      // A failure that is not the client's fault gives the token back, so the same request can be repeated.
      if (!(err instanceof ApiError)) {
        await signupTokens.release(tokenHash).catch((releaseErr) => logger.warn({ err: releaseErr.name }, 'could not give a sign-up token back'));
      }
      throw err;
    }
    if (guest) {
      // The guest is now this account. A failure here leaves a guest behind, which expires on its own.
      try {
        await sessions.revokeAllSessions({ userId: String(guest._id), reason: 'guest_upgraded' });
        await guests.remove(guest._id);
      } catch (err) {
        logger.warn({ err: err && err.name }, 'could not retire the upgraded guest');
      }
    }
    return signIn({ user, device, installationId, isNewUser: true });
  }

  // -------------------------------------------------------------------------
  // Guests
  // -------------------------------------------------------------------------

  /**
   * Continue as a guest. The same install always gets the same guest back (`created: false`, answered 200)
   * instead of a new one (201). The date of birth is required (Figma) and checked against the minimum age on
   * the person's local date (`device.timeZone`).
   * TODO(config PR): FORBIDDEN when guest mode is switched off in GET /config, and LANGUAGE_UNSUPPORTED.
   * @param {{device: object, dateOfBirth: string, preferredLanguage?: string, installationId: string}} input
   * @returns {Promise<{session: object, created: boolean}>} `session` is the spec's `Session`
   */
  async function startGuestSession({ device, dateOfBirth, preferredLanguage, installationId }) {
    assertSameInstall(device, installationId);
    const at = now();
    const checked = checkDateOfBirth(dateOfBirth, { at, timeZone: device.timeZone });

    let guest = await guests.findByInstallation(installationId);
    let created = false;
    if (!guest) {
      guest = await guests.create({ installationId, dateOfBirth: checked, preferredLanguage, at });
      created = guest !== null;
      // Two first requests at once: the other one created it.
      if (!guest) guest = await guests.findByInstallation(installationId);
      if (!guest) throw new Error('Could not create or find the guest for this install');
    } else {
      guest = (await guests.touch(guest._id, at)) || guest;
    }

    const { tokens, session } = await sessions.createSession({
      userId: String(guest._id),
      signInMethod: 'guest',
      device: sessionDevice(device),
      installationId,
      accountType: 'guest',
    });
    return { session: { tokens, session, user: toGuestResponse(guest), isNewUser: created }, created };
  }

  // -------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------

  /**
   * Send a password-reset code. The answer is always a `Challenge` (202), whether or not the address has
   * an account, so it cannot be used to find accounts. A code is only really sent to an account that has a
   * password and is not blocked; for anything else the challenge is a decoy (no message, no code matches it,
   * same limits and about the same time). An account without a password (social-only) would get an email
   * explaining how it signs in: TODO(social login PR).
   * @param {{email: string, installationId: string}} input
   * @returns {Promise<object>} `Challenge`
   */
  async function startPasswordReset({ email, installationId }) {
    const normalised = validateDestination('email', email);
    if (normalised === null) throw emailInvalid();
    const user = await users.findByEmail(normalised);
    const deliver = user !== null && passwords.identify(user.password) !== null && !isSuspended(user, now());
    return challenges.start({ purpose: 'password_reset', channel: 'email', destination: normalised, installationId, deliver });
  }

  /**
   * Set a new password with the reset token, then sign out every device (whoever knew the old password)
   * and sign in this one. Clears the password-login lock. The new password must meet the policy and
   * differ from the current one; either problem leaves the token usable, so the user can try again.
   * The account owner gets a "your password was changed" email (best effort).
   * @param {{resetToken: string, newPassword: string, device: object, installationId: string}} input
   * @returns {Promise<object>} `Session`, with `isNewUser: false`
   */
  async function completePasswordReset({ resetToken, newPassword, device, installationId }) {
    assertSameInstall(device, installationId);
    const unmet = passwords.unmetRules(newPassword);
    if (unmet.length > 0) throw passwords.policyViolation(unmet, '/newPassword');

    const { userId, tokenHash } = await resetTokens.consume({ resetToken, installationId });
    const at = now();
    let user;
    try {
      user = await users.findById(userId);
      // Gone, or blocked since the code was sent: the token no longer leads anywhere.
      if (!user || isSuspended(user, at)) throw resetTokens.tokenInvalid();
      if (passwords.identify(user.password) !== null && await passwords.verify(user.password, newPassword)) throw passwordReused();
      if (!await users.setPassword(userId, { hash: await passwords.hash(newPassword), algo: 'argon2id', at })) {
        throw resetTokens.tokenInvalid();
      }
    } catch (err) {
      // The same password again, or a failure that is not the client's fault: the token keeps working.
      const retryable = !(err instanceof ApiError) || err.errors?.[0]?.code === 'PASSWORD_REUSED';
      if (retryable) {
        await resetTokens.release(tokenHash).catch((releaseErr) => logger.warn({ err: releaseErr.name }, 'could not give a reset token back'));
      }
      throw err;
    }

    await sessions.revokeAllSessions({ userId, reason: 'password_reset' });
    const session = await signIn({ user, device, installationId, isNewUser: false, signInMethod: 'password_reset' });
    if (typeof user.email === 'string' && user.email !== '') {
      await notices().sendNotice({ to: normalizeEmail(user.email), notice: 'password_changed' })
        .catch((err) => logger.warn({ err: err && (err.code || err.name) }, 'password-changed email failed'));
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  /** After a good login: store a fresh argon2id hash if the stored one is old. Never fails the login. */
  async function upgradePasswordHash({ user, password, at }) {
    try {
      if (passwords.needsRehash(user.password)) {
        const newHash = await passwords.hash(password);
        await users.replacePasswordHash(user._id, { oldHash: user.password, newHash, algo: 'argon2id', at });
      }
    } catch (err) {
      logger.warn({ err: err && err.name, userId: String(user._id) }, 'could not upgrade stored credentials');
    }
  }

  /**
   * Sign in with email and password.
   *
   * - An unknown email and a wrong password give the same INVALID_CREDENTIALS and take about as long
   *   (a password is checked against a dummy hash when there is no real hash to check against: no account,
   *   or an account that has no password hash this API can read).
   * - Every attempt is counted before the password is checked. The fifth attempt in 15 minutes that fails locks
   *   password login for 15 minutes (ACCOUNT_LOCKED with the time left); while locked, even the right password is refused.
   *   A completed password reset clears the lock.
   *   An email with no account is counted and locked in exactly the same way (kept in `login_attempts`, under a hash
   *   of the address), so the answers to the first six attempts are identical whether or not the account exists.
   * - An account an admin blocked is told ACCOUNT_SUSPENDED only after the password was right, so it tells
   *   nobody that the address has an account.
   * - Older bcrypt passwords work, and are replaced by an argon2id hash after a good login.
   * TODO(account deletion): signing in while pending_deletion cancels the deletion.
   * @param {{email: string, password: string, device: object, installationId: string}} input
   * @returns {Promise<object>} `Session`, with `isNewUser: false`
   */
  async function login({ email, password, device, installationId }) {
    assertSameInstall(device, installationId);
    const normalised = normalizeEmail(email);
    const found = await users.findByEmail(normalised);
    const at = now();
    // Count the attempt first. An account that disappeared in between counts as no account.
    let counted = found ? await users.countLoginAttempt(String(found._id), { at, ...LOGIN_RULES }) : null;
    const user = counted ? found : null;
    if (!user) counted = await users.countUnknownLoginAttempt(sha256(normalised), { at, ...LOGIN_RULES });

    const lockedUntil = counted.loginLockedUntil ? new Date(counted.loginLockedUntil).getTime() : 0;
    if (lockedUntil > at) throw accountLocked(Math.ceil((lockedUntil - at) / SECOND));
    const inWindow = counted.loginFailedSince && new Date(counted.loginFailedSince).getTime() > at - LOGIN_RULES.windowMs;
    const attempt = (inWindow ? (counted.loginFailedCount || 0) : 0) + 1;

    // Always one real hash check, so no case is faster than another.
    const usable = user !== null && passwords.identify(user.password) !== null;
    const matches = await passwords.verify(usable ? user.password : await passwords.dummyHash(), password);
    if (!usable || !matches) {
      // This attempt reached the limit, so the account is now locked (the counting step set the lock).
      if (attempt >= LOGIN_RULES.maxAttempts) throw accountLocked(LOGIN_RULES.lockMs / SECOND);
      throw invalidCredentials();
    }

    await users.resetLoginAttempts(user._id);
    if (isSuspended(user, at)) throw accountSuspended();
    await upgradePasswordHash({ user, password, at });
    return signIn({ user, device, installationId, isNewUser: false });
  }

  return {
    checkEmailAvailability,
    startEmailSignup,
    getChallenge,
    resendChallenge,
    verifyChallenge,
    completeSignup,
    login,
    startPasswordReset,
    completePasswordReset,
    startGuestSession,
  };
}

module.exports = { createAuthService, LOGIN_RULES };
