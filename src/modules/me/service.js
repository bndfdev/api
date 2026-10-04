/**
 * The signed-in account (docs/api/paths/me.yaml: getMe, updateMe, getOnboarding, updateOnboardingStep).
 * The rules only: no HTTP and no database access of its own. It works through the users and guests repos and
 * the legal service, and the clock and config are injected. Works for accounts and guests alike; a guest can
 * only change its language.
 *
 * Profile rules (updateMe):
 * - name: trimmed, inner whitespace collapsed, Unicode NFC; control and invisible characters are NAME_INVALID
 *   (see FORBIDDEN_IN_NAME), and a name needs at least one letter, digit or emoji; `null` removes it. Saving a
 *   name completes the `profile` step.
 * - date of birth: the minimum age (13) is checked (AGE_REQUIREMENT_NOT_MET; the date is not stored, and the
 *   attempt is recorded in `ageCheckFailedAt` for support, which nothing acts on yet). The device time zone is
 *   not known here, so "today" is the earliest-starting date on Earth (UTC+14): a birthday that has begun
 *   anywhere counts. Once set, it can be changed once within 30 days (a typo fix); after that
 *   DATE_OF_BIRTH_LOCKED (support can change it).
 * - gender: one of the spec's four, or `null`.
 * - language: one of the supported languages (LANGUAGE_UNSUPPORTED).
 * - `If-Match` with the ETag from GET or PATCH /me refuses the change with 412 if the profile (name, date of
 *   birth, gender, language) changed since. Other changes (terms, onboarding steps, phone) do not count.
 *
 * Every saved profile change moves `profileRevision` on, and is only saved if the revision is still the one it
 * was worked out from. Otherwise it is worked out again from what is stored now; with `If-Match` the client's
 * copy is stale by then, so that is 412.
 */
const { config: defaultConfig } = require('../../config');
const { ApiError } = require('../../lib/problem');
const { checkDateOfBirth } = require('../../lib/dateOfBirth');
const { assertSupportedLanguage } = require('../../lib/languages');
const { userEtagOf, profileMatches } = require('../../lib/etag');
const defaultUsers = require('../users/repo');
const defaultGuests = require('../guests/repo');
const defaultLegal = require('../legal/service');
const { toUserResponse, toGuestResponse, NAME_MAX_LENGTH } = require('../users/service');

const DAY = 24 * 60 * 60 * 1000;
/** "Once set, date of birth can be changed only once (typo fix) within 30 days" (updateMe). */
const DOB_CHANGE_WINDOW_MS = 30 * DAY;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** The zone whose date starts first, so a birthday that has begun anywhere counts. */
const EARLIEST_ZONE = 'Pacific/Kiritimati';
// Refused anywhere in a name: control characters other than ordinary whitespace (tabs and line breaks are
// collapsed into one space); invisible format characters (zero-width spaces, word joiner, byte-order mark, soft
// hyphen, direction marks and overrides, invisible operators and the like); lone surrogates; and characters that
// Unicode counts as letters or symbols but that show as nothing (the Hangul fillers, the blank Braille pattern).
// Two format characters stay where emoji need them: the zero-width joiner, and the tag characters of a
// subdivision flag such as England's.
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Cs}\u115F\u1160\u3164\uFFA0\u2800]/u;
const ALLOWED_INVISIBLE = /[\t\n\v\f\r\u200D]/gu;
const EMOJI_TAG_SEQUENCE = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
/** A name needs at least one letter, digit or emoji. */
const VISIBLE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
const OPTIONAL_STEPS = Object.freeze(['interests', 'profile']);
/** How often a profile change is worked out again when other changes keep landing first. */
const MAX_UPDATE_TRIES = 3;

