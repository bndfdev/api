/**
 * Phone numbers for verification codes, with libphonenumber-js (full metadata,
 * so the number type is known). The API takes numbers in E.164 (`PhoneNumber`
 * in docs/api: "+" then country code and number); this checks that the number
 * really exists in its country's numbering plan and says what kind it is.
 * No database and no config.
 */
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Number types that never get a code: premium-rate and shared-cost numbers (SMS fraud), pagers,
 * voicemail, and plain landlines (they cannot receive a text). VoIP is refused only when configured.
 * The spec: "Premium-rate and (optionally) VoIP numbers are refused to stop SMS fraud".
 */
const REFUSED_TYPES = Object.freeze(['PREMIUM_RATE', 'SHARED_COST', 'PAGER', 'VOICEMAIL', 'FIXED_LINE']);

/**
 * @param {unknown} value
 * @returns {{e164: string, region: string | undefined, callingCode: string, type: string | undefined} | null}
 *   null when it is not a valid E.164 number
 */
function parsePhone(value) {
  if (typeof value !== 'string' || !E164.test(value)) return null;
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, region: parsed.country, callingCode: parsed.countryCallingCode, type: parsed.getType() };
}

/**
 * Whether a code may be sent to a number of this type.
 * @param {string | undefined} type from `parsePhone`
 * @param {{refuseVoip: boolean}} options
 */
function typeAllowed(type, { refuseVoip }) {
  if (REFUSED_TYPES.includes(type)) return false;
  return !(refuseVoip && type === 'VOIP');
}

/** "+1", "+91": the country calling code of an E.164 number, or null. */
function callingCodeOf(e164) {
  const parsed = parsePhone(e164);
  return parsed ? `+${parsed.callingCode}` : null;
}

module.exports = { parsePhone, typeAllowed, callingCodeOf, REFUSED_TYPES };
