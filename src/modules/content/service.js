/**
 * The user's own content (docs/api/paths/me.yaml: listMyContent, updateMyContent): the Profile tabs, Popular
 * Releases and Privacy > Hide Content / Restrict Content. The rules only: no HTTP and no database access of its
 * own; the clock is injected. Accounts only (the routes refuse guests).
 *
 * - This is the owner's view, so hidden and followers-only items are listed too, with their flags, unless
 *   `hidden` filters them: `false` only items that are not hidden (the Profile page), `true` only hidden ones.
 * - Pages: `limit` items (1 to 50, 20 by default) and an opaque cursor for the next page, as for interests: a
 *   cursor is only good for the same user, type, `hidden` filter and sort, and for 24 hours; otherwise
 *   CURSOR_INVALID (422). It holds the sort key and id of the last item shown, and the next page starts just
 *   after it.
 * - `page.total` counts every item of the requested type and `hidden` filter, on every page.
 * - Someone else's item, an unknown id and an id in no known format are all 404 CONTENT_NOT_FOUND, so the answer
 *   never says whether an id exists.
 */
const crypto = require('node:crypto');
const { ApiError } = require('../../lib/problem');
const { iso } = require('../../lib/time');
const defaultContents = require('./repo');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** "A cursor ... older than 24 hours is CURSOR_INVALID" (as for interests). */
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
/** How far ahead of this server's clock a cursor's time may be (another instance's clock). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SORTS = Object.freeze(['recent', 'popular', 'title']);
const TYPES = Object.freeze(['playlist', 'album', 'song', 'story']);
const BADGES = Object.freeze(['trending', 'top10']);
/** The types that have a song count. */
const COLLECTIONS = Object.freeze(['playlist', 'album']);
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const cursorInvalid = () => new ApiError({
  status: 422, code: 'CURSOR_INVALID', title: 'Start again from the first page',
  detail: 'This page link has expired or belongs to another list.',
  errors: [{ field: 'cursor', code: 'CURSOR_INVALID', message: 'Start again from the first page.' }],
});
const contentNotFound = () => new ApiError({
  status: 404, code: 'CONTENT_NOT_FOUND', title: 'Content not found', detail: 'This item no longer exists.',
});

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/** The spec's `Image` for stored artwork, or null (also for an address that is not http or https). */
function imageOf(stored) {
  if (!stored || typeof stored.url !== 'string') return null;
  try {
    const parsed = new URL(stored.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { url: parsed.href, width: count(stored.width), height: count(stored.height), status: 'ready', blurhash: null };
  } catch {
    return null;
  }
}

/** The spec's `Content` for a stored item. Values not in the spec's shape read as their default. */
function toContent(doc) {
  return {
    id: String(doc._id),
    type: doc.type,
    title: doc.title,
    image: imageOf(doc.image),
    year: Number.isInteger(doc.year) ? doc.year : null,
    songCount: COLLECTIONS.includes(doc.type) && Number.isInteger(doc.songCount) && doc.songCount >= 0 ? doc.songCount : null,
    durationSec: count(doc.durationSec),
    listens: count(doc.listens),
    badge: BADGES.includes(doc.badge) ? doc.badge : null,
    hidden: doc.hidden === true,
    followersOnly: doc.followersOnly === true,
    createdAt: iso(doc.createdAt),
  };
}

/** What a cursor is tied to: a hash of the request it was made for. */
const fingerprintOf = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);

/** The value a sort compares, as a cursor stores it (a date as epoch ms). */
function keyOf(doc, sort) {
  if (sort === 'recent') return new Date(doc.createdAt).getTime();
  if (sort === 'popular') return doc.listens;
  return doc.titleLower;
}

/**
 * @param {{contents?: object, now?: () => number}} [deps]
 */
function createContentService({ contents = defaultContents, now = Date.now } = {}) {
  function encodeCursor(doc, sort, fingerprint) {
    const body = { k: keyOf(doc, sort), i: String(doc._id), f: fingerprint, t: Math.floor(now() / 1000) };
    return Buffer.from(JSON.stringify(body)).toString('base64url');
  }

  /** Where a cursor says the page starts, or throws CURSOR_INVALID. No cursor is the first page (null). */
  function afterFrom(cursor, sort, fingerprint) {
    if (cursor === undefined || cursor === null) return null;
    let decoded;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('not base64url');
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw cursorInvalid();
    }
    const { k, i, f, t } = decoded || {};
    const at = now();
    if (f !== fingerprint || typeof i !== 'string' || !OBJECT_ID.test(i) || !Number.isInteger(t)) throw cursorInvalid();
    if (at - t * 1000 > CURSOR_TTL_MS || t * 1000 - at > CLOCK_SKEW_MS) throw cursorInvalid();
    if (sort === 'title' ? typeof k !== 'string' : !Number.isFinite(k)) throw cursorInvalid();
    return { value: sort === 'recent' ? new Date(k) : k, id: i };
  }

  /**
   * GET /me/content.
   * @param {object} auth `req.auth`
   * @param {{type?: string, hidden?: boolean, sort?: string, limit?: number, cursor?: string}} input `hidden`
   *   absent (or not a boolean) for hidden and not hidden alike
   * @returns {Promise<object>} `ContentPage`
   */
  async function list(auth, { type = 'all', hidden, sort = 'recent', limit, cursor } = {}) {
    const only = TYPES.includes(type) ? type : null;
    const visibility = typeof hidden === 'boolean' ? hidden : null;
    const order = SORTS.includes(sort) ? sort : 'recent';
    const n = Number(limit);
    const size = Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : DEFAULT_LIMIT;
    const fingerprint = fingerprintOf(['content', String(auth.userId), only, visibility, order]);
    const after = afterFrom(cursor, order, fingerprint);
    const [{ items, hasMore }, total] = await Promise.all([
      contents.page({ ownerId: auth.userId, type: only, hidden: visibility, sort: order, limit: size, after }),
      contents.count({ ownerId: auth.userId, type: only, hidden: visibility }),
    ]);
    return {
      data: items.map(toContent),
      page: { nextCursor: hasMore ? encodeCursor(items[items.length - 1], order, fingerprint) : null, hasMore, total },
    };
  }

  /**
   * PATCH /me/content/{contentId}.
   * @param {object} auth `req.auth`
   * @param {string} contentId
   * @param {{hidden?: boolean, followersOnly?: boolean}} patch
   * @returns {Promise<object>} `Content`
   */
  async function update(auth, contentId, patch) {
    const set = {};
    if (typeof patch.hidden === 'boolean') set.hidden = patch.hidden;
    if (typeof patch.followersOnly === 'boolean') set.followersOnly = patch.followersOnly;
    const doc = await contents.updateFlags({ ownerId: auth.userId, contentId, set });
    if (!doc) throw contentNotFound();
    return toContent(doc);
  }

  return { list, update };
}

module.exports = { createContentService, toContent, DEFAULT_LIMIT, MAX_LIMIT, CURSOR_TTL_MS, ...createContentService() };
