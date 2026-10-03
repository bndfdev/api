# Database change record

Every change this API makes to the MongoDB database is recorded here, in the same PR that makes it, so there is a clear audit trail. Each entry needs a review by the database owner before the PR is merged and before the code runs against any shared database.

**How changes are applied:** Mongoose creates new collections on first write, and builds the indexes declared in `models/` when the server starts (`autoIndex`). Nothing here runs a migration script or edits existing documents unless an entry says so.

**Adding an entry:** newest first. List every collection, field and index the PR adds or changes; say whether existing data is affected; give a rollback; leave "Reviewed by" for the database owner.

---

## 2026-10-03: Password reset, guests and phone verification (PR 4)

**Existing data affected:**
- **`users`: one new optional field**, `phoneVerifiedAt` (when the number in `phone` was verified with a code).
- **`users`: existing fields the new code now writes**, the same ones the old API writes:
  - `phone` and `mobileNumberVerified`, when a number is verified or removed;
  - `password` and `passwordAlgo` (argon2id), plus the new-login lock fields, when a password is reset.
- **`users`: one change to *other* accounts.** When someone verifies a phone number that a different account has in `phone` but never verified (`mobileNumberVerified` is not `true`), the number is removed from that other account (`$unset: {phone}`). Proof of ownership wins over a number that was only typed in. A number another account **has verified** is never taken: the request gets `409 PHONE_TAKEN`.
  - Pre-flight check, to see how many unverified numbers exist:
    ```js
    db.users.countDocuments({ phone: { $exists: true }, mobileNumberVerified: { $ne: true } })
    ```
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
- Numbers removed from accounts that had never verified them are not restored.
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

