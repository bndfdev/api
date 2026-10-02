const mongoose = require('mongoose');
const { RateLimiterMemory, RateLimiterMongo, RateLimiterRes } = require('rate-limiter-flexible');
const { config } = require('../config');
const { logger } = require('../lib/logger');
const { ApiError } = require('../lib/problem');
const { asyncHandler } = require('../lib/asyncHandler');
const { sha256 } = require('../lib/secrets');
const { ipBucket } = require('../lib/ip');

// Every limiter shares one collection; keys are told apart by `name:`.
const COLLECTION = 'rate_limits';
const UNKNOWN_KEY = '-';
// A counter store that does not answer in this time counts as failed (and the request is allowed),
// instead of making every request wait for MongoDB's own, much longer, timeout.
const STORE_TIMEOUT_MS = 2000;

/**
 * The default store: counters in MongoDB (shared by every instance, survives
 * restarts) everywhere except tests, which count in memory. The Mongo store
 * waits for the connection by itself, so this does not look at its state: if
 * MongoDB is unreachable the request fails open (see `rateLimit`).
 * A `storeFactory` replaces it.
 * @param {{name: string, points: number, durationSeconds: number}} limit
 * @param {boolean} [persistent] use MongoDB; by default whenever not under test
 * @returns {{consume: (key: string, points?: number) => Promise<RateLimiterRes>}}
 */
function defaultStoreFactory({ name, points, durationSeconds }, persistent = !config.isTest) {
  const options = { keyPrefix: name, points, duration: durationSeconds };
  if (!persistent) return new RateLimiterMemory(options);
  return new RateLimiterMongo({ ...options, storeClient: mongoose.connection, tableName: COLLECTION });
}

/**
 * The caller's IP address (IPv6: its /64 prefix, see `ipBucket`). The right
 * address behind a proxy only when TRUST_PROXY is set.
 */
const byIp = (req) => ipBucket(req.ip);
/** The install, from the X-Installation-Id header every /v1 request carries. */
const byInstallation = (req) => req.get('x-installation-id');
/** The signed-in user. Mount after requireAuth. */
const byUser = (req) => (req.auth ? req.auth.userId : undefined);

/** Reject if `promise` has not settled within `ms`. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('rate limiter store timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `RateLimit` header value as `headers.yaml` defines it: `limit=5, remaining=2, reset=1800`. */
const rateLimitHeader = ({ limit, remaining, reset }) => `limit=${limit}, remaining=${remaining}, reset=${reset}`;

/**
 * Rate limit middleware. Each request costs one point against a counter kept per
 * `key(req)`; once `points` are used within `durationSeconds`, requests get
 * 429 RATE_LIMITED with `Retry-After` until the window ends.
 *
 * - Keys are hashed before they are stored, so IP addresses, emails and ids
 *   are not kept in the database.
 * - Every response carries `RateLimit: limit=..., remaining=..., reset=...`. When
 *   several limiters apply to one request, the tightest one is reported.
 * - If the store fails, the request is allowed and a warning is logged: an
 *   outage of the counters must not become an outage of the API.
 *
 * @param {object} options
 * @param {string} options.name unique name of this limit (also the counter's key prefix)
 * @param {number} options.points requests allowed per window
 * @param {number} options.durationSeconds window length
 * @param {(req: import('express').Request) => string | undefined} options.key what to count by (see `byIp`, `byInstallation`, `byUser`)
 * @param {typeof defaultStoreFactory} [options.storeFactory] builds the counter store; tests inject one
 */
function rateLimit({ name, points, durationSeconds, key, storeFactory = defaultStoreFactory }) {
  let limiter;
  const getLimiter = () => (limiter ??= storeFactory({ name, points, durationSeconds }));

  return asyncHandler(async (req, res, next) => {
    const subject = sha256(String(key(req) || UNKNOWN_KEY));
    let outcome;
    let limited = false;
    try {
      outcome = await withTimeout(getLimiter().consume(subject, 1), STORE_TIMEOUT_MS);
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) {
        outcome = rejection;
        limited = true;
      } else {
        (req.log || logger).warn({ err: rejection, limiter: name }, 'rate limiter store failed; allowing the request');
        return next();
      }
    }

    const remaining = Math.max(0, outcome.remainingPoints);
    const reset = Math.max(0, Math.ceil(outcome.msBeforeNext / 1000));
    const header = rateLimitHeader({ limit: points, remaining, reset });

    // Keep the tightest limit when several limiters apply to the same request.
    const previous = res.locals.rateLimit;
    if (!previous || remaining < previous.remaining) {
      res.locals.rateLimit = { remaining };
      res.setHeader('RateLimit', header);
    }

    if (limited) {
      throw new ApiError({
        status: 429,
        code: 'RATE_LIMITED',
        title: 'Too many requests',
        detail: 'Too many requests. Wait before trying again.',
        retryAfterSeconds: Math.max(1, reset),
        headers: { RateLimit: header },
      });
    }
    return next();
  });
}

module.exports = { rateLimit, defaultStoreFactory, byIp, byInstallation, byUser, rateLimitHeader, COLLECTION };
