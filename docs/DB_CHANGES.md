# Database change record

Every change this API makes to the MongoDB database is recorded here, in the same PR that makes it, so there is a clear audit trail. Each entry needs a review by the database owner before the PR is merged and before the code runs against any shared database.

**How changes are applied:** Mongoose creates new collections on first write, and builds the indexes declared in `models/` when the server starts (`autoIndex`). Nothing here runs a migration script or edits existing documents unless an entry says so.

**Adding an entry:** newest first. List every collection, field and index the PR adds or changes; say whether existing data is affected; give a rollback; leave "Reviewed by" for the database owner.

---

## 2026-10-25: Settings, notification switches and the user's own content

**Existing data affected:** none. The new code only adds the fields and the collection below. No migration, no edit of existing documents.

**`users`: new optional fields** (absent until the user changes them; absent reads as the default)

| Field | Purpose |
| --- | --- |
| `storyTranslation` | Boolean, Account Information > Story Translation. Absent = `false`. |
| `location` | String, the Location screen's free text, stored trimmed (1 to 100 characters). Removed (`$unset`) when the user clears it. |
| `accountPrivacy` | `'public'` or `'followers'` (Privacy > Restrict to Followers). Absent = `'public'`. |
| `locationSharing` | `'always'`, `'while_using'` or `'never'` (Account > Location Sharing, the Location Services screen). Absent, or any other value, reads as `'never'`. Added in a follow-up (`feat/api-location-sharing`). It stores only the user's choice, never a position. |
| `notificationSettings` | Sub-document (no `_id`) with the switches the user changed (`likesAndComments`, `followRequests`, `profileEngagement`, `contributorMetrics`, `yourEngagement`, `newOrTrendingContent`, each a boolean) and `updatedAt`. A switch never saved is on. Stored on the user (six booleans, so the document stays small, and it goes with the account) rather than in its own collection. |

`PATCH /v1/me` also writes the existing `updatedAt` and `profileRevision`, as for the other profile fields. Values in another shape (written elsewhere) read as the defaults.

**`users.interests` (from the Interests entry): no change.** Each entry's existing `addedAt` is now returned as `followedAt` (`GET`/`PUT /v1/me/interests`) and orders the `recently_followed` search sort. It is already set when an interest is added, and kept for interests that stay when the selection is replaced. An entry without `addedAt` (none are written by v1) reads as `followedAt: null`. The same applies to `guest_accounts.interests`.

**New collection**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `contents` | Each user's playlists, albums, songs and stories: `ownerId` (users `_id`), `type`, `title`, `titleLower` (the title without accents, lower case, for the A-to-Z sort), `image` (`{url, width, height}` or null), `year`, `songCount`, `durationSec`, `listens`, `badge` (`trending`, `top10` or null), `hidden`, `followersOnly`, `createdAt`, `updatedAt` | `owner_recent` `{ownerId: 1, createdAt: -1, _id: -1}`; `owner_popular` `{ownerId: 1, listens: -1, _id: -1}`; `owner_title` `{ownerId: 1, titleLower: 1, _id: 1}` | None (content is kept). Nothing deletes a user's content yet: account deletion will have to. |

The `hidden` filter of `GET /v1/me/content` (`hidden: true`, or `hidden: {$ne: true}`) is applied on top of these indexes, with no index of its own: one user's content is small. There is no create endpoint in this change: v1 only reads `contents` and writes `hidden` / `followersOnly` (`PATCH /v1/me/content/{id}`). Whatever creates content later must set `titleLower` with the same rule (`models/Content.js` sets it on `save`) and give `createdAt` and `listens` a value, since the page queries compare them. Locally, `tools.local/e2e/seed_content.js` (not in this repo) inserts demo rows marked `seed: 'e2e'`, and refuses any non-localhost database.

**No index changes on existing collections.**

