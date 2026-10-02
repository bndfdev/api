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
- `rate_limits`: rate-limit counters.

**Why this shape:**
- Every feature looks the same, so it's easy to find things.
- Features can be built in parallel without touching the same files.
- Rules can be tested without a server or a database.

**Outside services** (email, SMS, file storage, Google/Apple sign-in) sit behind small adapters. Each adapter has a fake version for development and tests, so nothing real is sent while developing.

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
- **Rate limits** (`src/middleware/rateLimit.js`): 429 `RATE_LIMITED` with `Retry-After` and a `RateLimit` header. Only token refresh is limited so far (the spec has no 429 on logout or the session operations); sign-up and code endpoints get their limits from the spec when they land.
  - Counters are in MongoDB, so every instance shares them; keys are hashed first. IPv6 clients are counted by their /64 prefix.
  - If the counters can't be reached (or don't answer within 2 seconds), the request is allowed and a warning is logged.
  - **`TRUST_PROXY`** is the number of proxies in front of the API (0 for none) and decides which IP address is used. It must be set outside development and test; `X-Forwarded-For` is ignored unless it is set above 0.
- **Idempotency** (`src/middleware/idempotency.js`): an operation that lists the `Idempotency-Key` header keeps its first response for 24 hours and replays it on a retry; the same key with a different body is 422, and a retry while the first request is still running is 409. The stored body is encrypted (it can hold tokens) and the key is stored hashed. No operation uses it yet; sign-up and the code endpoints will.
- **Coming in the next PRs:**
  - passwords hashed with argon2id;
  - one-time codes generated securely and stored hashed.

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
| 1 | **Foundation:** structure, config, logging, error format, security headers, CORS, spec validation, health, CI | In review ([#8](https://github.com/bndfdev/api/pull/8)) |
| 2 | **Login tokens and sessions:** access and refresh tokens, `requireAuth`, rate limits | In review |
| 3 | **Sign-up and login:** email and phone codes, sign-up, login, password reset, guest. Staging has a test mode for codes (fixed code for tester accounts, never in production). | Next |
| — | **Tester build:** staging server + the app on Android and iOS | After step 3 |
| 4 | **Profile and onboarding:** `/me`, onboarding progress, Terms, interests, photo uploads, `/config`, `/countries` | Planned |
| 5 | **Social login:** Google and Apple, verified by this server | Planned |

---

## 7. Change log

Newest first. Add a row in the same PR as the change.

| Date | PR | Change |
| --- | --- | --- |
| 2026-10-02 | Tokens and sessions (this PR) | Access tokens (ES256, 15 minutes) and single-use refresh tokens with reuse detection and a 30-second retry window; `requireAuth` (and `optionalAuth`); `POST /v1/auth/token/refresh`, `POST /v1/auth/logout`, `GET` and `DELETE /v1/me/sessions`, `DELETE /v1/me/sessions/{sessionId}`; rate limiting on token refresh (counters in MongoDB; `TRUST_PROXY` must be set outside development and test); `Idempotency-Key` middleware with encrypted stored responses (no operation uses it yet); new collections `sessions`, `refresh_tokens`, `refresh_grace`, `idempotency_keys`, `rate_limits`; signing keys (`JWT_*`, `TOKEN_ENC_KEY`) are required outside development and test, see `.env.example`. |
| 2026-10-02 | [#8](https://github.com/bndfdev/api/pull/8) Foundation | `src/` structure (`app.js`, `server.js`, `config.js`); pino logging with request IDs and redaction; RFC 9457 errors; helmet, CORS allowlist; OpenAPI validation on `/v1`; `/health/ready`; CI (tests, spec lint, bundle check); `METHOD_NOT_ALLOWED` added to the error catalog; this guide. Existing routes unchanged. |
| 2026-09-28 | [#7](https://github.com/bndfdev/api/pull/7) | OpenAPI 3.1 spec for onboarding and accounts (49 operations). |
| 2026-09-27 | [#6](https://github.com/bndfdev/api/pull/6) | Stopped logging tokens and request bodies; CI moved to Node 22; auth regression tests. |
