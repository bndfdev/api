const crypto = require('node:crypto');
const { config } = require('../config');
const { ApiError } = require('../lib/problem');
const { asyncHandler } = require('../lib/asyncHandler');
const { sha256, encrypt, decrypt } = require('../lib/secrets');
const defaultRepo = require('../modules/idempotency/repo');

// Response headers that are safe to replay. The request id, cookies and rate-limit
// headers belong to one response, not to the action, so they are never stored.
const REPLAYABLE_HEADERS = ['content-type', 'content-language', 'content-location', 'location', 'etag', 'cache-control'];
const REPLAYED_HEADER = 'Idempotent-Replayed';
// A first request that has not answered after this long is treated as dead
// (the process died), so the key is not blocked until its record expires.
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** JSON text with object keys sorted, so equal bodies hash equally whatever their key order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const reused = () => new ApiError({
  status: 422,
  code: 'IDEMPOTENCY_KEY_REUSED',
  title: 'Idempotency key reused',
  detail: 'This Idempotency-Key was already used for a different request. Use a new key for a new action.',
});
const inProgress = () => new ApiError({
  status: 409,
  code: 'IDEMPOTENCY_IN_PROGRESS',
  title: 'Request already in progress',
  detail: 'A request with this Idempotency-Key is still running. Retry shortly.',
});

/** Who is acting: the user, else the install, else the IP address. */
function principal(req) {
  if (req.auth && req.auth.userId) return `user:${req.auth.userId}`;
  const installation = req.get('x-installation-id');
  if (installation) return `installation:${installation}`;
  return `ip:${req.ip}`;
}

/** The headers of this response that a replay may carry. */
function replayableHeaders(res) {
  const headers = {};
  for (const name of REPLAYABLE_HEADERS) {
    const value = res.getHeader(name);
    if (value !== undefined) headers[name] = String(value);
  }
  return headers;
}

/**
 * Idempotency-Key support for operations that list the `IdempotencyKey`
 * parameter. Mount it after `requireAuth` and the rate limiters, so rejected
 * requests are never stored, and before the handler.
 *
 * - No key: the request runs as usual. (The key's format, a UUID, is checked by
 *   the spec validation on /v1 before any handler runs; here it is an opaque string.)
 * - The first request with a key (scoped to key + method + path + caller) runs
 *   and its response is stored for 24 hours.
 * - A repeat with the same body gets the stored response again, with
 *   `Idempotent-Replayed: true`.
 * - The same key with a different body or query is 422 IDEMPOTENCY_KEY_REUSED.
 * - A repeat while the first request is still running is 409 IDEMPOTENCY_IN_PROGRESS.
 * - Server errors (5xx) and 429 are not stored, so the client can retry the
 *   action with the same key. Everything else (success and client errors) is.
 * - The stored body is encrypted (AES-256-GCM with TOKEN_ENC_KEY), because a
 *   response can carry tokens. The key itself is only stored hashed.
 * - Every attempt has a random `owner`. A request that was taken over because
 *   it looked dead can no longer complete or delete the record of the request
 *   that replaced it.
 *
 * @param {{repo?: object, now?: () => number, staleAfterMs?: number, maxBodyBytes?: number, encKey?: Buffer}} [deps]
 */
function createIdempotency({
  repo = defaultRepo,
  now = Date.now,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  encKey = config.tokenEncKey,
} = {}) {
  /** Store (or drop) the response that is about to be sent. */
  async function settle({ lookup, owner, res, chunk }) {
    const body = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '');
    const status = res.statusCode;
    if (status >= 500 || status === 429 || Buffer.byteLength(body) > maxBodyBytes) {
      await repo.release({ lookup, owner });
      return;
    }
    await repo.complete({
      lookup,
      owner,
      status,
      headers: replayableHeaders(res),
      body: encrypt(body, { key: encKey, aad: lookup }),
    });
  }

  /**
   * Hold back the end of the response until it has been saved, so a retry that
   * arrives right after the first answer already finds it.
   */
  function captureResponse({ req, res, lookup, owner }) {
    const sendNow = res.end;
    let settled = false;
    res.end = function end(...args) {
      if (settled) return sendNow.apply(this, args);
      settled = true;
      const chunk = typeof args[0] === 'function' ? undefined : args[0];
      settle({ lookup, owner, res, chunk })
        .catch((err) => req.log.error({ err }, 'could not store the idempotent response'))
        .finally(() => sendNow.apply(res, args))
        .catch((err) => req.log.error({ err }, 'could not send the response'));
      return res;
    };
  }

  /**
   * Send the stored response again. Throws when the body cannot be decrypted
   * (for example the key was rotated): the action is never repeated.
   */
  function replay(res, stored, lookup) {
    const body = decrypt(stored.body, { key: encKey, aad: lookup });
    res.status(stored.status);
    for (const [name, value] of Object.entries(stored.headers || {})) res.setHeader(name, value);
    res.setHeader(REPLAYED_HEADER, 'true');
    res.end(body);
  }

  return asyncHandler(async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (key === undefined) return next();

    const [path, query = ''] = String(req.originalUrl).split('?');
    const lookup = sha256([key, req.method, path, principal(req)].join('\n'));
    const requestHash = sha256(`${canonicalJson(req.body)}\n${query}`);
    const owner = crypto.randomUUID();

    // Two rounds at most: a record that expired between the insert and the read is simply claimed again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await repo.insertPending({ lookup, requestHash, owner, createdAt: new Date(now()) })) {
        captureResponse({ req, res, lookup, owner });
        return next();
      }
      const stored = await repo.find(lookup);
      if (!stored) continue;
      if (stored.requestHash !== requestHash) throw reused();
      if (stored.state === 'done') return replay(res, stored, lookup);
      const staleBefore = new Date(now() - staleAfterMs);
      if (stored.createdAt.getTime() <= staleBefore.getTime() &&
          await repo.takeOverStale({ lookup, staleBefore, owner, now: new Date(now()) })) {
        captureResponse({ req, res, lookup, owner });
        return next();
      }
      throw inProgress();
    }
    throw inProgress();
  });
}

module.exports = { createIdempotency, canonicalJson, idempotency: createIdempotency() };
