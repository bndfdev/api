/**
 * What the API says about a user. No HTTP and no database access.
 *
 * `toUserResponse` builds the spec's `User` (docs/api/components/schemas.yaml) from a
 * `users` document. That collection is shared with the admin panel and the old API, so
 * every field is read defensively: a value that is missing, or not in the shape the
 * spec promises (an old free-text language, say), is reported as null rather than passed on.
 */
const { iso } = require('../../lib/time');

/** Onboarding steps, in the Figma order (the spec's `OnboardingStepName`). */
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
/** The longest name, in characters (code points): PATCH /me, the `User` view and GET /config's limits. */
const NAME_MAX_LENGTH = 50;
// The old API stored 'other'; the spec offers non_binary and prefer_not_to_say instead.
const GENDERS = Object.freeze({ female: 'female', male: 'male', non_binary: 'non_binary', prefer_not_to_say: 'prefer_not_to_say', other: 'prefer_not_to_say' });

const orNull = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);
/**
 * Whether the number was proved with a code accepted by this API (`phoneVerifiedAt`). The old API's
 * `mobileNumberVerified` is not enough: it set it after a fixed code.
 */
const phoneProved = (user) => typeof user.phone === 'string' && user.phoneVerifiedAt instanceof Date;
const timeOrNull = (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? iso(value) : null);

/** Nothing accepted yet (the app shows the Terms screen). */
const NO_CONSENTS = Object.freeze({ termsAcceptedVersion: null, termsUpToDate: false, privacyAcceptedVersion: null, privacyUpToDate: false });

/** The steps a user marked themselves (`users.onboardingSteps`): `{status, updatedAt}` for interests and profile. */
const stored = (user, step) => {
  const entry = user.onboardingSteps && user.onboardingSteps[step];
  return entry && (entry.status === 'completed' || entry.status === 'skipped') ? entry : null;
};

/**
 * Progress through the onboarding flow (the spec's `Onboarding`). Data steps are done when their data is
 * stored; terms when the live terms version was accepted; `interests` and `profile` when the user marked
 * them (completed or skipped), and `profile` also once a name is set. When the phone is not required
 * (`features.phoneVerificationRequired` off) an unverified phone step is skipped.
 * TODO(interests PR): `interests` also completes when interests are chosen.
 * @param {object} user a lean `users` document
 * @param {{termsUpToDate?: boolean, phoneVerificationRequired?: boolean}} [context]
 * @returns {object} `Onboarding`
 */
function buildOnboarding(user, { termsUpToDate = false, phoneVerificationRequired = true } = {}) {
  const done = {
    email_verified: user.emailVerified !== false,
    password_set: typeof user.password === 'string' && user.password !== '',
    phone_verified: phoneProved(user),
    date_of_birth: orNull(user.dateOfBirth, DATE_ONLY) !== null,
    terms_accepted: termsUpToDate === true,
    gender: Object.hasOwn(GENDERS, user.gender),
    interests: false,
    profile: typeof user.name === 'string' && user.name.trim() !== '',
  };
  const when = {
    phone_verified: timeOrNull(user.phoneVerifiedAt),
    date_of_birth: timeOrNull(user.dateOfBirthSetAt),
  };
  const steps = ONBOARDING_STEPS.map(({ step, skippable }) => {
    const mark = stored(user, step);
    if (step === 'phone_verified' && !phoneVerificationRequired) {
      return { step, status: done[step] ? 'completed' : 'skipped', skippable: true, updatedAt: when[step] || null };
    }
    if (done[step]) return { step, status: 'completed', skippable, updatedAt: when[step] || (mark ? timeOrNull(mark.updatedAt) : null) };
    if (mark) return { step, status: mark.status, skippable, updatedAt: timeOrNull(mark.updatedAt) };
    return { step, status: 'pending', skippable, updatedAt: null };
  });
  // Once finished, onboarding stays finished: a field cleared later shows as pending, but the app does not go back.
  if (user.onboardingCompletedAt instanceof Date) return { status: 'completed', nextStep: null, steps };
  const next = steps.find((s) => s.status === 'pending');
  return { status: next ? 'in_progress' : 'completed', nextStep: next ? next.step : null, steps };
}

/**
 * @param {object} user a lean `users` document
 * @param {{consents?: object, phoneVerificationRequired?: boolean}} [context] `consents` is the account's
 *   `ConsentStatus` (legal service); without it nothing counts as accepted
 * @returns {object} `User`
 */
function toUserResponse(user, { consents = NO_CONSENTS, phoneVerificationRequired = true } = {}) {
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
    onboarding: buildOnboarding(user, { termsUpToDate: consents.termsUpToDate, phoneVerificationRequired }),
    consents: { ...consents },
    createdAt: iso(createdAt),
    updatedAt: iso(user.updatedAt || createdAt),
  };
}

/**
 * The spec's `User` for a guest: a limited account with a date of birth and maybe a language,
 * nothing else. Its onboarding is the one step a guest has (the birthday), already done.
 * @param {object} guest a lean `guest_accounts` document
 * @param {{consents?: object}} [context] the guest's `ConsentStatus` (a guest can accept the terms too)
 * @returns {object} `User`
 */
function toGuestResponse(guest, { consents = NO_CONSENTS } = {}) {
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
    consents: { ...consents },
    createdAt: iso(createdAt),
    updatedAt: iso(guest.lastActiveAt || createdAt),
  };
}

/** True while an admin has blocked the account (`isBlocked` with no end date, or one in the future). */
function isSuspended(user, at) {
  return user.isBlocked === true && (!user.blockedUntil || new Date(user.blockedUntil).getTime() > at);
}

module.exports = { toUserResponse, toGuestResponse, buildOnboarding, isSuspended, ONBOARDING_STEPS, GENDERS, NO_CONSENTS, NAME_MAX_LENGTH };
