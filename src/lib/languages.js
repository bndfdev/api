/**
 * The languages the app offers (docs/api README: "BCP 47 tags en, es, fr, de, hi"), served by GET /config as
 * `supportedLanguages` and enforced wherever a `preferredLanguage` is saved (LANGUAGE_UNSUPPORTED).
 */
const { ApiError } = require('./problem');

const SUPPORTED_LANGUAGES = Object.freeze([
  Object.freeze({ tag: 'en', name: 'English', nativeName: 'English' }),
  Object.freeze({ tag: 'es', name: 'Spanish', nativeName: 'Español' }),
  Object.freeze({ tag: 'fr', name: 'French', nativeName: 'Français' }),
  Object.freeze({ tag: 'de', name: 'German', nativeName: 'Deutsch' }),
  Object.freeze({ tag: 'hi', name: 'Hindi', nativeName: 'हिन्दी' }),
]);
const TAGS = new Set(SUPPORTED_LANGUAGES.map((l) => l.tag));

const languageUnsupported = (field) => new ApiError({
  status: 422, code: 'LANGUAGE_UNSUPPORTED', title: 'Language not supported',
  detail: `Choose one of: ${[...TAGS].join(', ')}.`,
  errors: [{ field, code: 'LANGUAGE_UNSUPPORTED', message: 'This language is not offered.' }],
});

/**
 * Throw 422 LANGUAGE_UNSUPPORTED unless `tag` is offered. `undefined` and `null` (nothing chosen) pass.
 * @param {unknown} tag
 * @param {string} [field] JSON pointer of the field, for the error
 */
function assertSupportedLanguage(tag, field = '/preferredLanguage') {
  if (tag === undefined || tag === null) return;
  if (!TAGS.has(tag)) throw languageUnsupported(field);
}

module.exports = { SUPPORTED_LANGUAGES, assertSupportedLanguage };
