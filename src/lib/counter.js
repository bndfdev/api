/**
 * Stored counters (a song's comments, a comment's replies and likes) changed in one atomic step of the database.
 */

/**
 * An update pipeline that adds `delta` to `field` atomically and never takes it below 0. A stored value that is not a
 * number (absent, or written in another shape) counts as 0. Mongoose needs `{updatePipeline: true}` with it.
 * @param {string} field
 * @param {number} delta a whole number, up or down
 * @returns {object[]}
 */
function addToCounter(field, delta) {
  const current = { $cond: [{ $isNumber: `$${field}` }, `$${field}`, 0] };
  return [{ $set: { [field]: { $max: [0, { $add: [current, delta] }] } } }];
}

module.exports = { addToCounter };
