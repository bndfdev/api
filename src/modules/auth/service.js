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
 * Password reset, guest sessions, phone verification and social login are not here yet:
 * a challenge for any purpose but `signup_email` cannot be verified through this service.
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
const defaultSessions = require('../sessions/service');
const defaultUsers = require('../users/repo');
const { toUserResponse, isSuspended } = require('../users/service');

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
 * @param {{now?: () => number, users?: object, challenges?: object, signupTokens?: object,
 *   sessions?: object, passwords?: object, logger?: object}} [deps]
 *   `now` returns epoch ms and is shared with the challenge and sign-up token services unless those are given.
 *   `users` is the users repo; `sessions` needs `createSession`; `passwords` is lib/passwords.js.
 */
function createAuthService({
  now = Date.now,
  users = defaultUsers,
  challenges = createChallengeService({ now }),
  signupTokens = createSignupTokenService({ now }),
  sessions = defaultSessions,
  passwords = defaultPasswords,
  logger = defaultLogger,
} = {}) {
  /** Start a session for the user and build the `Session` response. */
  async function signIn({ user, device, installationId, isNewUser }) {
    const { tokens, session } = await sessions.createSession({
      userId: String(user._id),
      signInMethod: 'password',
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
   * Check a code. For a sign-up challenge a correct code uses it up and returns the one-time sign-up token.
   * TODO(password reset PR): password_reset (resetToken). TODO(phone PR): phone_verification (the verified number).
   * Until then those challenges cannot be verified here, and checking one does not use it up.
   * @param {{challengeId: string, code: string, installationId: string, userId?: string}} input
   * @returns {Promise<object>} `ChallengeVerification`
   */
  async function verifyChallenge({ challengeId, code, installationId, userId }) {
    const verified = await challenges.verify({
      challengeId, code, installationId, userId, allowedPurposes: ['signup_email'],
    });
    // The only purpose allowed above; a new purpose must be handled here before it is added to that list.
    if (verified.purpose !== 'signup_email') throw challengeNotFound();
    let issued;
    try {
      issued = await signupTokens.issue({ email: verified.destination, installationId });
    } catch (err) {
      // The code was right but the user got nothing for it. Give the code back, so they can enter it again.
      await challenges.reopen({ challengeId: verified.challenge.id, verifiedAt: verified.verifiedAt })
        .catch((reopenErr) => logger.warn({ err: reopenErr && reopenErr.name }, 'could not give a verified code back'));
      throw err;
    }
    const { signupToken, expiresAt } = issued;
    return {
      purpose: 'signup_email',
      email: verified.destination,
      signupToken,
      signupTokenExpiresAt: iso(expiresAt),
    };
  }

  /**
   * Create the account for a verified email and sign in. The password is checked first, so a weak one
   * can be fixed and sent again with the same token. The token works once.
   * TODO(guest PR): a guest access token in Authorization moves the guest's data to the new account.
   * TODO(config PR): LANGUAGE_UNSUPPORTED once GET /config serves the supported languages (the tag's format is already checked).
   * @param {{signupToken: string, password: string, device: object, preferredLanguage?: string, installationId: string}} input
   * @returns {Promise<object>} `Session`, with `isNewUser: true`
   */
  async function completeSignup({ signupToken, password, device, preferredLanguage, installationId }) {
    assertSameInstall(device, installationId);
    const unmet = passwords.unmetRules(password);
    if (unmet.length > 0) throw passwords.policyViolation(unmet);

    const { email, tokenHash } = await signupTokens.consume({ signupToken, installationId });
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
        ...(preferredLanguage ? { preferredLanguage } : {}),
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
    return signIn({ user, device, installationId, isNewUser: true });
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

  return { checkEmailAvailability, startEmailSignup, getChallenge, resendChallenge, verifyChallenge, completeSignup, login };
}

module.exports = { createAuthService, LOGIN_RULES };
