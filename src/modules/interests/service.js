/**
 * Interests (docs/api/paths/catalog.yaml: listFeaturedInterests, searchInterests, getInterest;
 * docs/api/paths/me.yaml: getMyInterests, replaceMyInterests, addMyInterest, removeMyInterest).
 * The rules only: no HTTP and no database access of its own. The catalog (catalog.js) says what interests exist,
 * the repo stores each person's selection; the clock is injected. Accounts and guests alike.
 *
 * - Pages: `limit` items (1 to 50, 20 by default) and an opaque cursor for the next page. A cursor is only good
 *   for the same request (the same query, kinds and sort; for featured, the same region) and for 24 hours;
 *   otherwise CURSOR_INVALID (422).
 *   `page.total` counts every match, on every page.
 * - Search text is trimmed; control characters make it SEARCH_QUERY_INVALID (422).
 * - Search sorts: `suggested` (the default) and `recently_played` (there is no play data yet) are `relevance`;
 *   `recently_followed` and `following` put the interests the caller follows first (catalog.js).
 * - The selection holds at most GET /config's `maxInterests`. Replacing it ignores duplicates (the first one
 *   counts), refuses unknown ids all at once (INTEREST_NOT_FOUND, `meta.unknownIds`) and keeps the date each
 *   interest that stays was first added (its `followedAt`). Replacing it completes the `interests` onboarding
 *   step, even with an empty list (the app's "Next" with nothing chosen); having at least one interest completes
 *   it too (users service). Adding and removing one are idempotent.
 * - Reading the selection leaves out interests no longer in the catalog (they still count towards the limit
 *   until the selection is replaced).
 */
const crypto = require('node:crypto');
const { ApiError } = require('../../lib/problem');
const { iso } = require('../../lib/time');
const { LIMITS } = require('../meta/service');
const defaultCatalog = require('./catalog');
const defaultSelections = require('./repo');
const defaultUsers = require('../users/repo');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** "A cursor ... older than 24 hours is CURSOR_INVALID." */
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
/** How far ahead of this server's clock a cursor's time may be (another instance's clock). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_OFFSET = 100000;
const CONTROL = /[\p{Cc}\p{Cs}]/u;
const REGION = /^[A-Z]{2}$/;

const accountGone = () => new ApiError({
  status: 401, code: 'SESSION_REVOKED', title: 'Session revoked', detail: 'Sign in again.',
  headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
});
const cursorInvalid = () => new ApiError({
  status: 422, code: 'CURSOR_INVALID', title: 'Start again from the first page',
  detail: 'This page link has expired or belongs to another search.',
  errors: [{ field: 'cursor', code: 'CURSOR_INVALID', message: 'Start again from the first page.' }],
});
const queryInvalid = () => new ApiError({
  status: 422, code: 'SEARCH_QUERY_INVALID', title: 'Search text not valid',
  detail: 'Remove the special characters from the search.',
  errors: [{ field: 'q', code: 'SEARCH_QUERY_INVALID', message: 'Remove the special characters from the search.' }],
});
const interestNotFound = () => new ApiError({
  status: 404, code: 'INTEREST_NOT_FOUND', title: 'Interest not found', detail: 'This interest no longer exists.',
});
const unknownInterests = (ids, unknown) => new ApiError({
  status: 422, code: 'INTEREST_NOT_FOUND', title: 'Some interests no longer exist',
  detail: 'Refresh the list and choose again.',
  errors: ids.flatMap((id, index) => (unknown.includes(id)
    ? [{ field: `/interestIds/${index}`, code: 'INTEREST_NOT_FOUND', message: 'This interest no longer exists.' }]
    : [])).slice(0, 50),
  meta: { unknownIds: unknown },
});
const limitExceeded = (max) => new ApiError({
  status: 422, code: 'INTEREST_LIMIT_EXCEEDED', title: 'Too many interests',
  detail: `Choose up to ${max} interests.`,
  meta: { maxInterests: max },
});

/** The spec's `Interest` for a catalog item. */
function toInterest(item) {
  const body = { id: item.id, kind: item.kind, title: item.title, subtitle: item.subtitle ?? null, image: item.image ?? null };
  if (item.presentation) body.presentation = { ...item.presentation };
  return body;
}

/** The spec's `UserInterest`: a catalog item the user follows, with when they first followed it (null if unknown). */
const toUserInterest = (item, followedAt) => ({ ...toInterest(item), followedAt: followedAt instanceof Date ? iso(followedAt) : null });

/** Sorts that are another sort's order: no play data exists yet, so "recently played" is the suggested order. */
const SORT_ALIASES = Object.freeze({ suggested: 'relevance', recently_played: 'relevance' });
/** Sorts that need the caller's own selection. */
const FOLLOW_SORTS = Object.freeze(['recently_followed', 'following']);

/** What a cursor is tied to: a hash of the request it was made for. */
const fingerprintOf = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);

/**
 * @param {{catalog?: object, selections?: object, users?: object, limits?: {maxInterests: number}, now?: () => number}} [deps]
 */
