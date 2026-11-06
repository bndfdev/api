/**
 * Checks a date of birth (`DateOfBirth` in docs/api): a real calendar date
 * `YYYY-MM-DD`, not in the future, and a person who is at least the minimum
 * age (13) and at most 120 years old. Age is counted on the person's own local
 * date (`DeviceInfo.timeZone`), so someone turning 13 today can sign up today
 * wherever they are. No database and no config.
 */
const { ApiError } = require('./problem');

/** The spec's numbers (DateOfBirth): "at least `minimumAge` (13) years old and at most 120". */
const MINIMUM_AGE = 13;
const MAXIMUM_AGE = 120;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const dateInvalid = (field) => new ApiError({
  status: 422, code: 'DATE_OF_BIRTH_INVALID', title: 'Date of birth invalid', detail: 'Enter a real date of birth.',
  errors: [{ field, code: 'DATE_OF_BIRTH_INVALID', message: 'Enter a real date of birth.' }],
});
const tooYoung = () => new ApiError({
  status: 422, code: 'AGE_REQUIREMENT_NOT_MET', title: 'Too young to use Bondfire',
  detail: `You need to be at least ${MINIMUM_AGE} to use Bondfire.`, meta: { minimumAge: MINIMUM_AGE },
});

/** Today's date (`YYYY-MM-DD`) in `timeZone`, or in UTC when the zone is missing or unknown. */
function localToday(at, timeZone) {
  const format = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(at));
  if (typeof timeZone === 'string' && timeZone !== '') {
    try {
      return format(timeZone);
    } catch {
      // An unknown zone name: fall back to UTC.
    }
  }
  return format('UTC');
}

/** Whole years from `from` to `to` (both `YYYY-MM-DD`): a birthday counts from its day (29 February from 1 March). */
function yearsBetween(from, to) {
  const years = Number(to.slice(0, 4)) - Number(from.slice(0, 4));
  return to.slice(5) >= from.slice(5) ? years : years - 1;
}

/**
 * @param {unknown} value
 * @param {{at: number, timeZone?: string, field?: string}} options `at` is epoch ms; `field` names the
 *   field in the error (a JSON pointer, `/dateOfBirth` by default)
 * @returns {string} the date, unchanged
 * @throws {ApiError} 422 DATE_OF_BIRTH_INVALID or AGE_REQUIREMENT_NOT_MET
 */
function checkDateOfBirth(value, { at, timeZone, field = '/dateOfBirth' }) {
  const match = typeof value === 'string' ? DATE_ONLY.exec(value) : null;
  if (!match) throw dateInvalid(field);
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw dateInvalid(field);

  const today = localToday(at, timeZone);
  if (value > today) throw dateInvalid(field);
  const age = yearsBetween(value, today);
  if (age > MAXIMUM_AGE) throw dateInvalid(field);
  if (age < MINIMUM_AGE) throw tooYoung();
  return value;
}

module.exports = { checkDateOfBirth, localToday, yearsBetween, MINIMUM_AGE, MAXIMUM_AGE };
