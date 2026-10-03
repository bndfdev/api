/**
 * ETags for GET responses that clients cache (`/config`, `/countries`, `/legal/{type}`, `/me`), and the
 * If-None-Match / If-Match checks that go with them (docs/api: the `ETag` header, `NotModified` and
 * `PreconditionFailed` responses). An ETag is a hash of the JSON body, so it changes exactly when the body does.
 */
const crypto = require('node:crypto');

/** A strong ETag for a JSON body. */
function etagOf(body) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27);
  return `"${hash}"`;
}

/** The tags in an If-None-Match / If-Match header ('*' matches anything). Weak prefixes are ignored. */
function tagsIn(header) {
  if (typeof header !== 'string' || header.trim() === '') return [];
  return header.split(',').map((t) => t.trim().replace(/^W\//, '')).filter(Boolean);
}

/** Whether a conditional header names this ETag. */
function matches(header, etag) {
  const tags = tagsIn(header);
  return tags.includes('*') || tags.includes(etag);
}

/**
 * Send `body` as JSON with its ETag, or 304 with no body when the client already has it.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} body
 * @param {{cacheControl?: string, status?: number}} [options]
 */
function sendCacheable(req, res, body, { cacheControl, status = 200 } = {}) {
  const etag = etagOf(body);
  res.set('ETag', etag);
  if (cacheControl) res.set('Cache-Control', cacheControl);
  if (matches(req.get('if-none-match'), etag)) return res.status(304).end();
  return res.status(status).json(body);
}

module.exports = { etagOf, matches, sendCacheable };
