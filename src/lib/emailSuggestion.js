/**
 * "Did you mean ...?" for a mistyped email domain (`EmailAvailability.suggestion`).
 * Only the domain is looked at, and only against a short list of the big providers,
 * so a suggestion is only made when it is very likely a typo.
 */
const POPULAR_DOMAINS = Object.freeze([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'live.com', 'aol.com', 'proton.me', 'protonmail.com',
]);
// A domain this short is too likely to be a real, different domain.
const MIN_DOMAIN_LENGTH = 7;

/** Whether `a` and `b` are one edit apart: one letter added, removed or changed, or two neighbours swapped. */
function oneEditApart(a, b) {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    const swapped = i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    return swapped || a.slice(i + 1) === b.slice(i + 1);
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i);
}

/**
 * @param {string} email a normalised address
 * @returns {string | null} the address with the likely correct domain, or null
 */
function suggestEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1);
  if (domain.length < MIN_DOMAIN_LENGTH || POPULAR_DOMAINS.includes(domain)) return null;
  const match = POPULAR_DOMAINS.find((popular) => oneEditApart(domain, popular));
  return match ? `${email.slice(0, at + 1)}${match}` : null;
}

module.exports = { suggestEmail };
