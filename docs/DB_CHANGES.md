# Database change record

Every change this API makes to the MongoDB database is recorded here, in the same PR that makes it, so there is a clear audit trail. Each entry needs a review by the database owner before the PR is merged and before the code runs against any shared database.

**How changes are applied:** Mongoose creates new collections on first write, and builds the indexes declared in `models/` when the server starts (`autoIndex`). Nothing here runs a migration script or edits existing documents unless an entry says so.

**Adding an entry:** newest first. List every collection, field and index the PR adds or changes; say whether existing data is affected; give a rollback; leave "Reviewed by" for the database owner.

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

