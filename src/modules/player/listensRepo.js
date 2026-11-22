/**
 * The only place that reads and writes `listens` (models/Listen.js), the raw listen events of POST /v1/me/listens.
 */
const Listen = require('../../../models/Listen');

const DUPLICATE_KEY = 11000;

/** A write error's code: the driver's `WriteError` has it as a getter, the copy Mongoose makes keeps it in `err`. */
const codeOf = (writeError) => (writeError && (writeError.code ?? (writeError.err && writeError.err.code)));

/**
 * Store the events that are not stored yet. An event already stored (same listener, song and `endedAt`: the
 * `listener_song_end` unique index) is skipped, not an error, so a resend, or the same batch sent twice at once,
 * stores each event once and only the request that stored it sees it come back.
 * @param {object[]} docs `Listen` fields, no two with the same listener, song and `endedAt`
 * @returns {Promise<object[]>} the events this call stored, as plain objects
 */
async function insertNew(docs) {
  if (docs.length === 0) return [];
  let stored;
  try {
    stored = await Listen.insertMany(docs, { ordered: false, throwOnValidationError: true });
  } catch (err) {
    const writeErrors = [].concat(err.writeErrors || []);
    if (!Array.isArray(err.insertedDocs) || writeErrors.length === 0 ||
        writeErrors.some((writeError) => codeOf(writeError) !== DUPLICATE_KEY)) throw err;
    stored = err.insertedDocs;
  }
  return stored.map((doc) => doc.toObject());
}

module.exports = { insertNew };
