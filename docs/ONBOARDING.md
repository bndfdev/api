# Bondfire API: onboarding guide

This is the team guide to the Bondfire backend. It covers what the API is, how it's built, why, and what has changed. Update it in the same PR as any change it describes.

The app has its own guide: `docs/ONBOARDING.md` in [bndfdev/app](https://github.com/bndfdev/app).

---

## 1. The product

**Bondfire** is an audio-first social app for sharing stories and music.

| Repo | What it is |
| --- | --- |
| `app` | Flutter mobile app (iOS and Android) |
| `timbre` | Bondfire's design system (tokens and components used by the app) |
| `api` (this repo) | Node.js + Express + MongoDB backend |
| `admin` | Admin panel; it reads the same database |

**Current goal:** working onboarding end to end, from sign-up and login to profile setup. Once that works, it goes out as a **tester build** so anyone on the team can install the app on Android or iOS and try it against a staging server.

---

## 2. Approach

**The API spec is the contract.** `docs/api/` holds the OpenAPI 3.1 spec for onboarding and accounts:
- every endpoint, request, response and error;
- `docs/api/dist/openapi.yaml`, the single bundled file.

The app is built against the spec, and the backend is checked against it.

**We improve this repo in place.** Nothing is live yet, so there is no second API running alongside this one. Each PR replaces one area with clean code that follows the spec, and deletes the old code it replaces. Until an area is replaced, its existing routes keep working.

**Small PRs, one feature each,** every one with tests and passing CI.

---

## 3. Stack and structure

- **Runtime:** Node.js 22, Express 4, MongoDB (Mongoose), plain JavaScript (CommonJS).
- **Key libraries:**
  - `pino` / `pino-http`: structured logs;
  - `helmet`: security headers;
  - `cors`;
  - `express-openapi-validator`: checks every `/v1` request against the spec;
  - `jose`: signs and verifies access tokens (ES256);
  - `@node-rs/argon2`: password hashing (argon2id, prebuilt binaries); `bcryptjs` only to check the old API's hashes;
  - `nodemailer`: sends codes by email over SMTP;
  - `rate-limiter-flexible`: rate limits, with counters kept in MongoDB;
  - `node:test` + `supertest`: tests.

```
src/
  app.js            builds the Express app (used by the server and the tests)
  server.js         connects to MongoDB, starts listening, shuts down cleanly
  config.js         reads and checks environment variables at startup
  lib/              shared tools (logger, error format, ...)
  middleware/       security, spec validation, requireAuth, rate limits, idempotency, error handler
  modules/<feature>/
    routes.js       HTTP only: reads the request, sends the response
    service.js      the rules (e.g. how long a code is valid)
    repo.js         the only place that talks to the database
models/             Mongoose models
test/               automated tests
docs/api/           the API spec
```

**Collections** created by the new code (nothing in the existing collections is renamed or migrated). Each one cleans itself up with a TTL index:
- `sessions`, `refresh_tokens`, `refresh_grace`: signed-in devices and their refresh tokens (only hashes are stored);
- `idempotency_keys`: stored responses, kept 24 hours (the bodies are encrypted);
- `rate_limits`: rate-limit counters;
- `challenges` and `code_send_logs`: one-time codes that were sent (only a keyed hash of the code is stored) and the log that enforces "5 codes per address per day" (it keeps a keyed hash of the address, never the address);
- `signup_tokens`: proof that an email was verified, until it is used (only a hash of the token is stored);
- `login_attempts`: failed logins for an email that has no account, so that it locks like a real one (kept under a hash of the address).

**`users` is shared with the admin panel and the old API,** so it is only ever extended: no field is renamed, removed or retyped, and every new field is optional. See "Database notes" below.

**Why this shape:**
- Every feature looks the same, so it's easy to find things.
- Features can be built in parallel without touching the same files.
- Rules can be tested without a server or a database.

**Outside services** (email, SMS, file storage, Google/Apple sign-in) sit behind small adapters. Each adapter has a fake version for development and tests, so nothing real is sent while developing.

### Database notes

- **New collections:** `sessions`, `refresh_tokens`, `refresh_grace`, `idempotency_keys`, `rate_limits`, `challenges`, `code_send_logs`, `signup_tokens`, `login_attempts`, `reset_tokens`, `guest_accounts` and `consents` (no TTL: the terms-acceptance audit trail). Mongoose creates them when the server first writes to them, and each one deletes its own old records with a TTL index.
- **`users` (shared with the admin panel and the old API) is only extended.** New optional fields: `emailVerified`, `passwordAlgo`, `loginFailedCount`, `loginFailedSince`, `loginLockedUntil` and `updatedAt`. New accounts store `email` already normalised (trimmed, lowercase, punycode domain), so the existing unique index on `email` also stops duplicates. The admin panel's `isBlocked`, `blockedUntil` and `failedLoginAttempts` are read (a blocked account cannot sign in) but never written by v1 login.
- **Case-insensitive email index.** `email_case_insensitive` is a non-unique index on `email` with the collation `{ locale: 'en', strength: 2 }`. It is only for lookups, so an older account whose email is not lowercase is still found. Mongoose `autoIndex` (on unless it is turned off) builds it when the server connects. To create it by hand:
  ```js
  db.users.createIndex({ email: 1 }, { name: 'email_case_insensitive', collation: { locale: 'en', strength: 2 } })
  ```
- **Before the first deploy, look for older emails that differ only by case:**
  ```js
  db.users.aggregate([
    { $group: { _id: { $toLower: '$email' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ])
  ```
  Each result is a set of accounts that v1 treats as one address. v1 always uses the oldest one (by `createdAt`, then `_id`), so the others cannot sign in through v1. Merge or rename them first if that matters.
- **Profile fields in v1 formats.** When a user edits their profile, v1 writes `dateOfBirth` as `YYYY-MM-DD`, `preferredLanguage` as a language tag (`en`, `es`, `fr`, `de`, `hi`; the old API stored `English`), and `gender` may be `non_binary` or `prefer_not_to_say`. Values in older formats read as "not set" until the user saves them again.
- **Guests are not users.** A guest (`POST /auth/guest`) is a `guest_accounts` document, one per app install, deleted 180 days after it was last used. It never appears in `users`, and the old `guestusers` collection (the admin panel's "Guest users" page) is left alone. A guest who signs up becomes a normal user, and the guest is deleted.
- **Phone numbers.** v1 writes the existing `phone` and `mobileNumberVerified` fields (plus `phoneVerifiedAt`) when a code is accepted, and clears them when the user removes the number. Only `phoneVerifiedAt` counts as proof: the old API marks every number it saves as verified after a fixed code. So when someone verifies a number through v1, an account that has the same number from the old API loses it, while a number another account verified through v1 is refused (`PHONE_TAKEN`). To see how many numbers this can apply to before the first deploy:
  ```js
  db.users.countDocuments({ phone: { $exists: true }, phoneVerifiedAt: { $exists: false } })
  ```
- **The old `/user/login` and v1 login coexist.** The old login blocks an account for 1 hour after 5 failures by setting `isBlocked`; v1 reports that as 403 `ACCOUNT_SUSPENDED`, and a password reset asked for during that hour sends no code, like any other blocked account's (v1's own lockout is separate: `loginFailedCount`, `loginFailedSince`, `loginLockedUntil`). Once a user signs in through v1, their password hash is upgraded from bcrypt to argon2id, and the old login, which only reads bcrypt, stops working for that user. That is acceptable while there are no live users; the old routes are removed once the app has moved to v1.

---

## 4. Conventions every endpoint follows

- **Errors** use one format (RFC 9457, `application/problem+json`) with a stable `code` from the spec's catalog, for example `VALIDATION_FAILED` or `NOT_FOUND`. 5xx errors never expose internal details.
- **Every response** carries an `X-Request-Id`. Quote it when reporting a bug.
- **Request checks:** every `/v1` request is checked against the spec before any handler runs. Invalid input gets a 400 or 422 with field-level `errors[]`.
- **Logs** never contain passwords, tokens, codes or query strings.
- **Security:**
  - `helmet` headers;
  - CORS limited to an allowlist (`CORS_ORIGINS`), while mobile apps (no `Origin` header) are always allowed;
  - HTTPS in deployed environments.
- **Authentication** (`src/middleware/requireAuth.js`):
  - Bearer tokens only. `requireAuth` answers 401 with a stable code: `UNAUTHENTICATED` (no token), `TOKEN_EXPIRED` or `TOKEN_INVALID`, or `SESSION_REVOKED` (the session was signed out). It checks the token's session on every request, so signing a device out takes effect at once.
  - Access tokens last 15 minutes. Refresh tokens work once: every refresh returns a new pair. Using an old refresh token again signs the whole session out (reuse detection), except a retry from the same install within 30 seconds, which gets the same new pair.
  - `POST /v1/auth/logout` always answers 204. `GET` and `DELETE /v1/me/sessions` list and sign out devices.
- **Rate limits** (`src/middleware/rateLimit.js`): 429 `RATE_LIMITED` with `Retry-After` and a `RateLimit` header. The limits are the ones in each operation's `x-rate-limit` in the spec: token refresh, email availability (30 an hour per IP, 20 per install), starting sign-up (20 per IP, 10 per install), checking a code (60 per IP) and login (50 per IP). The limits the spec lists per address, code or account are kept by the services instead: 5 codes per address per day, one resend per 30 seconds, 5 guesses per code, and the login lockout (below). The spec has no 429 on logout or the session operations, so they have no limiter.
  - Counters are in MongoDB, so every instance shares them; keys are hashed first. IPv6 clients are counted by their /64 prefix.
  - If the counters can't be reached (or don't answer within 2 seconds), the request is allowed and a warning is logged.
  - **`TRUST_PROXY`** is the number of proxies in front of the API (0 for none) and decides which IP address is used. It must be set outside development and test; `X-Forwarded-For` is ignored unless it is set above 0.
