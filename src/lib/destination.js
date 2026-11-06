/**
 * Where a one-time code is sent: how a destination is normalised (so the same
 * address is always stored, compared and rate-limited the same way), checked,
 * and masked for display. No config and no database, so config.js can use it.
 */
const { domainToASCII } = require('node:url');
const { callingCodeOf } = require('./phone');

const CHANNELS = Object.freeze(['email', 'sms']);
const BULLETS = '•••••';

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
// Letters, digits and the RFC 5322 "atext" symbols, without "!" and "%" (routing tricks),
// in dot-separated words: no leading, trailing or doubled dot. So none of ()<>,;:"\ [] whitespace,
// control characters, or a second "@" can appear. (Case-insensitive: the provider may get a mixed-case address.)
const LOCAL_PART = /^[a-z0-9#$&'*+/=?^_`{|}~-]+(?:\.[a-z0-9#$&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
// A phone number as the spec's PhoneNumber: "+", then 7 to 15 digits, not starting with 0.
const E164 = /^\+[1-9][0-9]{6,14}$/;

// What a domain may contain to be converted to punycode: ASCII letters, digits, dots and hyphens, or any non-ASCII character.
// Anything else (":", "/", "?", "#", "(" ...) is left as it is so the check refuses it. (The converter parses its input like a
// URL host and would otherwise quietly drop everything after a "/" or ":", turning "a@b.co:25" into "a@b.co".)
const CONVERTIBLE_DOMAIN = /^[a-z0-9.\-\u0080-￿]+$/;

/** Trim, lowercase the whole address, and store an international domain as punycode. */
function normalizeEmail(value) {
  const trimmed = String(value).trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1) return trimmed;
  const rawDomain = trimmed.slice(at + 1);
  if (!CONVERTIBLE_DOMAIN.test(rawDomain)) return trimmed;
  const domain = domainToASCII(rawDomain);
  return domain ? `${trimmed.slice(0, at)}@${domain}` : trimmed;
}

/**
 * Whether `value`, exactly as given (nothing is trimmed or fixed), is one plain
 * address: a single "@", an ASCII local part of at most 64 characters, a domain
 * of at least two valid labels whose last one is not all digits, 254 characters
 * at most.
 * @param {unknown} value
 */
function isValidEmail(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length === 0 || local.length > MAX_LOCAL_PART_LENGTH || !LOCAL_PART.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

/** Spaces, dashes and parentheses are only formatting. */
// The app sends E.164 (the spec's PhoneNumber); lib/phone.js checks that the number exists and what kind it is.
const normalizePhone = (value) => String(value).replace(/[\s\-()]/g, '');

/**
 * Normalise a destination without judging it.
 * @param {'email' | 'sms'} channel
 * @param {string} value
 */
function normalizeDestination(channel, value) {
  return channel === 'email' ? normalizeEmail(value) : normalizePhone(value);
}

/**
 * Normalise a destination and check it.
 * @param {'email' | 'sms'} channel
 * @param {unknown} value
 * @returns {string | null} the normalised destination, or null when it is not valid
 */
function validateDestination(channel, value) {
  if (typeof value !== 'string') return null;
  const normalised = normalizeDestination(channel, value);
  const valid = channel === 'email' ? isValidEmail(normalised) : E164.test(normalised);
  return valid ? normalised : null;
}

/**
 * Partly hide a destination for display (`MaskedDestination` in the spec).
 * The number of hidden characters is fixed, so the length is not revealed.
 * @param {'email' | 'sms'} channel
 * @param {string} destination a normalised destination
 */
function maskDestination(channel, destination) {
  const value = String(destination);
  if (channel === 'email') {
    const at = value.lastIndexOf('@');
    if (at < 0) return BULLETS;
    const local = value.slice(0, at);
    const domain = value.slice(at);
    if (local.length >= 3) return `${local[0]}${BULLETS}${local[local.length - 1]}${domain}`;
    if (local.length === 2) return `${local[0]}${BULLETS}${domain}`;
    return `${BULLETS}${domain}`;
  }
  // The country code and the last 4 digits ('+1 ••• ••• 0123'); when the country cannot be read, that is hidden too.
  const digits = value.replace(/\D/g, '');
  const country = callingCodeOf(value);
  const head = country ? `${country} •••` : '+•••';
  return digits.length > 4 ? `${head} ••• ${digits.slice(-4)}` : `${head} •••`;
}

module.exports = {
  CHANNELS,
  normalizeEmail,
  normalizePhone,
  normalizeDestination,
  isValidEmail,
  validateDestination,
  maskDestination,
};
