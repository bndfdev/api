const mongoose = require('mongoose');

/** A BCP 47 language tag, as the spec's `TranscriptLanguage`. */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const isTime = (value) => Number.isInteger(value) && value >= 0;
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Whether `lines` is a transcript the player can show (the spec's `Transcript.lines`): each line has either `words`
 * (each with its text and times) or one `text` with the line's times, never both; texts are never blank; times are
 * whole milliseconds, no `endMs` before its `startMs`, and words never go back in time (each starts at or after the
 * start of the one before, across lines).
 */
function validLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  let last = 0;
  const timed = ({ text, startMs, endMs }) => {
    if (!isText(text) || !isTime(startMs) || !isTime(endMs) || endMs < startMs || startMs < last) return false;
    last = startMs;
    return true;
  };
  return lines.every((line) => {
    const hasWords = Array.isArray(line.words) && line.words.length > 0;
    if (hasWords) return line.text == null && line.startMs == null && line.endMs == null && line.words.every(timed);
    return timed(line);
  });
}

const wordSchema = new mongoose.Schema({
  text: { type: String, required: true },
  startMs: { type: Number, required: true },
  endMs: { type: Number, required: true },
}, { _id: false });

const lineSchema = new mongoose.Schema({
  words: { type: [wordSchema], default: undefined },
  text: { type: String },
  startMs: { type: Number },
  endMs: { type: Number },
}, { _id: false });

// A song's timed transcript in one language (v1, the media player: GET /v1/songs/{id}/transcript): the original, or
// a translation of it (`translatedFrom` is then the original's language). Kept in step with the song's
// `contents.transcriptLanguages`. There is no upload endpoint yet; locally, tools.local/e2e/seed_player.js writes
// them.
const transcriptSchema = new mongoose.Schema({
  songId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  language: { type: String, required: true, match: LANGUAGE_TAG },
  translatedFrom: { type: String, default: null, match: LANGUAGE_TAG },
  lines: {
    type: [lineSchema],
    required: true,
    validate: { validator: validLines, message: 'A transcript needs lines in the player\'s shape, with times that never go back.' },
  },
  updatedAt: { type: Date, required: true },
}, { collection: 'transcripts' });

// One transcript per song and language.
transcriptSchema.index({ songId: 1, language: 1 }, { name: 'song_language', unique: true });

module.exports = mongoose.models.Transcript || mongoose.model('Transcript', transcriptSchema);
module.exports.validLines = validLines;
module.exports.LANGUAGE_TAG = LANGUAGE_TAG;