- **Idempotency** (`src/middleware/idempotency.js`): an operation that lists the `Idempotency-Key` header keeps its first response for 24 hours and replays it on a retry; the same key with a different body is 422, and a retry while the first request is still running is 409. The stored body is encrypted (it can hold tokens) and the key is stored hashed. Starting sign-up, resending a code and completing sign-up use it, so a retry on a bad connection never sends two codes or makes two accounts.
- **Passwords** (`src/lib/passwords.js`):
  - the policy is the spec's: 12 to 128 characters with an uppercase letter, a digit and a symbol (no lowercase needed; any Unicode works; NFKC-normalised, never truncated). A password that breaks it gets 422 `VALIDATION_FAILED` whose `errors[0]` is `PASSWORD_POLICY_VIOLATION` with every broken rule in `meta.unmetRules` (`min_length`, `max_length`, `uppercase`, `digit`, `symbol`);
  - new passwords are hashed with **argon2id** (19 MiB, 2 passes, 1 lane; `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST` and `ARGON2_PARALLELISM` change it). The settings live inside each hash, so changing them never breaks existing ones;
  - **older bcrypt hashes still work.** After a good login the stored hash is replaced by an argon2id one;
  - an unknown email, and an account with no password hash this API can read, are checked against a dummy hash (made when the server starts), so they cost as much as a wrong password.
