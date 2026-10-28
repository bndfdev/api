/**
 * One-time codes ("challenges"): sending, resending and checking a 6-digit code
 * sent to an email address or phone number. The same rules serve sign-up,
 * password reset and phone verification. No HTTP and no database access: it
 * works through `repo`, and the clock, config, providers and logger are injected.
 *
 * What it guarantees:
 * - the code comes from a cryptographic RNG, only an HMAC of it is stored, and
 *   it is compared in constant time;
 * - a code works once (an atomic update), and at most `maxAttempts` guesses are
 *   compared per code, however many requests arrive at once;
 * - a code is only checkable after it was delivered: a resend changes the code
 *   (and gives fresh attempts) only once the new one has been sent, so a failed
 *   or refused resend can never give anyone more guesses;
 * - a challenge only answers to the install that asked for it (and, for
 *   phone challenges, to the user it belongs to), otherwise it "does not exist";
 * - at most `sendLimit` codes go to one address per rolling 24 hours, test mode
 *   included, and a code that could not be delivered does not count.
 *
 * Numbers come from docs/api (the spec): the Challenge schema, `startEmailSignup`,
 * `resendChallenge`, `verifyChallenge`, and AppConfig.otp.
 */
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { config: defaultConfig } = require('../../config');
const { logger: defaultLogger } = require('../../lib/logger');
const { ApiError } = require('../../lib/problem');
const { CHANNELS, validateDestination, maskDestination } = require('../../lib/destination');
const { createEmailProvider } = require('../../providers/email');
const { createSmsProvider } = require('../../providers/sms');
const defaultRepo = require('./repo');

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

/** The spec's numbers. Exported so `GET /config` (AppConfig.otp) can serve the same ones. */
const RULES = Object.freeze({
  codeLength: 6, // Challenge.codeLength (const 6), OtpCode pattern
  ttlSeconds: 600, // "valid for 10 minutes" (startEmailSignup, Challenge.expiresAt)
  maxAttempts: 5, // "After 5 wrong codes the challenge locks" (verifyChallenge)
  resendCooldownSeconds: 30, // "30 s cooldown" (resendChallenge)
  sendLimit: 5, // "5 sends per address per 24 h" (startEmailSignup, Challenge.sendsRemaining)
  sendWindowSeconds: 24 * 60 * 60,
});

// How long a challenge document outlives its code, so a late request still gets
// "expired" instead of "not found". (Not in the spec; an internal choice.)
const RETENTION_AFTER_EXPIRY_MS = HOUR;
// What a client is told to wait when a provider failed. (The spec asks for a Retry-After; it gives no number.)
const DELIVERY_RETRY_SECONDS = RULES.resendCooldownSeconds;
// Tries to take the active key when other requests keep taking and dropping it.
const MAX_START_TRIES = 3;
// A decoy "send" waits about as long as real sends have recently taken (a moving average),
// or this long before any real send has been seen, and never longer than the cap.
const DECOY_DEFAULT_DELAY_MS = 300;
const DECOY_MAX_DELAY_MS = 5000;
const LATENCY_WEIGHT = 0.3;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const CODE_PATTERN = /^[0-9]{6}$/;
/** Each purpose is sent over one channel. */
const PURPOSE_CHANNEL = Object.freeze({ signup_email: 'email', password_reset: 'email', phone_verification: 'sms' });

/** RFC 3339 UTC without milliseconds. */
const iso = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Whole seconds to wait, rounded up and never 0: a client told to wait 0 seconds would retry at once. */
const retryAfter = (ms) => Math.max(1, Math.ceil(ms / SECOND));

// ---------------------------------------------------------------------------
// Problems (codes from ErrorCode in docs/api/components/schemas.yaml)
// ---------------------------------------------------------------------------