function createInterestsService({
  catalog = defaultCatalog, selections = defaultSelections, users = defaultUsers, limits = LIMITS, now = Date.now,
} = {}) {
  const max = limits.maxInterests;

  function encodeCursor(offset, fingerprint) {
    return Buffer.from(JSON.stringify({ o: offset, f: fingerprint, t: Math.floor(now() / 1000) })).toString('base64url');
  }

  /** The offset a cursor points at, or throws CURSOR_INVALID. No cursor is the first page. */
  function offsetFrom(cursor, fingerprint) {
    if (cursor === undefined || cursor === null) return 0;
    let decoded;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('not base64url');
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw cursorInvalid();
    }
    const { o, f, t } = decoded || {};
    const at = now();
    if (!Number.isInteger(o) || o < 0 || o > MAX_OFFSET || f !== fingerprint || !Number.isInteger(t)) throw cursorInvalid();
    if (at - t * 1000 > CURSOR_TTL_MS || t * 1000 - at > CLOCK_SKEW_MS) throw cursorInvalid();
    return o;
  }

  function pageSize(limit) {
    const n = Number(limit);
    return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : DEFAULT_LIMIT;
  }

  function page({ items, hasMore, total }, offset, limit, fingerprint) {
    return {
      data: items.map(toInterest),
      page: { nextCursor: hasMore ? encodeCursor(offset + limit, fingerprint) : null, hasMore, total },
    };
  }

  /**
   * GET /interests/featured.
   * @param {{limit?: number, cursor?: string, region?: string}} input `region`: the viewer's country, if known
   * @returns {Promise<object>} `InterestPage`
   */
  async function featured({ limit, cursor, region } = {}) {
    const guess = typeof region === 'string' ? region.trim().toUpperCase() : '';
    const home = REGION.test(guess) ? guess : null;
    const size = pageSize(limit);
    const fingerprint = fingerprintOf(['featured', home]);
    const offset = offsetFrom(cursor, fingerprint);
    return page(await catalog.featured({ region: home, offset, limit: size }), offset, size, fingerprint);
  }

  /**
   * GET /interests/search.
   * @param {{auth?: object, q?: string, kinds?: string[], sort?: string, limit?: number, cursor?: string}} input
   *   `auth` (`req.auth`) is needed for the sorts that put the caller's own interests first
   * @returns {Promise<object>} `InterestPage`
   */
  async function search({ auth, q, kinds = [], sort = 'suggested', limit, cursor } = {}) {
    const query = typeof q === 'string' ? q.trim() : '';
    if (CONTROL.test(query)) throw queryInvalid();
    const chosen = [...new Set(kinds)].sort();
    const order = SORT_ALIASES[sort] || sort;
    const size = pageSize(limit);
    const fingerprint = fingerprintOf(['search', query.normalize('NFC').toLowerCase(), chosen, order]);
    const offset = offsetFrom(cursor, fingerprint);
    let followed;
    if (FOLLOW_SORTS.includes(order)) {
      const doc = auth ? await selections.find(auth) : null;
      if (!doc) throw accountGone();
      followed = new Map((doc.interests || []).map((e) => [e.id, e.addedAt instanceof Date ? e.addedAt.getTime() : null]));
    }
    return page(await catalog.search({ query, kinds: chosen, sort: order, offset, limit: size, followed }), offset, size, fingerprint);
  }

  /** GET /interests/{interestId}. @returns {Promise<object>} `Interest` */
  async function getInterest(id) {
    const item = await catalog.get(id);
    if (!item) throw interestNotFound();
    return toInterest(item);
  }

  /** The `UserInterests` for stored entries: in the order chosen, without those no longer in the catalog. */
  async function viewOf(entries, updatedAt) {
    const found = await catalog.findByIds(entries.map((e) => e.id));
    return {
      data: entries.filter((e) => found.has(e.id)).map((e) => toUserInterest(found.get(e.id), e.addedAt)),
      updatedAt: updatedAt instanceof Date ? iso(updatedAt) : null,
    };
  }

  /** GET /me/interests. @returns {Promise<object>} `UserInterests` */
  async function getMine(auth) {
    const doc = await selections.find(auth);
    if (!doc) throw accountGone();
    return viewOf(doc.interests || [], doc.interestsUpdatedAt);
  }

  /**
   * PUT /me/interests: replace the whole selection.
   * @param {object} auth `req.auth`
   * @param {string[]} interestIds
   * @returns {Promise<object>} `UserInterests`
   */
  async function replaceMine(auth, interestIds) {
    const ids = [...new Set(interestIds)];
    if (ids.length > max) throw limitExceeded(max);
    const found = await catalog.findByIds(ids);
    const unknown = ids.filter((id) => !found.has(id));
    if (unknown.length > 0) throw unknownInterests(interestIds, unknown);

    const doc = await selections.find(auth);
    if (!doc) throw accountGone();
    const at = now();
    const before = new Map((doc.interests || []).map((e) => [e.id, e.addedAt]));
    const entries = ids.map((id) => ({ id, addedAt: before.get(id) || new Date(at) }));
    if (!(await selections.replace(auth, entries, at))) throw accountGone();
    const step = doc.onboardingSteps && doc.onboardingSteps.interests;
    if (auth.accountType !== 'guest' && !(step && step.status === 'completed')) {
      await users.markOnboardingStep(auth.userId, 'interests', 'completed', at);
    }
    return { data: entries.map((e) => toUserInterest(found.get(e.id), e.addedAt)), updatedAt: iso(new Date(at)) };
  }

  /** PUT /me/interests/{interestId}: add one (idempotent). */
  async function addMine(auth, id) {
    if (!(await catalog.get(id))) throw interestNotFound();
    const outcome = await selections.add(auth, id, { at: now(), max });
    if (outcome === 'missing') throw accountGone();
    if (outcome === 'full') throw limitExceeded(max);
  }

  /** DELETE /me/interests/{interestId}: remove one (idempotent; an id that is not chosen, or unknown, is fine). */
  async function removeMine(auth, id) {
    if ((await selections.remove(auth, id, now())) === 'missing') throw accountGone();
  }

  return { featured, search, getInterest, getMine, replaceMine, addMine, removeMine };
}

module.exports = { createInterestsService, toInterest, DEFAULT_LIMIT, MAX_LIMIT, CURSOR_TTL_MS, ...createInterestsService() };
