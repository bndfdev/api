/**
 * ETags for GET responses that clients cache (`/config`, `/countries`, `/legal/{type}`, `/me`), and the
 * If-None-Match / If-Match checks that go with them (docs/api: the `ETag` header, `NotModified` and
 * `PreconditionFailed` responses). An ETag is a hash of the JSON body, so it changes exactly when the body does.
 */
const crypto = require('node:crypto');

/** The fields of `User` that PATCH /me changes: what an If-Match on /me protects. */
const PROFILE_FIELDS = Object.freeze(['name', 'dateOfBirth', 'gender', 'preferredLanguage']);

const hashOf = (value, length) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, length);

/** A strong ETag for a JSON body. */
function etagOf(body) {
  return `"${hashOf(body, 27)}"`;
}

/**
 * The ETag of a `User` (GET and PATCH /me), in two parts: the profile fields PATCH /me changes, then the whole
 * body. If-None-Match compares the whole tag, so 304 means nothing in the body changed. If-Match compares only
 * the profile part (the spec's "ETag of the profile the client last read"), so accepting the terms or finishing
 * an onboarding step does not make the next profile edit look stale.
 */
function userEtagOf(user) {
  const profile = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, user[field] ?? null]));
  return `"${hashOf(profile, 16)}.${hashOf(user, 22)}"`;
}

/** The tags in an If-None-Match / If-Match header. */
function tagsIn(header) {
  if (typeof header !== 'string' || header.trim() === '') return [];
  return header.split(',').map((t) => t.trim()).filter(Boolean);
}

/** If-None-Match: weak comparison, so a `W/` prefix is ignored; '*' matches anything (RFC 9110). */
function noneMatch(header, etag) {
  const tags = tagsIn(header).map((t) => t.replace(/^W\//, ''));
  return tags.includes('*') || tags.includes(etag);
}

/** The profile part of a `userEtagOf` tag, or null for any other tag (a weak one included). */
function profilePart(tag) {
  const match = /^"([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+"$/.exec(tag);
  return match ? match[1] : null;
}

/**
 * If-Match on /me: strong comparison (a weak tag never matches, RFC 9110), '*' matches, and only the profile
 * part of the tags is compared (see `userEtagOf`).
 */
function profileMatches(header, etag) {
  const current = profilePart(etag);
  return tagsIn(header).some((tag) => tag === '*' || (current !== null && profilePart(tag) === current));
}

/**
 * Send `body` as JSON with its ETag, or 304 with no body when the client already has it.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} body
 * @param {{cacheControl?: string, status?: number, etag?: string}} [options] `etag` defaults to `etagOf(body)`
 */
function sendCacheable(req, res, body, { cacheControl, status = 200, etag = etagOf(body) } = {}) {
  res.set('ETag', etag);
  if (cacheControl) res.set('Cache-Control', cacheControl);
  if (noneMatch(req.get('if-none-match'), etag)) return res.status(304).end();
  return res.status(status).json(body);
}

module.exports = { etagOf, userEtagOf, noneMatch, profileMatches, sendCacheable };