const notFound = () => new ApiError({
  status: 404, code: 'CHALLENGE_NOT_FOUND', title: 'Code not found',
  detail: 'This code request does not exist. Start again.',
});
const expired = () => new ApiError({
  status: 410, code: 'CHALLENGE_EXPIRED', title: 'Code expired',
  detail: 'This code has expired. Request a new one.',
});
const alreadyUsed = () => new ApiError({
  status: 409, code: 'CHALLENGE_ALREADY_USED', title: 'Code already used',
  detail: 'This code was already used.',
});
const locked = (retryAfterSeconds) => new ApiError({
  status: 423, code: 'CHALLENGE_LOCKED', title: 'Too many attempts',
  detail: 'Too many wrong codes. Request a new code.', retryAfterSeconds,
});
const codeIncorrect = (attemptsRemaining) => new ApiError({
  status: 422, code: 'CODE_INCORRECT', title: "That code isn't right",
  detail: 'Check the code and try again.', meta: { attemptsRemaining },
});
const codeFormatInvalid = () => new ApiError({
  status: 422, code: 'CODE_FORMAT_INVALID', title: 'Code format invalid',
  detail: 'The code is 6 digits.',
  errors: [{ field: '/code', code: 'CODE_FORMAT_INVALID', message: 'Enter the 6-digit code.' }],
});
const resendTooSoon = (retryAfterSeconds) => new ApiError({
  status: 429, code: 'RESEND_TOO_SOON', title: 'Please wait before requesting another code',
  retryAfterSeconds,
});
const sendLimitReached = (retryAfterSeconds) => new ApiError({
  status: 429, code: 'SEND_LIMIT_REACHED', title: 'Too many codes requested',
  detail: 'Too many codes were sent to this address. Try again later.', retryAfterSeconds,
});
const deliveryFailed = (channel) => new ApiError({
  status: 503,
  code: channel === 'email' ? 'EMAIL_DELIVERY_FAILED' : 'SMS_DELIVERY_FAILED',
  title: "We couldn't send the code",
  detail: 'The code could not be sent. Try again in a moment.',
  retryAfterSeconds: DELIVERY_RETRY_SECONDS,
});
const destinationInvalid = (channel) => (channel === 'email'
  ? new ApiError({
    status: 422, code: 'EMAIL_INVALID', title: 'Email address invalid', detail: 'Enter a valid email address.',
    errors: [{ field: '/email', code: 'EMAIL_INVALID', message: 'Enter a valid email address.' }],
  })
  : new ApiError({
    status: 422, code: 'PHONE_INVALID', title: 'Phone number invalid', detail: 'Enter a valid phone number.',
    errors: [{ field: '/phoneNumber', code: 'PHONE_INVALID', message: 'Enter a valid phone number.' }],
  }));

/**
 * @param {{repo?: object, config?: object, now?: () => number, emailProvider?: object,
 *   smsProvider?: object, logger?: object, sleep?: (ms: number) => Promise<void>,
 *   monotonic?: () => number}} [deps]
 *   `now` returns epoch ms. A provider is `{send({to, purpose, code, expiresInMinutes})}`.
 *   `monotonic` (ms) times real sends and `sleep` makes decoy sends take as long (see `start`).
 */