- **One-time codes** (`src/modules/challenges`): 6 digits from a secure random generator, valid 10 minutes, 5 wrong guesses lock the code, one resend per 30 seconds, 5 codes per address per day. Only a keyed hash is stored, compared in constant time; a code works once and only from the install that asked. Email goes over SMTP (`EMAIL_PROVIDER=smtp`, TLS required outside development and test) or, in development and test only, to the console provider (`LOG_CODES_IN_DEV=true` also prints the code). Staging can use a fixed code for listed tester accounts (`CODE_TEST_MODE`, refused anywhere else).
- **Sign-up and login** (`src/modules/auth`):
  - sign-up is three calls and creates nothing until the last: `POST /v1/auth/signup/email` (code sent), then `POST /v1/auth/challenges/{id}/verify` (returns a one-time `signupToken`, valid 30 minutes, tied to the install), then `POST /v1/auth/signup/complete` (password; creates the account and returns a `Session`). A weak password does not use the token up, so the user can fix it and send again; if the token cannot be made after the code was accepted, the code is given back, so the user can enter it again. `POST /v1/auth/email/availability` is the optional "is this address free?" check;
  - an address that already has an account gets 409 `EMAIL_TAKEN` (compared without regard to case, and against older users too). The availability check and the sign-up start do tell anyone who asks whether an address has an account, which is why they are rate limited;
  - `POST /v1/auth/login`: an unknown email and a wrong password give the same 401 `INVALID_CREDENTIALS`. **Lockout:** every attempt is counted before the password is checked, so guesses sent at the same moment cannot get past the limit; the 5th failure within 15 minutes locks password login for 15 minutes (423 `ACCOUNT_LOCKED` with `Retry-After`, even for the right password). An email with no account is counted and locked in exactly the same way (in `login_attempts`, not on a user), so the answers do not reveal which addresses have accounts. An account an admin blocked gets 403 `ACCOUNT_SUSPENDED`, but only after the right password;
  - `GET /v1/auth/challenges/{id}` and `POST .../resend` work for every code purpose; `verify` only accepts sign-up codes for now.
