/**
 * What the API says about a user. No HTTP and no database access.
 *
 * `toUserResponse` builds the spec's `User` (docs/api/components/schemas.yaml) from a
 * `users` document. That collection is shared with the admin panel and the old API, so
 * every field is read defensively: a value that is missing, or not in the shape the
 * spec promises (an old free-text language, say), is reported as null rather than passed on.
 */
const { iso } = require('../../lib/time');

const ONBOARDING_STEPS = Object.freeze([
  { step: 'email_verified', skippable: false },
  { step: 'password_set', skippable: false },
  { step: 'phone_verified', skippable: false },
  { step: 'date_of_birth', skippable: false },
  { step: 'terms_accepted', skippable: false },
  { step: 'gender', skippable: false },
  { step: 'interests', skippable: true },
  { step: 'profile', skippable: true },
]);

const E164 = /^\+[1-9][0-9]{6,14}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const NAME_MAX_LENGTH = 50;
// The old API stored 'other'; the spec offers non_binary and prefer_not_to_say instead.
const GENDERS = Object.freeze({ female: 'female', male: 'male', non_binary: 'non_binary', prefer_not_to_say: 'prefer_not_to_say', other: 'prefer_not_to_say' });

const orNull = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);
/**
 * Whether the number was proved with a code accepted by this API (`phoneVerifiedAt`). The old API's
 * `mobileNumberVerified` is not enough: it set it after a fixed code.
 */
const phoneProved = (user) => typeof user.phone === 'string' && user.phoneVerifiedAt instanceof Date;

/**
 * Progress through the onboarding flow, worked out from what is stored.
 * TODO(profile and onboarding PR): replace with stored progress (skipped steps, terms, interests).
 * Until then the steps without stored data (terms, interests) are always pending.
 * @returns {object} `Onboarding`
 */
function buildOnboarding(user) {
  const done = {
    email_verified: true,
    password_set: typeof user.password === 'string' && user.password !== '',
    phone_verified: phoneProved(user),
    date_of_birth: orNull(user.dateOfBirth, DATE_ONLY) !== null,
    terms_accepted: false,
    gender: Object.hasOwn(GENDERS, user.gender),
    interests: false,
    profile: typeof user.name === 'string' && user.name.trim() !== '',
  };
  const steps = ONBOARDING_STEPS.map(({ step, skippable }) => ({
    step,
    status: done[step] ? 'completed' : 'pending',
    skippable,
    updatedAt: null,
  }));
  const next = steps.find((s) => s.status === 'pending');
  return { status: next ? 'in_progress' : 'completed', nextStep: next ? next.step : null, steps };
}

/**
 * @param {object} user a lean `users` document
 * @returns {object} `User`
 */
function toUserResponse(user) {
  const name = typeof user.name === 'string' && user.name.trim() !== '' ? [...user.name.trim()].slice(0, NAME_MAX_LENGTH).join('') : null;
  const createdAt = user.createdAt || new Date(0);
  return {
    id: String(user._id),
    accountType: 'user',
    // TODO(account deletion): pending_deletion, deletionScheduledAt.
    status: 'active',
    email: typeof user.email === 'string' && user.email !== '' ? user.email : null,
    emailVerified: user.emailVerified !== false,
    phoneNumber: orNull(user.phone, E164),
    phoneVerified: phoneProved(user),
    name,
    dateOfBirth: orNull(user.dateOfBirth, DATE_ONLY),
    gender: GENDERS[user.gender] || null,
    preferredLanguage: orNull(user.preferredLanguage, LANGUAGE_TAG),
    // TODO(media PR): avatar and banner as `Image` objects once uploads exist (only an old file path is stored now).
    avatar: null,
    banner: null,
    loginMethods: typeof user.password === 'string' && user.password !== '' ? ['password'] : [],
    onboarding: buildOnboarding(user),
    // TODO(onboarding PR): real consent records. Until then nothing is accepted, so the app shows the Terms step.
    consents: { termsAcceptedVersion: null, termsUpToDate: false, privacyAcceptedVersion: null, privacyUpToDate: false },
    createdAt: iso(createdAt),
    updatedAt: iso(user.updatedAt || createdAt),
  };
}

/**
 * The spec's `User` for a guest: a limited account with a date of birth and maybe a language,
 * nothing else. Its onboarding is the one step a guest has (the birthday), already done.
 * @param {object} guest a lean `guest_accounts` document
 * @returns {object} `User`
 */
function toGuestResponse(guest) {
  const createdAt = guest.createdAt || new Date(0);
  return {
    id: String(guest._id),
    accountType: 'guest',
    status: 'active',
    email: null,
    emailVerified: false,
    phoneNumber: null,
    phoneVerified: false,
    name: null,
    dateOfBirth: orNull(guest.dateOfBirth, DATE_ONLY),
    gender: null,
    preferredLanguage: orNull(guest.preferredLanguage, LANGUAGE_TAG),
    avatar: null,
    banner: null,
    loginMethods: [],
    onboarding: {
      status: 'completed',
      nextStep: null,
      steps: [{ step: 'date_of_birth', status: 'completed', skippable: false, updatedAt: iso(createdAt) }],
    },
    consents: { termsAcceptedVersion: null, termsUpToDate: false, privacyAcceptedVersion: null, privacyUpToDate: false },
    createdAt: iso(createdAt),
    updatedAt: iso(guest.lastActiveAt || createdAt),
  };
}

/** True while an admin has blocked the account (`isBlocked` with no end date, or one in the future). */
function isSuspended(user, at) {
  return user.isBlocked === true && (!user.blockedUntil || new Date(user.blockedUntil).getTime() > at);
}

module.exports = { toUserResponse, toGuestResponse, buildOnboarding, isSuspended };
