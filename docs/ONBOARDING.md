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
  - `node:test` + `supertest`: tests.

```
src/
  app.js            builds the Express app (used by the server and the tests)
  server.js         connects to MongoDB, starts listening, shuts down cleanly
  config.js         reads and checks environment variables at startup
  lib/              shared tools (logger, error format, ...)
  middleware/       security, spec validation, error handler
  modules/<feature>/
    routes.js       HTTP only: reads the request, sends the response
    service.js      the rules (e.g. how long a code is valid)
    repo.js         the only place that talks to the database
models/             Mongoose models
test/               automated tests
docs/api/           the API spec
```

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
- **Login** (coming in the next PRs):
  - short-lived access tokens plus refresh tokens that are replaced on every use;
  - passwords hashed with argon2id;
  - one-time codes generated securely and stored hashed;
  - rate limits on sensitive endpoints.

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
| 1 | **Foundation:** structure, config, logging, error format, security headers, CORS, spec validation, health, CI | In review |
| 2 | **Login tokens and sessions:** access and refresh tokens, `requireAuth`, rate limits | Next |
| 3 | **Sign-up and login:** email and phone codes, sign-up, login, password reset, guest. Staging has a test mode for codes (fixed code for tester accounts, never in production). | Planned |
| — | **Tester build:** staging server + the app on Android and iOS | After step 3 |
| 4 | **Profile and onboarding:** `/me`, onboarding progress, Terms, interests, photo uploads, `/config`, `/countries` | Planned |
| 5 | **Social login:** Google and Apple, verified by this server | Planned |

---

## 7. Change log

Newest first. Add a row in the same PR as the change.

| Date | PR | Change |
| --- | --- | --- |
| 2026-10-02 | Foundation (this PR) | `src/` structure (`app.js`, `server.js`, `config.js`); pino logging with request IDs and redaction; RFC 9457 errors; helmet, CORS allowlist; OpenAPI validation on `/v1`; `/health/ready`; CI (tests, spec lint, bundle check); `METHOD_NOT_ALLOWED` added to the error catalog; this guide. Existing routes unchanged. |
| 2026-09-28 | [#7](https://github.com/bndfdev/api/pull/7) | OpenAPI 3.1 spec for onboarding and accounts (49 operations). |
| 2026-09-27 | [#6](https://github.com/bndfdev/api/pull/6) | Stopped logging tokens and request bodies; CI moved to Node 22; auth regression tests. |