- **The old `/user/*` routes are still mounted.** The app uses them until it moves to these endpoints; a later cleanup PR removes them.
- **Coming in the next PRs:** password reset, guest sessions, phone verification, and the signed-in profile (`/me`), onboarding progress, consents and interests. Until then `User.onboarding` is worked out from the stored data and `consents` always says nothing was accepted.

---

## 5. Run it locally

```bash
cp .env.example .env      # then fill in MONGODB_URI
npm install
npm start                 # http://localhost:3000
npm test                  # unit and integration tests, no database needed
```

- **Health:** `GET /health` (alive) and `GET /health/ready` (the database is reachable).
- **Spec checks** (CI runs these too):
  ```bash
  npx redocly lint docs/api/openapi.yaml --config docs/api/redocly.yaml
  npx redocly bundle docs/api/openapi.yaml --config docs/api/redocly.yaml -o docs/api/dist/openapi.yaml
  ```
- **Fake API for app work.** This answers exactly as the spec says, so app work never waits for the backend:
  ```bash
  npx @stoplight/prism-cli mock docs/api/dist/openapi.yaml
  ```

---

## 6. Roadmap

| Step | What | Status |
| --- | --- | --- |
| 1 | **Foundation:** structure, config, logging, error format, security headers, CORS, spec validation, health, CI | Done ([#8](https://github.com/bndfdev/api/pull/8)) |
| 2 | **Login tokens and sessions:** access and refresh tokens, `requireAuth`, rate limits | In review ([#9](https://github.com/bndfdev/api/pull/9)) |
| 3 | **Sign-up and login:** email and phone codes, sign-up, login, password reset, guest. Staging has a test mode for codes (fixed code for tester accounts, never in production). | In review: email sign-up and login ([#10](https://github.com/bndfdev/api/pull/10)); password reset, guests and phone (this PR). The SMS provider is still to be chosen. |
| — | **Tester build:** staging server + the app on Android and iOS | After step 3 |
| 4 | **Profile and onboarding:** `/me`, onboarding progress, Terms, interests, photo uploads, `/config`, `/countries` | In review: `/me`, onboarding progress, Terms, `/config`, `/countries` (this PR); interests and photo uploads next |
| 5 | **Social login:** Google and Apple, verified by this server | Planned |

---

## 7. Change log

Newest first. Add a row in the same PR as the change.

| Date | PR | Change |
| --- | --- | --- |
| 2026-10-03 | Profile, onboarding and terms (this PR) | `GET`/`PATCH /v1/me` (ETag and If-None-Match/If-Match; names tidied and checked; date of birth: minimum age 13, one change within 30 days; gender; supported languages; guests can change their language only); `GET /v1/me/onboarding` and `PUT /v1/me/onboarding/steps/{step}` (data steps follow the data, "Later" skips interests and profile, the phone step is skipped when not required); `GET /v1/legal/{type}`, `GET`/`POST /v1/me/consents` (only the live version; new versions ask again; a guest's consents move to its account), with the documents in `content/legal.js` (placeholder text and links for now); `GET /v1/config` (built from the rules the server enforces) and `GET /v1/countries` (every country, localised, with dial code, flag and example); builds below the minimum version get 426 `UPGRADE_REQUIRED`; `LANGUAGE_UNSUPPORTED` and the guest-mode switch; `Session.user` now carries real consents and onboarding; `PRECONDITION_FAILED` added to the error catalog; new collection `consents`, new optional `users` fields (see `docs/DB_CHANGES.md`); new env vars `APP_MIN_VERSION_*`, `APP_LATEST_VERSION_*`, `GUEST_MODE`, `PHONE_VERIFICATION_REQUIRED`, `CONTENT_REGIONS`, `DEFAULT_COUNTRY_CODE`. |
| 2026-10-03 | Password reset, guests and phone (PR 4) | `POST /v1/auth/password-reset` (always 202; a decoy for unknown, password-less or blocked accounts) and `/password-reset/complete` (single-use `resetToken`, 15 minutes; refuses the current password; clears the login lock; signs out every device; emails a "password changed" notice); `POST /v1/auth/guest` (one guest per install, date of birth checked against the minimum age of 13 on the person's local date), guest tokens (`act: "guest"`) refused on account-only endpoints with 403 `GUEST_NOT_ALLOWED`, and guest-to-account at `/auth/signup/complete`; `POST /v1/me/phone/verification` and `DELETE /v1/me/phone` (E.164 numbers checked with libphonenumber-js; landline, premium-rate and similar numbers refused; the code is verified with the owner's token; only a code accepted here proves a number, so one saved by the old API goes to whoever verifies it); masked numbers show the country code; new collections `reset_tokens` and `guest_accounts`, new optional `users.phoneVerifiedAt` and `sessions.accountType` (see `docs/DB_CHANGES.md`); new env vars `PHONE_REGIONS` and `PHONE_REFUSE_VOIP`. |
| 2026-10-03 | [#10](https://github.com/bndfdev/api/pull/10) Email sign-up and login | One-time code challenges (6 digits, 10 minutes, 5 guesses, 30-second resend, 5 per address per day) with SMTP and console email providers, an SMS console provider and a staging-only fixed-code test mode; `POST /v1/auth/email/availability`, `/auth/signup/email`, `GET /auth/challenges/{id}`, `/resend`, `/verify`, `/auth/signup/complete` and `/auth/login`; one-time `signupToken` (30 minutes); passwords hashed with argon2id (bcrypt hashes from the old API still work and are upgraded at login); login lockout (5 failures in 15 minutes lock it for 15 minutes) kept apart from the admin panel's block; password-policy and email errors in the spec's shape; rate limits from the spec; new collections `challenges`, `code_send_logs`, `signup_tokens`, `login_attempts`; new optional `users` fields and a non-unique `email_case_insensitive` index (nothing renamed or removed, see "Database notes"); new env vars `CODE_HMAC_KEY` (required outside development and test), `EMAIL_PROVIDER`, `SMTP_*`, `SMS_PROVIDER`, `CODE_TEST_*`, `LOG_CODES_IN_DEV` and `ARGON2_*`, see `.env.example`. The old `/user/*` routes stay until the app has moved over. |
| 2026-10-02 | [#9](https://github.com/bndfdev/api/pull/9) Tokens and sessions | Access tokens (ES256, 15 minutes) and single-use refresh tokens with reuse detection and a 30-second retry window; `requireAuth` (and `optionalAuth`); `POST /v1/auth/token/refresh`, `POST /v1/auth/logout`, `GET` and `DELETE /v1/me/sessions`, `DELETE /v1/me/sessions/{sessionId}`; rate limiting on token refresh (counters in MongoDB; `TRUST_PROXY` must be set outside development and test); `Idempotency-Key` middleware with encrypted stored responses (no operation uses it yet); new collections `sessions`, `refresh_tokens`, `refresh_grace`, `idempotency_keys`, `rate_limits`; signing keys (`JWT_*`, `TOKEN_ENC_KEY`) are required outside development and test, see `.env.example`. |
| 2026-10-02 | [#8](https://github.com/bndfdev/api/pull/8) Foundation | `src/` structure (`app.js`, `server.js`, `config.js`); pino logging with request IDs and redaction; RFC 9457 errors; helmet, CORS allowlist; OpenAPI validation on `/v1`; `/health/ready`; CI (tests, spec lint, bundle check); `METHOD_NOT_ALLOWED` added to the error catalog; this guide. Existing routes unchanged. |
| 2026-09-28 | [#7](https://github.com/bndfdev/api/pull/7) | OpenAPI 3.1 spec for onboarding and accounts (49 operations). |
| 2026-09-27 | [#6](https://github.com/bndfdev/api/pull/6) | Stopped logging tokens and request bodies; CI moved to Node 22; auth regression tests. |