const accountGone = () => new ApiError({
  status: 401, code: 'SESSION_REVOKED', title: 'Session revoked', detail: 'Sign in again.',
  headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
});
const guestNotAllowed = () => new ApiError({
  status: 403, code: 'GUEST_NOT_ALLOWED', title: 'Create an account to do this',
  detail: 'Guests can only change their language. Sign up to continue.',
});
const nameInvalid = () => new ApiError({
  status: 422, code: 'NAME_INVALID', title: 'Name invalid', detail: `Use 1 to ${NAME_MAX_LENGTH} visible characters.`,
  errors: [{ field: '/name', code: 'NAME_INVALID', message: `Use 1 to ${NAME_MAX_LENGTH} visible characters.` }],
});
const dobLocked = () => new ApiError({
  status: 409, code: 'DATE_OF_BIRTH_LOCKED', title: 'Date of birth can no longer be changed',
  detail: 'Contact support to change your date of birth.',
});
const busy = () => new ApiError({
  status: 409, code: 'CONFLICT', title: 'Changed at the same time elsewhere',
  detail: 'Your profile was being changed from another device. Try again.',
});
const preconditionFailed = () => new ApiError({
  status: 412, code: 'PRECONDITION_FAILED', title: 'Changed on another device',
  detail: 'Your account changed since you loaded it. Reload and try again.',
});
const stepInvalid = () => new ApiError({
  status: 422, code: 'ONBOARDING_STEP_INVALID', title: 'Step cannot be completed yet',
  detail: 'Save the data for this step first.',
});
const stepNotSkippable = () => new ApiError({
  status: 422, code: 'ONBOARDING_STEP_NOT_SKIPPABLE', title: 'Step cannot be skipped',
});

/** The name to store, or throws NAME_INVALID. */
function cleanName(value) {
  if (typeof value !== 'string') throw nameInvalid();
  if (FORBIDDEN_IN_NAME.test(value.replace(EMOJI_TAG_SEQUENCE, '').replace(ALLOWED_INVISIBLE, ' '))) throw nameInvalid();
  const cleaned = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = [...cleaned].length;
  if (length < 1 || length > NAME_MAX_LENGTH || !VISIBLE.test(cleaned)) throw nameInvalid();
  return cleaned;
}

/**
 * @param {{users?: object, guests?: object, legal?: object, config?: object, now?: () => number}} [deps]
 */
