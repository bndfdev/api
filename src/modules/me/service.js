/**
 * The signed-in account (docs/api/paths/me.yaml: getMe, updateMe, getOnboarding, updateOnboardingStep).
 * The rules only: no HTTP and no database access of its own. It works through the users and guests repos and
 * the legal service, and the clock and config are injected. Works for accounts and guests alike; a guest can
 * only change its language.
 *
 * Profile rules (updateMe):
 * - name: trimmed, inner whitespace collapsed, Unicode NFC; control, zero-width and text-direction characters
 *   are NAME_INVALID; emoji are fine; `null` removes it. Saving a name completes the `profile` step.
 * - date of birth: the minimum age (13) is checked (AGE_REQUIREMENT_NOT_MET, and the account is flagged; the
 *   date is not stored). The device time zone is not known here, so "today" is the earliest-starting date on
 *   Earth (UTC+14): a birthday that has begun anywhere counts. Once set, it can be changed once within 30 days
 *   (a typo fix); after that DATE_OF_BIRTH_LOCKED (support can change it).
 * - gender: one of the spec's four, or `null`.
 * - language: one of the supported languages (LANGUAGE_UNSUPPORTED).
 * - `If-Match` with an ETag from GET /me refuses the change with 412 if the account changed since.
 */
const { config: defaultConfig } = require('../../config');
const { ApiError } = require('../../lib/problem');
const { checkDateOfBirth } = require('../../lib/dateOfBirth');
const { assertSupportedLanguage } = require('../../lib/languages');
const { etagOf, matches } = require('../../lib/etag');
const defaultUsers = require('../users/repo');
const defaultGuests = require('../guests/repo');
const defaultLegal = require('../legal/service');
const { toUserResponse, toGuestResponse } = require('../users/service');

const DAY = 24 * 60 * 60 * 1000;
/** "Once set, date of birth can be changed only once (typo fix) within 30 days" (updateMe). */
const DOB_CHANGE_WINDOW_MS = 30 * DAY;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** The zone whose date starts first, so a birthday that has begun anywhere counts. */
const EARLIEST_ZONE = 'Pacific/Kiritimati';
const NAME_MAX_LENGTH = 50;
// Control characters other than ordinary whitespace (tabs and line breaks are collapsed into one space), and
// invisible ones used to spoof names: zero-width space and non-joiner, word joiner, byte-order mark, and the
// bidirectional overrides. (The zero-width joiner stays: emoji sequences need it.)
const FORBIDDEN_IN_NAME = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F​‌⁠﻿‪-‮⁦-⁩]/u;
const OPTIONAL_STEPS = Object.freeze(['interests', 'profile']);

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
  if (typeof value !== 'string' || FORBIDDEN_IN_NAME.test(value)) throw nameInvalid();
  const cleaned = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = [...cleaned].length;
  if (length < 1 || length > NAME_MAX_LENGTH) throw nameInvalid();
  return cleaned;
}

/**
 * @param {{users?: object, guests?: object, legal?: object, config?: object, now?: () => number}} [deps]
 */
function createMeService({
  users = defaultUsers, guests = defaultGuests, legal = defaultLegal, config = defaultConfig, now = Date.now,
} = {}) {
  /** The spec's `User` for an account document. */
  async function userView(user) {
    const consents = await legal.statusFor(String(user._id));
    return toUserResponse(user, { consents, phoneVerificationRequired: config.features.phoneVerificationRequired });
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
   * Apply a merge patch to the profile.
   * @param {{auth: object, patch: object, ifMatch?: string}} input
   * @returns {Promise<object>} the updated `User`
   */
  async function updateMe({ auth, patch, ifMatch }) {
    const current = await load(auth);
    if (ifMatch && !matches(ifMatch, etagOf(current.view))) throw preconditionFailed();

    if (auth.accountType === 'guest') {
      if (Object.keys(patch).some((field) => field !== 'preferredLanguage')) throw guestNotAllowed();
      assertSupportedLanguage(patch.preferredLanguage);
      await guests.setLanguage(current.guest._id, patch.preferredLanguage);
      return getMe(auth);
    }

    const { user } = current;
    const at = now();
    const set = {};
    const unset = [];
    let guard = {};

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
      const stored = typeof user.dateOfBirth === 'string' && DATE_ONLY.test(user.dateOfBirth) ? user.dateOfBirth : null;
      if (checked !== stored) {
        // The decision depends on what is stored now; the update only goes through if that is still so.
        guard = { dateOfBirth: user.dateOfBirth ?? null, dateOfBirthChanges: user.dateOfBirthChanges ?? null };
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

    if (Object.keys(set).length > 0 || unset.length > 0) {
      set.updatedAt = new Date(at);
      if (!await users.updateProfile(user._id, { set, unset, guard })) {
        // Another request changed the date of birth in the meantime: it used the one allowed change.
        if (Object.keys(guard).length > 0) throw dobLocked();
        throw accountGone();
      }
    }
    return getMe(auth);
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
