/**
 * The Profile's "Hand-picked by <name>" (docs/api/paths/me.yaml: getMyHandPicked, replaceMyHandPicked). The rules
 * only: no HTTP and no database access of its own. Accounts only (the routes refuse guests).
 *
 * - Up to 3 of the user's own items, in the order the user chose; never computed. More than 3 ids, or a body in
 *   another shape, never gets here: the validator answers VALIDATION_FAILED.
 * - Reading leaves out items that no longer exist (the stored list is not changed) and includes hidden and
 *   followers-only items with their flags: this is the owner's view.
 * - Replacing checks every id before saving anything. An id that is not one of the caller's own items (unknown,
 *   deleted, someone else's, or in no known format, all answered alike so the answer never says whether an id
 *   exists) or that is sent twice is HAND_PICKED_INVALID (422), with one `errors[]` entry per such id. Ids are
 *   compared without regard to case (an ObjectId's hex). Sending the same list again changes nothing.
 */
const { ApiError } = require('../../lib/problem');
const { toContent } = require('../content/service');
const defaultContents = require('../content/repo');
const defaultPicks = require('./repo');

/** The most items the section shows (Figma), the spec's `maxItems`. */
const MAX_HAND_PICKED = 3;

const accountGone = () => new ApiError({
  status: 401, code: 'SESSION_REVOKED', title: 'Session revoked', detail: 'Sign in again.',
  headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
});
const handPickedInvalid = (errors) => new ApiError({
  status: 422, code: 'HAND_PICKED_INVALID', title: 'Some items cannot be hand-picked',
  detail: 'Refresh your content and choose again.',
  errors,
});
const fieldError = (index, message) => ({ field: `/contentIds/${index}`, code: 'HAND_PICKED_INVALID', message });

/** The caller's own items among `docs`, by id. */
const byIdOf = (docs) => new Map(docs.map((doc) => [String(doc._id), doc]));

/** The spec's `HandPicked` for these ids, in their order; ids with no item are left out. */
function present(ids, byId) {
  return { items: ids.map((id) => byId.get(id)).filter(Boolean).slice(0, MAX_HAND_PICKED).map(toContent) };
}

/**
 * @param {{contents?: object, picks?: object}} [deps]
 */
function createHandPickedService({ contents = defaultContents, picks = defaultPicks } = {}) {
  /** GET /me/hand-picked. @returns {Promise<object>} `HandPicked` */
  async function get(auth) {
    const ids = await picks.find(auth.userId);
    if (!ids) throw accountGone();
    return present(ids, byIdOf(await contents.findOwned({ ownerId: auth.userId, ids })));
  }

  /**
   * PUT /me/hand-picked.
   * @param {object} auth `req.auth`
   * @param {{contentIds: string[]}} body 0 to 3 ids (the validator has checked the shape)
   * @returns {Promise<object>} `HandPicked`, as GET answers after the change
   */
  async function replace(auth, { contentIds }) {
    const ids = contentIds.map((id) => String(id).toLowerCase());
    const byId = byIdOf(await contents.findOwned({ ownerId: auth.userId, ids }));
    const seen = new Set();
    const errors = [];
    ids.forEach((id, index) => {
      if (seen.has(id)) errors.push(fieldError(index, 'This item is already in the list.'));
      else if (!byId.has(id)) errors.push(fieldError(index, 'This item no longer exists.'));
      seen.add(id);
    });
    if (errors.length > 0) throw handPickedInvalid(errors);
    const stored = await picks.replace(auth.userId, ids);
    if (!stored) throw accountGone();
    return present(stored, byId);
  }

  return { get, replace };
}

module.exports = { createHandPickedService, MAX_HAND_PICKED, ...createHandPickedService() };