function createChallengeService({
  repo = defaultRepo,
  config = defaultConfig,
  now = Date.now,
  logger = defaultLogger,
  emailProvider = createEmailProvider({ config, logger }),
  smsProvider = createSmsProvider({ config, logger }),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  monotonic = () => performance.now(),
} = {}) {
  const providers = { email: emailProvider, sms: smsProvider };
  // Whole seconds, so stored times match the ones returned.
  const clock = () => Math.floor(now() / SECOND) * SECOND;
  const ttlMs = RULES.ttlSeconds * SECOND;
  const cooldownMs = RULES.resendCooldownSeconds * SECOND;
  const windowMs = RULES.sendWindowSeconds * SECOND;

  function hmac(label, value) {
    const key = config.codes.hmacKey;
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('CODE_HMAC_KEY is not configured');
    return crypto.createHmac('sha256', key).update(`${label}\n${value}`, 'utf8').digest('hex');
  }
  /** Bound to the challenge, so the same code gives a different hash in every challenge. */
  const codeHash = (challengeId, code) => hmac('code', `${challengeId}:${code}`);
  /** The hash of a decoy: made from random bytes nobody keeps, so no 6-digit code can ever match it. */
  const decoyHash = () => hmac('decoy', crypto.randomBytes(16).toString('hex'));
  /** What makes two requests "the same one": destination, purpose, install and user. */
  const activeKeyFor = ({ purpose, channel, destination, installationId, userId }) =>
    hmac('challenge', [purpose, channel, destination, installationId, userId || ''].join('\n'));
  /** How a destination is recorded in the send log: never the address itself. */
  const sendKey = (channel, destination) => hmac('destination', `${channel}:${destination}`);

  const generateCode = () => String(crypto.randomInt(0, 10 ** RULES.codeLength)).padStart(RULES.codeLength, '0');

  /** Staging test mode: a listed destination gets the fixed code and no message is sent. It is still limited like any other. */
  function isTestDestination(destination) {
    return config.codes.testMode && config.codes.testRecipients.includes(destination);
  }
  /** The code to use for a new send: random, or the fixed one for a test destination. */
  const codeFor = (destination) => (isTestDestination(destination) ? config.codes.testValue : generateCode());

  // How long real sends take (moving average), so a decoy can take as long.
  let sendLatencyMs = null;
  function recordSendLatency(ms) {
    const sample = Math.min(DECOY_MAX_DELAY_MS, Math.max(0, ms));
    sendLatencyMs = sendLatencyMs === null ? sample : (1 - LATENCY_WEIGHT) * sendLatencyMs + LATENCY_WEIGHT * sample;
  }
  const decoyDelayMs = () => (sendLatencyMs === null ? DECOY_DEFAULT_DELAY_MS : sendLatencyMs);

  async function sendsLeft(doc, at) {
    const used = await repo.countSends({ key: sendKey(doc.channel, doc.destination), at, windowMs });
    return Math.max(0, RULES.sendLimit - used);
  }

  /** `Challenge` from docs/api (components/schemas.yaml). */
  function toChallenge(doc, sendsRemaining) {
    return {
      id: String(doc._id),
      purpose: doc.purpose,
      channel: doc.channel,
      destination: maskDestination(doc.channel, doc.destination),
      codeLength: RULES.codeLength,
      expiresAt: iso(doc.expiresAt),
      resendAvailableAt: iso(doc.lastSentAt.getTime() + cooldownMs),
      attemptsRemaining: Math.max(0, doc.maxAttempts - doc.attempts),
      sendsRemaining,
    };
  }

  async function shape(doc, at) {
    return toChallenge(doc, await sendsLeft(doc, at));
  }

  /** The challenge, but only for the install (and user) it belongs to; for anyone else it does not exist. */
  async function loadOwned({ challengeId, installationId, userId }) {
    if (!OBJECT_ID.test(String(challengeId))) throw notFound();
    const doc = await repo.findById(challengeId);
    if (!doc || doc.installationId !== installationId) throw notFound();
    if (doc.userId && String(doc.userId) !== String(userId || '')) throw notFound();
    return doc;
  }

  /** Why a challenge cannot be used right now, or null. A locked challenge is only refused when `refuseLocked`. */
  function refusal(doc, at, { refuseLocked }) {
    if (!doc) return notFound();
    if (doc.verifiedAt) return alreadyUsed();
    if (doc.expiresAt.getTime() <= at) return expired();
    if (refuseLocked && doc.attempts >= doc.maxAttempts) {
      return locked(retryAfter(doc.lastSentAt.getTime() + cooldownMs - at));
    }
    return null;
  }

  /**
   * The problem to report when a conditional update found the challenge in a
   * different state than the one just read (another request got there first).
   */
  async function whyStale(id, at, { refuseLocked }) {
    const fresh = await repo.findById(id);
    return refusal(fresh, at, { refuseLocked }) || codeIncorrect(Math.max(0, fresh.maxAttempts - fresh.attempts));
  }

  /** The same, for a resend that lost the race to another one. */
  async function whyResendLost(id, at) {
    const fresh = await repo.findById(id);
    return refusal(fresh, at, { refuseLocked: false }) || resendTooSoon(retryAfter(fresh.lastSentAt.getTime() + cooldownMs - at));
  }

  /** Count a send against the address's limit. Throws SEND_LIMIT_REACHED (and records nothing) when it is full. */
  async function reserve(doc, at) {
    const reservation = await repo.reserveSend({
      key: sendKey(doc.channel, doc.destination),
      purpose: doc.purpose,
      challengeId: doc._id,
      at,
      limit: RULES.sendLimit,
      windowMs,
    });
    if (!reservation.ok) throw sendLimitReached(retryAfter(reservation.retryAfterMs));
    return reservation;
  }

  /**
   * Hand the code to the provider. A decoy sends nothing but takes as long as
   * a real send; a test-mode destination sends nothing. Throws the channel's
   * DELIVERY_FAILED if the provider fails.
   */
  async function dispatch(doc, code) {
    if (doc.decoy) {
      await sleep(decoyDelayMs());
      return;
    }
    if (isTestDestination(doc.destination)) {
      logger.debug({ channel: doc.channel, purpose: doc.purpose }, 'code test mode: fixed code issued, nothing sent');
      return;
    }
    const started = monotonic();
    try {
      await providers[doc.channel].send({
        to: doc.destination,
        purpose: doc.purpose,
        code,
        expiresInMinutes: Math.round(RULES.ttlSeconds / 60),
      });
    } catch (err) {
      // Name and code only: provider messages can contain the address.
      logger.warn({ channel: doc.channel, purpose: doc.purpose, err: err && (err.code || err.name) }, 'code delivery failed');
      throw deliveryFailed(doc.channel);
    }
    recordSendLatency(monotonic() - started);
  }

  /**
   * Send a new code to a destination and return the `Challenge`. Asking again
   * from the same install while a usable challenge exists returns that one and
   * sends nothing, so a double tap never sends two messages.
   *
   * `deliver: false` (password reset only) makes a decoy: the same challenge,
   * limits, database work and response, and a send that takes about as long as
   * a real one, but nothing is sent and no code can ever match. It is how a
   * reset request for an address with no account looks exactly like one for an
   * account. (Timing is matched on average, not exactly; a queue that sends
   * after responding would match it fully.)
   * @param {{purpose: string, channel: 'email' | 'sms', destination: string, installationId: string,
   *   userId?: string, deliver?: boolean}} input
   *   `userId` is required for `phone_verification` and not allowed for the other purposes.
   * @returns {Promise<object>} `Challenge`
   */
  async function start({ purpose, channel, destination, installationId, userId = null, deliver = true }) {
    if (!Object.hasOwn(PURPOSE_CHANNEL, purpose)) throw new TypeError('Unknown challenge purpose');
    if (!CHANNELS.includes(channel)) throw new TypeError('Unknown challenge channel');
    if (PURPOSE_CHANNEL[purpose] !== channel) throw new TypeError(`${purpose} is sent by ${PURPOSE_CHANNEL[purpose]}, not ${channel}`);
    if (purpose === 'phone_verification') {
      if (!OBJECT_ID.test(String(userId))) throw new TypeError('phone_verification needs the userId it belongs to');
    } else if (userId) {
      throw new TypeError(`${purpose} does not belong to a user`);
    }
    if (deliver !== true && deliver !== false) throw new TypeError('deliver must be true or false');
    if (deliver === false && purpose !== 'password_reset') throw new TypeError('Only password_reset can be a decoy');
    if (typeof destination !== 'string') throw new TypeError('A destination is required');
    if (typeof installationId !== 'string' || installationId === '') throw new TypeError('An installation id is required');
    const normalised = validateDestination(channel, destination);
    if (normalised === null) throw destinationInvalid(channel);

    const at = clock();
    const decoy = deliver === false;
    const key = { purpose, channel, destination: normalised, installationId, userId: userId ? String(userId) : null };
    const activeKey = activeKeyFor(key);

    // Only one challenge can hold the active key. If another request already
    // holds it and it is still usable, hand that one out and send nothing (a
    // double tap, even two at once). If the holder is expired, locked or used,
    // let go of the key and take it.
    let doc;
    let code;
    for (let attempt = 0; attempt < MAX_START_TRIES && !doc; attempt += 1) {
      const id = repo.newId();
      code = decoy ? null : codeFor(key.destination);
      try {
        doc = await repo.insertChallenge({
          _id: id,
          ...key,
          activeKey,
          codeHash: decoy ? decoyHash() : codeHash(id, code),
          decoy,
          maxAttempts: RULES.maxAttempts,
          sendCount: 1,
          lastSentAt: new Date(at),
          expiresAt: new Date(at + ttlMs),
          purgeAt: new Date(at + ttlMs + RETENTION_AFTER_EXPIRY_MS),
        });
      } catch (err) {
        if (!repo.isDuplicateKey(err)) throw err;
        const holder = await repo.findByActiveKey(activeKey);
        if (holder && !refusal(holder, at, { refuseLocked: true })) return shape(holder, at);
        if (holder) await repo.releaseActiveKey(holder._id);
      }
    }
    if (!doc) throw new Error('Could not start a challenge: too many simultaneous requests');

    let reservation = null;
    try {
      reservation = await reserve(doc, at);
      await dispatch(doc, code);
    } catch (err) {
      if (reservation) await repo.releaseSend(reservation.id);
      await repo.deleteChallenge(doc._id);
      throw err;
    }
    return shape(doc, at);
  }

  /**
   * The challenge as it stands now (restores the code screen's countdown).
   * A used challenge is reported as not found: there is nothing left to restore.
   * @param {{challengeId: string, installationId: string, userId?: string}} input
   * @returns {Promise<object>} `Challenge`
   */
  async function get({ challengeId, installationId, userId }) {
    const at = clock();
    const doc = await loadOwned({ challengeId, installationId, userId });
    if (doc.verifiedAt) throw notFound();
    const problem = refusal(doc, at, { refuseLocked: false });
    if (problem) throw problem;
    return shape(doc, at);
  }

  /**
   * Send a new code for the same challenge. Once it has been sent, the old code
   * stops working, the attempts start again and the expiry moves. A locked
   * challenge can be resent: that is how the user gets past the lock (it counts
   * toward the daily limit).
   *
   * The order matters. The send is counted first (so a full limit changes
   * nothing), then the cooldown is claimed (so only one of several simultaneous
   * resends goes on), then the message is sent, and only then does the new code
   * replace the old one. Until then the old code, and its attempt counter, are
   * exactly as they were; if the send fails the old code keeps working and the
   * cooldown stays, so the client waits before trying again.
   * @param {{challengeId: string, installationId: string, userId?: string}} input
   * @returns {Promise<object>} `Challenge`
   */
  async function resend({ challengeId, installationId, userId }) {
    const at = clock();
    const doc = await loadOwned({ challengeId, installationId, userId });
    const problem = refusal(doc, at, { refuseLocked: false });
    if (problem) throw problem;
    const wait = doc.lastSentAt.getTime() + cooldownMs - at;
    if (wait > 0) throw resendTooSoon(retryAfter(wait));

    const reservation = await reserve(doc, at);
    const claimed = await repo.claimResend({ id: doc._id, at, cooldownMs });
    if (!claimed) {
      await repo.releaseSend(reservation.id);
      throw await whyResendLost(doc._id, at);
    }

    const code = claimed.decoy ? null : codeFor(claimed.destination);
    try {
      await dispatch(claimed, code);
    } catch (err) {
      await repo.releaseSend(reservation.id);
      throw err;
    }

    const next = {
      codeHash: claimed.decoy ? decoyHash() : codeHash(claimed._id, code),
      expiresAt: new Date(at + ttlMs),
      purgeAt: new Date(at + ttlMs + RETENTION_AFTER_EXPIRY_MS),
    };
    // Not if the challenge was used while the message was on its way.
    if (!await repo.commitResend({ id: claimed._id, at, ...next })) throw await whyResendLost(claimed._id, at);
    return shape({ ...claimed, ...next, attempts: 0, lastSentAt: new Date(at), sendCount: claimed.sendCount + 1 }, at);
  }

  /**
   * Check a code. On success the challenge is used up (it cannot be verified
   * again) and the caller gets what it needs to issue the next token.
   * @param {{challengeId: string, code: string, installationId: string, userId?: string, allowedPurposes?: string[]}} input
   *   `allowedPurposes`: the purposes the caller can finish. A challenge for any other purpose "does not exist",
   *   and nothing is counted or used up, so one that this caller cannot finish is never spent by it.
   * @returns {Promise<{challenge: object, purpose: string, channel: string, destination: string,
   *   userId: string | null, installationId: string, verifiedAt: string}>}
   *   `destination` is the normalised, unmasked address; `challenge` is the `Challenge` shape.
   */
  async function verify({ challengeId, code, installationId, userId, allowedPurposes }) {
    const at = clock();
    const doc = await loadOwned({ challengeId, installationId, userId });
    if (allowedPurposes && !allowedPurposes.includes(doc.purpose)) throw notFound();
    const problem = refusal(doc, at, { refuseLocked: true });
    if (problem) throw problem;

    // Spaces around the code are ignored; anything else that is not 6 digits is
    // refused without using up an attempt.
    const presented = typeof code === 'string' ? code.trim() : '';
    if (!CODE_PATTERN.test(presented)) throw codeFormatInvalid();

    // Count the attempt before looking at the code, atomically.
    const counted = await repo.registerAttempt({ id: doc._id, at });
    if (!counted) throw await whyStale(doc._id, at, { refuseLocked: true });

    const stored = Buffer.from(counted.codeHash, 'hex');
    const given = Buffer.from(codeHash(counted._id, presented), 'hex');
    const matches = stored.length === given.length && crypto.timingSafeEqual(stored, given);
    if (!matches) {
      const remaining = counted.maxAttempts - counted.attempts;
      if (remaining <= 0) throw locked(retryAfter(counted.lastSentAt.getTime() + cooldownMs - at));
      throw codeIncorrect(remaining);
    }

    // The one request that gets here first wins; a parallel request with the same code is "already used".
    const won = await repo.markVerified({ id: counted._id, codeHash: counted.codeHash, at });
    // (Not used and not expired: the code was replaced by a resend while it was being checked.)
    if (!won) throw await whyStale(counted._id, at, { refuseLocked: false });

    const verified = { ...counted, verifiedAt: new Date(at) };
    return {
      challenge: await shape(verified, at),
      purpose: verified.purpose,
      channel: verified.channel,
      destination: verified.destination,
      userId: verified.userId ? String(verified.userId) : null,
      installationId: verified.installationId,
      verifiedAt: iso(at),
    };
  }

  /**
   * Undo a successful `verify` whose follow-up (for example handing out a sign-up token) failed, so a code
   * the user entered correctly is not lost: the challenge can be verified again with the same code, and the
   * correct attempt does not count against the 5. Does nothing if the challenge has changed since.
   * @param {{challengeId: string, verifiedAt: string}} verified the `challenge.id` and `verifiedAt` that `verify` returned
   * @returns {Promise<boolean>} whether it was undone
   */
  async function reopen({ challengeId, verifiedAt }) {
    return repo.unmarkVerified({ id: challengeId, at: Date.parse(verifiedAt) });
  }

  return { start, get, resend, verify, reopen };
}

module.exports = { createChallengeService, RULES };
