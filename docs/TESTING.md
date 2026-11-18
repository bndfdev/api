# Testing the API

How this repo is tested, what has to pass before a PR is merged, and how to write a new test. If you only read one
section, read **"Before you open a PR"**.

## Before you open a PR

Every PR has to pass these, locally and in CI (`.github/workflows/ci.yml`, on every pull request):

| Check | Command | What it catches |
| --- | --- | --- |
| Unit and integration tests | `npm test` | Broken behaviour, broken responses, broken rules |
| Spec lint | `npx redocly lint docs/api/openapi.yaml --config docs/api/redocly.yaml` | An invalid OpenAPI spec |
| Bundled spec is current | `npx redocly bundle docs/api/openapi.yaml --config docs/api/redocly.yaml -o docs/api/dist/openapi.yaml` and commit the result | Changing `docs/api/**` without regenerating `docs/api/dist/openapi.yaml` (CI diffs the two and fails) |

Also, for any PR that changes behaviour:

- **New or changed endpoint:** tests for the success case **and** every error code the spec lists for it.
- **Database change:** an entry in `docs/DB_CHANGES.md` (and a migration if an existing index or document changes).
- **Change log:** a row in `docs/ONBOARDING.md` §7.

## How the tests run

- **Runner:** Node's built-in test runner (`node --test`), no Jest or Mocha. `npm test` runs every `test/**/*.test.js`.
- **HTTP:** `supertest` calls the real Express app (`createApp()` from `src/app.js`) in memory: no port, no network.
- **Database:** `test/support/db.js` starts an **in-memory MongoDB** (`mongodb-memory-server`, a one-member replica
  set so transactions work). Every test file that needs a database does:

  ```js
  before(db.connect); beforeEach(db.clear); after(db.disconnect);
  ```

  Tests **never** connect to the shared or dev database.
- **Node:** 22 (same as CI). MongoDB for tests: `MONGOMS_VERSION=8.2.6` (CI pins it; the first local run downloads it).

## What we test, and how

### 1. Responses must match the spec
The OpenAPI spec (`docs/api/openapi.yaml`) is the contract with the app.
- Every `/v1` request goes through `express-openapi-validator` in the app itself, so a test that sends an invalid
  body gets the same `400`/`422` a real client would.
- Tests also check **responses** against the spec's schemas with Ajv (a small `assertMatchesSpec('Session', res.body)`
  helper at the top of the test file; copy it from `test/credentials.test.js`), and
  errors with `assertProblem(res, status, code)` from `test/support/api.js`: the right status, the right `code`, the
  `application/problem+json` type and the request id.
- Branch on error **codes** (`SOCIAL_TOKEN_INVALID`), never on titles or wording.

### 2. Every rule, both ways
For each endpoint: the happy path, each documented error, and the edges the spec calls out (expired, reused, wrong
account, missing field, rate limit, idempotent retry). Example: `test/passwordReset.test.js` covers the reset end to
end, an unknown email (same answer, nothing sent), a weak or reused new password, and a token that works only once,
only from its install and only for 15 minutes.

### 3. No real outside services
Email, SMS, storage, outside providers and the clock are **injected**, so tests use fakes:
- email: `src/providers/email/memory.js` (read the sent codes from it);
- other providers (for example Google or Facebook sign-in checks): pass a fake function, a locally generated key, or
  a stubbed `fetch`, never the real service;
- time: services take a `now` function, so tests move a fake clock instead of waiting.

### 4. Helpers
- `test/support/api.js`: `CLIENT` (the headers every `/v1` call needs), `DEVICE`, `makeUser()`, `signIn(user)` (a
  real session and its `Authorization` header) and `assertProblem()`.
- `test/support/db.js`: the in-memory database.
- `test/fixtures/`: sample images (banner colour tests).

### 5. Mutation check (for important logic)
After writing tests for new logic, plant 5 or more likely bugs **one at a time** (flip a condition, drop a check,
skip a write), run the tests, and confirm each one makes a test fail. Put the score in the PR description ("mutation
check 7/7"). If a planted bug survives, that is a missing test: add it. Restore the file exactly afterwards.

## Where the tests are

| Area | Files |
| --- | --- |
| Sign-up, login, codes, password reset, guests, phone | `signupLogin`, `challenges`, `passwordReset`, `guest`, `phone`, `credentials`, `emailChange`, `emailSuggestion` |
| Sessions and tokens | `sessions`, `sessionsApi`, `tokens`, `secrets`, `passwords` |
| Profile and settings | `profile`, `settings`, `media`, `palette`, `interests`, `content`, `handPicked`, `usersService`, `backfillPalette` |
| Platform and safety | `app`, `v1` (routing, 404s), `security`, `rateLimit`, `idempotency`, `trustProxy`, `allowedMethods`, `config`, `logger`, `auth-logging`, `legal`, `meta`, `providers` |

(all under `test/`, named `<area>.test.js`).

## Running tests

```bash
npm ci                                  # once, or after package changes
npm test                                # everything
node --test test/profile.test.js        # one file
node --test --test-name-pattern="reset token" test/passwordReset.test.js   # matching tests in one file
node --test --test-reporter=spec test/profile.test.js              # readable output
```

## Rules we learned the hard way

- **No fixed timings.** A test like "takes at least 10 ms" passed locally and failed on the faster CI machine.
  Compare against a reference measured in the same run, or use the fake clock.
- **mongodb-memory-server hangs silently?** A download was interrupted and left a lock. Delete
  `~/.cache/mongodb-binaries/*.lock` and any `.downloading` file, then run again (from the repo folder).
- **One database per test file**, cleared before each test: never depend on another test's data or order.
- **Never log or assert secrets** (tokens, passwords, codes) in test output; the logger redacts them and tests check it
  (`auth-logging.test.js`, `logger.test.js`).
