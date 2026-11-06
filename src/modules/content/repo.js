/**
 * The only place that reads and writes the `contents` collection (models/Content.js). Returns plain objects.
 *
 * Pages are read by key ("everything after this item"), not by skipping: each sort has its own index that starts
 * with `ownerId` and ends with `_id` (see the model), so a page costs the same however deep it is, and an item
 * added or hidden meanwhile does not shift the next page.
 */
const Content = require('../../../models/Content');

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Each sort's field and direction; `_id` breaks ties in the same direction. */
const SORTS = Object.freeze({
  recent: { field: 'createdAt', direction: -1 },
  popular: { field: 'listens', direction: -1 },
  title: { field: 'titleLower', direction: 1 },
});

/**
 * The owner's items of this type (null: every type) and visibility (null: both). An item without `hidden` counts
 * as not hidden, as the service shows it.
 */
const filterFor = (ownerId, type, hidden) => ({
  ownerId,
  ...(type ? { type } : {}),
  ...(hidden === true ? { hidden: true } : {}),
  ...(hidden === false ? { hidden: { $ne: true } } : {}),
});

/**
 * One page of an owner's content.
 * @param {{ownerId: string, type: string | null, hidden?: boolean | null, sort: 'recent' | 'popular' | 'title',
 *   limit: number, after?: {value: Date | number | string, id: string} | null}} input `type` null for every type;
 *   `hidden` null for hidden and not; `after` the sort key and id of the last item of the previous page
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
async function page({ ownerId, type, hidden = null, sort, limit, after = null }) {
  if (!OBJECT_ID.test(String(ownerId))) return { items: [], hasMore: false };
  const { field, direction } = SORTS[sort];
  const query = filterFor(ownerId, type, hidden);
  if (after) {
    const beyond = direction === 1 ? '$gt' : '$lt';
    query.$or = [
      { [field]: { [beyond]: after.value } },
      { [field]: after.value, _id: { [beyond]: after.id } },
    ];
  }
  const docs = await Content.find(query).sort({ [field]: direction, _id: direction }).limit(limit + 1).lean();
  return { items: docs.slice(0, limit), hasMore: docs.length > limit };
}

/** How many items an owner has of this type and visibility (null: any). */
function count({ ownerId, type, hidden = null }) {
  if (!OBJECT_ID.test(String(ownerId))) return Promise.resolve(0);
  return Content.countDocuments(filterFor(ownerId, type, hidden));
}

/**
 * Change the privacy flags of one item, if this owner owns it.
 * @param {{ownerId: string, contentId: string, set: {hidden?: boolean, followersOnly?: boolean}}} input
 * @returns {Promise<object | null>} the item after the change; null when there is no such item for this owner
 */
function updateFlags({ ownerId, contentId, set }) {
  if (!OBJECT_ID.test(String(ownerId)) || !OBJECT_ID.test(String(contentId))) return Promise.resolve(null);
  return Content.findOneAndUpdate({ _id: contentId, ownerId }, { $set: set }, { returnDocument: 'after' }).lean();
}

/**
 * The owner's items among these ids (the Profile's hand-picked items), hidden and followers-only ones included.
 * Unknown ids, ids in no known format and other owners' items are left out.
 * @param {{ownerId: string, ids: string[]}} input
 * @returns {Promise<object[]>} in no particular order
 */
function findOwned({ ownerId, ids }) {
  const wanted = ids.filter((id) => OBJECT_ID.test(String(id)));
  if (!OBJECT_ID.test(String(ownerId)) || wanted.length === 0) return Promise.resolve([]);
  return Content.find({ _id: { $in: wanted }, ownerId }).lean();
}

module.exports = { page, count, updateFlags, findOwned, SORTS };