function createMeService({
  users = defaultUsers, guests = defaultGuests, legal = defaultLegal, config = defaultConfig, now = Date.now,
} = {}) {
  /**
   * The spec's `User` for an account document. The first time it shows onboarding finished, that is stored
   * (`onboardingCompletedAt`), so clearing a field later does not send the person back into onboarding.
   */
  async function userView(user) {
    const consents = await legal.statusFor(String(user._id));
    const view = toUserResponse(user, { consents, phoneVerificationRequired: config.features.phoneVerificationRequired });
    if (view.onboarding.status === 'completed' && !user.onboardingCompletedAt) {
      await users.markOnboardingCompleted(user._id, now());
    }
    return view;
  }

  /** The spec's `User` for a guest document. */
  async function guestView(guest) {
    return toGuestResponse(guest, { consents: await legal.statusFor(String(guest._id)) });
  }

  /** The caller's document and its `User` view. Throws 401 SESSION_REVOKED when the account no longer exists. */
  async function load(auth) {
    if (auth.accountType === 'guest') {
      const guest = await guests.findById(auth.userId);
      if (!guest) throw accountGone();
      return { guest, view: await guestView(guest) };
    }
    const user = await users.findById(auth.userId);
    if (!user) throw accountGone();
    return { user, view: await userView(user) };
  }

  /** @returns {Promise<object>} `User` */
  async function getMe(auth) {
    return (await load(auth)).view;
  }

  /**
   * What a merge patch changes on an account, worked out from the stored document: `{set, unset}`.
   * Throws the spec's errors for anything not allowed.
   */
  async function changesFor(user, patch, at) {
    const set = {};
    const unset = [];
    if (Object.hasOwn(patch, 'name')) {
      if (patch.name === null) unset.push('name');
      else set.name = cleanName(patch.name);
    }
    if (Object.hasOwn(patch, 'gender')) set.gender = patch.gender;
    if (Object.hasOwn(patch, 'preferredLanguage')) {
      assertSupportedLanguage(patch.preferredLanguage);
      set.preferredLanguage = patch.preferredLanguage;
    }
    if (Object.hasOwn(patch, 'dateOfBirth')) {
      let checked;
      try {
        checked = checkDateOfBirth(patch.dateOfBirth, { at, timeZone: EARLIEST_ZONE });
      } catch (err) {
        if (err.code === 'AGE_REQUIREMENT_NOT_MET') await users.flagAgeCheck(user._id, at);
        throw err;
      }
      // A date in an older format (or not a string at all) counts as not set.
      const stored = typeof user.dateOfBirth === 'string' && DATE_ONLY.test(user.dateOfBirth) ? user.dateOfBirth : null;
      if (checked !== stored) {
        if (stored === null) {
          Object.assign(set, { dateOfBirth: checked, dateOfBirthSetAt: new Date(at), dateOfBirthChanges: 0 });
        } else {
          const changes = user.dateOfBirthChanges || 0;
          // A date set before v1 has no record of when: it gets the one change, starting now.
          const setAt = user.dateOfBirthSetAt ? new Date(user.dateOfBirthSetAt).getTime() : at;
          if (changes >= 1 || at - setAt > DOB_CHANGE_WINDOW_MS) throw dobLocked();
          Object.assign(set, { dateOfBirth: checked, dateOfBirthChanges: changes + 1 });
          if (!user.dateOfBirthSetAt) set.dateOfBirthSetAt = new Date(at);
        }
      }
    }
    return { set, unset };
  }

  /**
   * Apply a merge patch to the profile.
   * @param {{auth: object, patch: object, ifMatch?: string}} input
   * @returns {Promise<object>} the updated `User`
   */
  async function updateMe({ auth, patch, ifMatch }) {
    for (let attempt = 1; ; attempt += 1) {
      const current = await load(auth);
      if (ifMatch && !profileMatches(ifMatch, userEtagOf(current.view))) throw preconditionFailed();

      if (auth.accountType === 'guest') {
        if (Object.keys(patch).some((field) => field !== 'preferredLanguage')) throw guestNotAllowed();
        assertSupportedLanguage(patch.preferredLanguage);
        await guests.setLanguage(current.guest._id, patch.preferredLanguage);
        return getMe(auth);
      }

      const at = now();
      const { set, unset } = await changesFor(current.user, patch, at);
      if (Object.keys(set).length === 0 && unset.length === 0) return current.view;
      set.updatedAt = new Date(at);
      const saved = await users.updateProfile(current.user._id, { set, unset, revision: current.user.profileRevision ?? null });
      if (saved === 'saved') return getMe(auth);
      if (saved === 'missing') throw accountGone();
      // Another change was saved since this one was worked out.
      if (ifMatch) throw preconditionFailed();
      if (attempt >= MAX_UPDATE_TRIES) throw busy();
    }
  }

  /** @returns {Promise<object>} `Onboarding` */
  async function getOnboarding(auth) {
    return (await load(auth)).view.onboarding;
  }

  /**
   * Mark a step completed or skipped. Only `interests` and `profile` can be skipped (and the phone step when the
   * phone is not required); a data step can only be "completed" once its data is saved, and then it is a no-op.
   * Idempotent.
   * @param {{auth: object, step: string, status: 'completed' | 'skipped'}} input
   * @returns {Promise<object>} `Onboarding`
   */
  async function updateOnboardingStep({ auth, step, status }) {
    const { user, view } = await load(auth);
    const entry = view.onboarding.steps.find((s) => s.step === step);
    // A guest only has the birthday step, and it is always done.
    if (!entry) throw stepInvalid();
    if (auth.accountType === 'guest' || !OPTIONAL_STEPS.includes(step)) {
      if (status === 'skipped' && !entry.skippable) throw stepNotSkippable();
      if (entry.status === 'completed' || entry.status === status) return view.onboarding;
      throw stepInvalid();
    }
    await users.markOnboardingStep(user._id, step, status, now());
    return getOnboarding(auth);
  }

  return { getMe, updateMe, getOnboarding, updateOnboardingStep, userView, guestView };
}

module.exports = { createMeService, cleanName, ...createMeService() };