**Rollback:**
- Stop the new code.
- Drop `contents`.
- The new `users` fields can stay (the old API and the admin panel ignore them), or be removed with `db.users.updateMany({}, { $unset: { storyTranslation: '', location: '', accountPrivacy: '', locationSharing: '', notificationSettings: '' } })`.

**Reviewed by:** _pending (database owner)_

---

## 2026-10-24: Change email

**Existing data affected:**
- **`users`: existing fields the new code now writes**, only for the account that changes its email, once the code sent to the new address is accepted: `email` (the new address, normalised: trimmed, lowercase, punycode domain), `emailVerified: true` and `updatedAt`. The write only applies if the stored `email` is still the one read just before, so a change made at the same time is never overwritten. The unique index on `email` (already there) refuses an address another account holds; an older account holding it in another case is found first through the existing `email_case_insensitive` index.
- **`challenges`: one new value** in `purpose`, `change_email` (sent by email, with the account's `userId` set, as for `phone_verification`). The model's allowed list is widened (schema only; no stored document changes).
- **`reauth_tokens`** (from the re-authentication entry below): `POST /v1/me/email/verification` marks the request's token used (`usedAt`), as a password change does, and sets `usedAt` back to null when the request then fails, so the token can be sent again.

**No new collections, fields or indexes.**

**Rollback:**
- Stop the new code.
- Challenges with `purpose: 'change_email'` are deleted by the existing TTL index on `purgeAt`; nothing else needs removing.
- Changed emails stay changed: `email` keeps its type and format, so the old API reads it as before.

**Reviewed by:** _pending (database owner)_

---

## 2026-10-23: Re-authentication and password change

**Existing data affected:** `users` gets no new field. On a password change through `PUT /v1/me/password` the new code writes the existing `password` and `passwordAlgo` (argon2id) and the PR 3 lock fields (`loginFailedCount`, `loginFailedSince`, `loginLockedUntil`, cleared), plus `updatedAt`, only if the stored `password` is still the one the request was checked against. A wrong password at `POST /v1/auth/reauthenticate` or in a password change updates the same lock fields as a failed login. Other devices' `sessions` are revoked with `revokeReason: 'password_changed'` (an existing field).

**New collection**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `reauth_tokens` | SHA-256 hashes of single-use re-authentication tokens (valid 5 minutes), with the user and session each was issued to | `tokenHash` unique; `{expiresAt: 1}` TTL | Deleted when they expire |

**No index changes on existing collections.**

**Rollback:**
- Stop the new code.
- Drop `reauth_tokens`.
- Passwords changed through v1 are argon2id, which the old `/user/login` cannot check (as in PR 3).

**Reviewed by:** _pending (database owner)_

---

## 2026-10-23: Interests (catalog and the user's selection)

**Existing data affected:** none. The new code only adds the fields below, on accounts and guests that choose interests. No migration, no edit of existing documents.

**Read only, never written:** `genres`, `artists` and `countries`. The interest catalog (`src/modules/interests/catalog.js`) is built from them: `genres` gives kind `genre`, `artists` kind `artist`, `countries` kind `place`. It reads `name`, `image`, `active` and `counter` (genres), `name`, `image` and `active` (artists), and `name`, `code` and `enabled` (countries), once a minute at most. Nothing in v1 writes to these collections: choosing a genre does **not** move its `counter` (the old API's `/user/set-genres` still does), and the old `userpreferences` collection is neither read nor written.

**`users`: new optional fields** (absent until the user chooses interests)

| Field | Purpose |
| --- | --- |
| `interests` | The chosen interests: `[{id, addedAt}]` in the order chosen, at most 100 (GET /config's `maxInterests`). `id` is a catalog id such as `genre_<genres._id>`, `artist_<artists._id>` or `place_<countries._id>`. |
| `interestsUpdatedAt` | When the selection last changed |

PUT /me/interests also sets the existing `onboardingSteps.interests` (`{status: 'completed', updatedAt}`) and `updatedAt`, as "Later" already does.

**`guest_accounts`: the same two optional fields**, for a guest's selection. They go when the guest is deleted (the existing 180-day TTL), and are copied onto the new `users` document when the guest signs up.

**Why on the owner's document and not in a new collection:** the selection is small and bounded (100 short entries, a few KB at most), it is always read with its owner (GET /me needs it for the onboarding step), and keeping it on the document makes "add one, but never beyond 100" one atomic update. A guest's selection is then deleted with the guest, and moves to the account in the same insert that creates it. Nothing else reads these fields; the admin panel's own model ignores them.

**Pre-flight check:** this code assumes no document already has an `interests` or `interestsUpdatedAt` field of its own (the API's code never wrote one; the admin panel's is not known here). Both counts should be 0:
```js
db.users.countDocuments({ $or: [{ interests: { $exists: true } }, { interestsUpdatedAt: { $exists: true } }] })
db.guest_accounts.countDocuments({ interests: { $exists: true } })
```

**No new collections. No index changes.** Nothing queries by interest yet; if "who follows this artist" is needed later, a multikey index on `users.interests.id` would serve it (please decide then).

**Rollback:**
- Stop the new code.
- The new fields can stay (nothing else reads them) or be removed: `db.users.updateMany({}, {$unset: {interests: '', interestsUpdatedAt: ''}})`, and the same on `guest_accounts`.

**Reviewed by:** _pending (database owner)_

---

## 2026-10-18: Profile photos (avatar and banner)

**Existing data affected:** none. Nothing is written until a user sets a photo through v1. The old API's `profileImage` and `profileBanner` fields are not read or changed (the admin panel and old screens keep using them).

**`users`: new optional fields** (absent until used)

| Field | Purpose |
| --- | --- |
| `avatar` | The v1 profile photo: `{path, width, height, variants: [{width, height}], updatedAt}`. `path` is the storage folder of that upload (its files are `<width>.jpg`); width and height are the default size's. |
| `banner` | The v1 profile banner, in the same shape. |

Setting a photo replaces the field in one update and then deletes the old upload's files. Removing a photo unsets the field and deletes its files.

**Files outside the database:** the images themselves are in `MEDIA_DIR` (default `public/media`, git-ignored) on the server that processed them, under `avatars/<userId>/<id>/` and `banners/<userId>/<id>/`. They are JPEGs with all metadata (EXIF, GPS) removed. With more than one server, or a server whose disk is replaced, they must move to shared object storage first (a later storage driver).

**No new collections; no index changes.**

**Rollback:**
- Stop the new code.
- The two fields can stay, because nothing else reads them, or be removed with `$unset: {avatar: '', banner: ''}`.
- Delete `MEDIA_DIR` if the photos are not wanted.

**Reviewed by:** _pending (database owner)_

---

## 2026-10-03: Profile, onboarding progress and terms (PR 5)

**Existing data affected:** `onboardingCompletedAt` (below) is set once on an account the first time it is read with every onboarding step done or skipped. Otherwise nothing until a user edits their profile. Then the new code writes these existing `users` fields, in v1 formats:
- `name`;
- `gender`: may now hold `non_binary` or `prefer_not_to_say` as well as the old values. The model's allowed list is widened (schema only; no stored document changes). The admin panel's own model reads `gender` as free text.
- `dateOfBirth`: always `YYYY-MM-DD`. Older documents may hold other formats (another kind of string, a date or a number); v1 reads those as "not set" and replaces them when the user saves a date.
- `preferredLanguage`: a language tag (`en`, `es`, `fr`, `de`, `hi`) where the old API stored names like `English`.

**`users`: new optional fields** (absent until used)

| Field | Purpose |
| --- | --- |
| `dateOfBirthSetAt`, `dateOfBirthChanges` | When the date of birth was first set, and how often it changed since (one typo fix within 30 days) |
| `ageCheckFailedAt` | When a date of birth under the minimum age (13) was entered. The date itself is not stored. Recorded for support; nothing acts on it yet. |
| `onboardingSteps.interests`, `onboardingSteps.profile` | `{status, updatedAt}` when the user marked an optional step done or skipped ("Later") |
| `onboardingCompletedAt` | When onboarding was first finished. It then stays finished, even if the user clears a field later. |
| `profileRevision` | A counter that moves on with every profile change through v1, so two changes made at once from the same state cannot both be saved |

**New collection**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `consents` | One record per accepted legal document version: account (or guest), document, version, time, **IP address** and app install id | `{userId, documentType, version}` unique; `{userId, acceptedAt: -1}` | **None:** kept as the audit trail. A guest's records move to the account it signs up as. |

- `consents` stores IP addresses (personal data) for audit, as the spec asks. **Please decide how long to keep them**, and whether account deletion (a later PR) should remove or anonymise them.
- A guest's records are not cleaned up when the guest itself is deleted (180 days after it was last used); only a sign-up moves them. **Please decide whether they should go with the guest.**

**No index changes on existing collections.**

**Rollback:**
- Stop the new code.
- Drop `consents`.
- The new `users` fields can stay, because nothing else reads them, or be removed with `$unset`.
- Values written in v1 formats (`YYYY-MM-DD` dates, language tags, the two new gender values) stay. The old API reads `gender` and `dateOfBirth` as plain strings.

**Reviewed by:** _pending (database owner)_

---

## 2026-10-03: Password reset, guests and phone verification (PR 4)

**Existing data affected:**
- **`users`: one new optional field**, `phoneVerifiedAt` (when the number in `phone` was verified with a code).
- **`users`: existing fields the new code now writes**, the same ones the old API writes:
  - `phone` and `mobileNumberVerified` (and `updatedAt`), when a number is verified, or removed from an account that has one;
  - `password` and `passwordAlgo` (argon2id), plus the new-login lock fields, when a password is reset;
  - on a new account created from a guest's sign-up: the guest's `dateOfBirth` (`YYYY-MM-DD`) and `preferredLanguage`.
- **`users`: one change to *other* accounts.** Only a code accepted by v1 proves a number (`phoneVerifiedAt`). The old API marks every number it saves as verified (`mobileNumberVerified: true`) after a fixed code (`123456`), so that flag proves nothing. When someone verifies a number through v1 that a different account has in `phone` without `phoneVerifiedAt` (in practice, any number saved by the old API), the number is removed from that other account: `$unset: {phone}`, `mobileNumberVerified: false`, `updatedAt` set. A number another account **verified through v1** is never taken: the request gets `409 PHONE_TAKEN`.
  - Pre-flight check, to see how many numbers this can apply to (every number saved by the old API):
    ```js
    db.users.countDocuments({ phone: { $exists: true }, phoneVerifiedAt: { $exists: false } })
    ```
  - The old API's own phone routes (`/user/send-mobile-otp`, `/user/verify-mobile-otp`) are still mounted and still accept the fixed code. They are removed with the other old routes.
- **`sessions`: one new optional field**, `accountType` (`guest` on a guest's session; absent on an account's). Existing sessions are unaffected.
- **No index changes on existing collections.** The existing unique sparse index on `users.phone` is relied on as it is.
- **`guestusers` (the old API's guests, shown on the admin panel's "Guest users" page) is not touched.** New guests go to `guest_accounts` instead (below), so they don't appear on that admin page until the admin panel reads the new collection.

**New collections**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `reset_tokens` | SHA-256 hashes of single-use password-reset tokens (valid 15 minutes) | `tokenHash` unique; `{purgeAt: 1}` TTL | Deleted an hour after expiry |
| `guest_accounts` | One guest per app install: install id, date of birth, language | `installationId` unique; `{purgeAt: 1}` TTL | Deleted 180 days after the guest was last active |

**Rollback:**
- Stop the new code.
- Drop `reset_tokens` and `guest_accounts`.
- `users.phoneVerifiedAt` and `sessions.accountType` can stay, because nothing else reads them, or be removed with `$unset`.
- Numbers removed from other accounts (numbers saved by the old API) are not restored.
- Passwords changed through a reset are argon2id, which the old `/user/login` cannot check (as in PR 3).

**Reviewed by:** _pending (database owner)_

---

## 2026-10-03: Email sign-up and login (PR 3)

**Existing data affected:** the `users` collection gets new optional fields and one new index. No existing field is renamed, removed or retyped, and no existing document is rewritten. A user's `password` hash (and `passwordAlgo`) is updated only when that user signs in through the new login, which upgrades bcrypt to argon2id.

**`users`: new optional fields** (absent on existing documents until used)

| Field | Purpose |
| --- | --- |
| `emailVerified` | Set when an account is created through a verified email code |
| `passwordAlgo` | `bcrypt` or `argon2id` |
| `loginFailedCount`, `loginFailedSince`, `loginLockedUntil` | New-login lockout (separate from the admin panel's `isBlocked` / `blockedUntil` / `failedLoginAttempts`, which are not touched) |
| `updatedAt` | Last change made by the new code |

**`users`: new index**
- `email_case_insensitive`: `{email: 1}` with collation `{locale: 'en', strength: 2}`, **not unique**. It is for case-insensitive lookups of older mixed-case emails, and cannot fail to build on existing data.
- Pre-flight check for older emails that differ only by case (the new login picks the oldest of them):
  ```js
  db.users.aggregate([{ $group: { _id: { $toLower: '$email' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
  ```

**New collections**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `challenges` | One-time code challenges; the code is stored only as an HMAC | `activeKey` unique sparse; `{purgeAt: 1}` TTL | Deleted a while after expiry |
| `code_send_logs` | One row per code sent, for the 5-per-day limit | `{key: 1, sentAt: 1}`; `{sentAt: 1}` TTL 24 h | Deleted after 24 hours |
| `signup_tokens` | Hashes of single-use sign-up tokens | `tokenHash` unique; `{purgeAt: 1}` TTL | Deleted a while after expiry |
| `login_attempts` | Failed-login counters keyed by a hash of the email, so unknown emails lock the same way | `{purgeAt: 1}` TTL | Deleted after the lock window |

**Rollback:**
- Stop the new code.
- Drop the four new collections and the `email_case_insensitive` index (`db.users.dropIndex('email_case_insensitive')`).
- The new optional fields on `users` can stay, because nothing else reads them, or be removed with `$unset`.
- Users who signed in through the new login now have argon2id hashes, which the old `/user/login` cannot check; they would need a password reset.

**Reviewed by:** _pending (database owner)_

---

## 2026-10-03: Tokens and sessions (PR 2)

**Existing data affected:** none. No existing collection, field or index is changed.

**New collections**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `sessions` | One document per signed-in device | `{userId: 1, revokedAt: 1}`; `{expiresAt: 1}` TTL | Deleted when `expiresAt` passes |
| `refresh_tokens` | SHA-256 hashes of refresh tokens (never the token) | `tokenHash` unique; `sessionId`; `{expiresAt: 1}` TTL | Deleted when `expiresAt` passes (used tokens after 14 days at most) |
| `refresh_grace` | Encrypted new token pair for the 30-second retry window | `tokenHash` unique; `sessionId`; `{graceUntil: 1}` TTL | Deleted about 30 seconds after creation |
| `idempotency_keys` | Hashed `Idempotency-Key` plus the encrypted first response | `lookup` unique; `{createdAt: 1}` TTL | Deleted after 24 hours |
| `rate_limits` | Rate-limit counters (created by `rate-limiter-flexible`) | managed by the library, with TTL | Expire with each window |

**Rollback:** stop the new code, then drop the five collections above. Nothing else needs undoing.

**Reviewed by:** _pending (database owner)_

