# Database change record

Every change this API makes to the MongoDB database is recorded here, in the same PR that makes it, so there is a clear audit trail. Each entry needs a review by the database owner before the PR is merged and before the code runs against any shared database.

**How changes are applied:** Mongoose creates new collections on first write, and builds the indexes declared in `models/` when the server starts (`autoIndex`). Nothing here runs a migration script or edits existing documents unless an entry says so.

**Adding an entry:** newest first. List every collection, field and index the PR adds or changes; say whether existing data is affected; give a rollback; leave "Reviewed by" for the database owner.

---

## 2026-11-20: Artist pages and following artists

**Existing data affected:** none. Nothing in existing documents is written; `contents` and `users` are only read. Everything else below is new: one new collection.

**New collection**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `follows` | One account following an artist (`PUT /v1/me/following/artists/{id}`): `followerId` (`users` id), `artistId` (`users` id of an account that has published a song), `followedAt` | `follower_artist` `{followerId: 1, artistId: 1}` unique (an artist once per follower; following twice at once stores one row; "does the viewer follow this artist"; how many artists an account follows, by its prefix); `artist_followers` `{artistId: 1, followedAt: -1, _id: -1}` (how many accounts follow an artist, by its prefix; also ready for a followers list, newest first, read by key) | Unfollowing deletes the row. Account deletion (not built) must delete the rows where the account is the follower or the artist. Rows of an account that is no longer an artist stay until the follower unfollows (which always works); they still count in its `followerCount` if it publishes again. About 100 bytes per row; at most 60 follows a minute per account. |

**What the reads use:** the page reads the account from `users` by `_id` (projection `{name, avatar, banner}`); "has this account published a song" is one `contents` `exists({ownerId, type: 'song'})` (the `owner_recent` index, by `ownerId`); the releases are `contents` `{ownerId, type: {$in: ['album', 'song']}, hidden: {$ne: true}}` sorted `{createdAt: -1, _id: -1}` with a limit of 200 (`owner_recent`, no sort in memory); the albums' song counts and plays are one `$group` over `contents` `{albumId: {$in}, ownerId, type: 'song'}` (`album_order`); the songs' albums by `_id`. The two follow counts are `countDocuments` on `follows` (each on an index prefix), one per page view: fine at today's sizes; an artist with very many followers would want a stored counter later (a `users` field, which would be a new entry here). Nothing is written to `users` or `contents`.

**Writes and concurrency:** one `insertOne` per follow (a duplicate-key error from `follower_artist` means "already followed", and the first `followedAt` is kept) and one `deleteOne` per unfollow. No transactions, no counters.

**Rollback:**
- Stop the new code.
- Drop `follows`.

**Reviewed by:** _pending (database owner)_

---

## 2026-11-17: Google and Facebook identities and account-link tokens

**Existing data affected:** existing user documents are unchanged. Migration 16
(`migrations/migrate_16_social_identities.js`) replaces the existing `users.email_1` unique index with a sparse unique index of
the same name, and adds the identity and link-token indexes below. The migration
must run before accepting social accounts without email; Mongoose `autoIndex`
does not replace an existing non-sparse index. This migration has not been run
against any shared database.

**`users`: optional email/password and a new optional field**

| Field | Purpose |
| --- | --- |
| `email`, `password` | These existing string fields are now optional in the API model. A social-only account has no password; a provider without a verified email creates an account with the email field absent, never an invented address or a shared null value. Existing values retain their types and meanings. |
| `socialIdentities` | Array of `{provider, providerUserId, email?, linkedAt}`. The provider user ID comes only from server verification. The optional email is the provider's verified address. The array records linked sign-in methods; no provider credential is stored. |

**`users`: indexes**

- `email_1`: `{email: 1}`, unique and sparse. Existing email uniqueness remains;
  multiple documents without the field are allowed. The case-insensitive lookup
  index remains unchanged.
- `social_identity_unique`: `{'socialIdentities.provider': 1,
  'socialIdentities.providerUserId': 1}`, unique, with partial filter
  `{'socialIdentities.providerUserId': {$type: 'string'}}`. A provider identity
  cannot belong to two users, including when sign-ins race. Atomic repository
  updates also prevent adding the same identity twice to one user's array.

**New collection: `link_tokens`**

- Stores `tokenHash` (unique), `userId`, the verified identity payload and
  `expiresAt`. The opaque link token returned in `ACCOUNT_LINK_REQUIRED` is
  stored only as a hash, never in plaintext.
- A TTL index on `expiresAt` (`expireAfterSeconds: 0`) cleans up ten-minute
  tokens. Requests check expiry themselves; TTL cleanup is not an authorization
  check.
- Linking with a token atomically consumes it and adds the identity in a
  transaction, so it is single use and accepted only for the intended user.
  A MongoDB replica set is required for this flow (as in the local test helper).

**Rollback:** stop social login and linking before rolling back code. Existing
email/password accounts remain readable by older code. Social-only accounts
require a data decision before returning to the old required-email/password
model: do not invent credentials. In particular, restoring the non-sparse email
index requires resolving multiple documents with an absent email first. The
optional identity array and `link_tokens` collection can remain until the
database owner approves removing them; do not remove identities while accounts
depend on them to sign in.

**Reviewed by:** _pending (database owner)_

---

## 2026-11-13: Media player, step 3: comments on songs (comments, replies, comment likes)

**Existing data affected:**
- **`contents.commentCount` (step 1's optional field) is now written, only on songs**, by posting and deleting comments (`POST /v1/songs/{id}/comments`, `POST /v1/comments/{id}/replies`, `DELETE /v1/comments/{id}`): one `updateOne({_id, type: 'song'}, [pipeline])` per change, adding or taking away the number of comments and replies stored or deleted, in one atomic step that never goes below 0 (`$max: [0, $add: [current, delta]]`; a value that is not a number counts as 0, so the field is created at the first comment). Written with `timestamps: false`: the song's `updatedAt` does not move. Nothing else in existing documents changes. No migration: every song stored today has no comments and reads as 0.
- Everything else below is new: two new collections.

**New collections**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `comments` | A comment on a song or a reply to one: `songId` (`contents` id), `parentId` (the top-level comment for a reply, `null` for a top-level comment; replies are one level deep), `authorId` (`users` id), `text` (trimmed, 1 to 500 characters), `likeCount` and `replyCount` (counters, see below), `createdAt` | `song_thread` `{songId: 1, parentId: 1, createdAt: -1, _id: -1}`: one index serves a song's top-level comments newest first (`{songId, parentId: null}`), a comment's replies oldest first (`{songId, parentId}`, the index read backwards), the count of a song's top-level comments, its newest top-level comment (`Song.latestComment`, one lookup per song) and the replies deleted with their comment. Both page orders end in `_id`, so pages are read by key and no sort happens in memory. Comments are read by `_id` otherwise. | Deleting a comment deletes the row; deleting a top-level comment deletes its replies (`{songId, parentId}` ids, then `deleteMany({_id: {$in}})`). Account deletion (not built) must delete or anonymise the user's comments (no index by author yet: one would be added with that feature). Rows whose song no longer exists are not shown (nothing deletes songs yet). About 300 bytes per comment plus its text; at most 10 posts a minute per account. |
| `comment_likes` | One like of a comment or a reply: `commentId`, `userId`, `createdAt` | `comment_user` `{commentId: 1, userId: 1}` unique (a comment liked once per user; liking twice at once stores one row; "which of these comments did the viewer like" for a page, one `{commentId: {$in}, userId}` read; a deleted comment's likes) | Unliking deletes the row; deleting a comment (and a top-level comment's replies) deletes their likes. Account deletion must delete the user's rows (no index by user yet, as above). About 100 bytes per like. |

**Counters and concurrency:** `contents.commentCount` (every comment on the song, replies included), `comments.replyCount` (a top-level comment's replies) and `comments.likeCount` are changed only by atomic update pipelines (the same `$max: [0, ...]` step), never read and written back. Each moves up **before** its row is inserted and down only **after** a row was really deleted (by `deletedCount`), so with posts, likes and deletes running at once a counter is never below the real number and settles on it; a failed insert puts it back. No transactions (nothing else in this API uses them). A reply inserted while its top-level comment was being deleted is found by the replying request (it checks the comment still exists after inserting) and deleted again, so no reply outlives its comment; a like likewise. If the server stops between two of these writes, a counter can be left one too high (never too low).

**What the reads use:** a song and its album by `_id` (`contents`, as before); comment authors from `users` by `_id` with the projection `{name, avatar}`, one query per page; the viewer's likes, one `comment_likes` query per page. Nothing is written to `users`.

Locally, `tools.local/e2e/seed_player.js` (not in this repo) writes demo comments, replies and likes marked `seed: 'player'` (and two demo `users` accounts with invented names, also marked), and refuses any non-localhost database.

**Rollback:**
- Stop the new code.
- Drop `comments` and `comment_likes`.
- `contents.commentCount` can stay (step 1's code reads it as the count), or be cleared with `db.contents.updateMany({type: 'song'}, { $unset: { commentCount: '' } })` (it then reads as 0).

**Reviewed by:** _pending (database owner)_

---

## 2026-11-13: Media player, step 2: the library (likes, library playlists, Add to Playlist)

**Existing data affected:**
- **`contents.songCount` (an existing field) is now written, only on playlists**, by Add to Playlist (`PUT /v1/me/library/songs/{id}/playlists`): each playlist the request changes gets its number of `playlist_items` after the change, in one `bulkWrite` of `updateOne({_id, type: 'playlist'}, {$set: {songCount, songsUpdatedAt}})`. The model's timestamps also move those documents' `updatedAt`. Only playlists of the requesting account are written; nothing else in existing documents changes. No migration.
- **`playlist_items` (step 1's collection) is now written** by the same request: one row inserted per playlist the song goes into (after the playlist's highest `position`), one row deleted per playlist it leaves. Nothing else writes there.
- Everything else below is new: one optional field on playlists and three new collections.

**`contents`: new optional field** (no default; absent reads as before)

| Field | On | Purpose |
| --- | --- | --- |
| `songsUpdatedAt` | playlists | Date: when Add to Playlist last added a song to or took one out of the playlist. The player's `updatedAt` for a playlist is the later of this and its newest item's `addedAt` (its creation while it has neither); the document's own `updatedAt` is not used, as it moves with any change (Hide Content too). |

**New collections**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `song_likes` | One song a user liked: `userId`, `songId` (`contents` id), `likedAt` | `user_song` `{userId: 1, songId: 1}` unique (a song once per user; liking twice at once stores one row; "which of these songs did the viewer like" for every `Song`); `user_liked` `{userId: 1, likedAt: -1, _id: -1}` (Liked songs pages, newest first, by key) | Unliking deletes the row. Account deletion (not built) must delete the user's rows; a deleted song's rows are left out when read. About 100 bytes per like. |
| `library_entries` | What a user's library keeps about a playlist or Liked songs: `userId`, `kind` (`playlist` or `liked_songs`), `playlistId` (null for Liked songs), `savedAt` (playlists: when saved, or an own playlist's creation), `playedAt` (newest play from it), `unlikedAt` (Liked songs: the last unlike) | `user_playlist` `{userId: 1, playlistId: 1}` unique (one row per playlist per user, and one Liked songs row, whose `playlistId` is null) | A row is made when an own playlist or Liked songs is first played from, or a song is first unliked; saved playlists' rows would be made by saving, which v1 does not specify yet (locally, `tools.local/e2e/seed_player.js` writes some). Rows are only updated with `$max` (times never move back). Account deletion must delete the user's rows; rows whose playlist is gone are left out when read. |
| `library_locks` | One account's Add to Playlist lock while its writes run (a few milliseconds): `_id` (the account's id), `owner` (a random value of the request holding it), `expiresAt` | `expires` `{expiresAt: 1}` TTL (`expireAfterSeconds: 0`) | Deleted by the request when it ends; a lock left by a crash is taken over after its 10-second lease and removed by the TTL monitor soon after. At most one small document per account, usually none. |

**What the new reads use:** a user's playlists are `contents` `{ownerId, type: 'playlist'}` (the existing `owner_recent` index, by `ownerId`); saved playlists and songs by `_id`; a playlist's size and newest item are one `$group` over `playlist_items` `{playlistId: {$in}}` (`playlist_song` or `playlist_order`); which of the user's playlists hold a song is `{playlistId: {$in}, songId}` (`playlist_song`); a playlist's last position is one `playlist_order` lookup read backwards. The account's creation time is read from `users` by `_id` (projection `{createdAt}`); nothing is written to `users`.

**Writes and concurrency:** no transactions (nothing else in this API uses them). Add to Playlist validates every id first, then runs under the account's lock: it inserts and deletes items in one unordered `bulkWrite` (the `playlist_song` unique index refuses a duplicate), then writes the counts. If any of that fails, it deletes what it inserted, puts back what it deleted (same `_id`, `position` and `addedAt`) and restores `songCount` and `songsUpdatedAt`, then answers 500.

Locally, `tools.local/e2e/seed_player.js` (not in this repo) writes demo rows marked `seed: 'player'` into these collections too, and refuses any non-localhost database.

**Rollback:**
- Stop the new code.
- Drop `song_likes`, `library_entries` and `library_locks`.
- `songsUpdatedAt` can stay (nothing else reads it), or be removed with `db.contents.updateMany({type: 'playlist'}, { $unset: { songsUpdatedAt: '' } })`.
- `playlist_items` rows added or removed by Add to Playlist, and the `songCount` values it wrote, stay as they are (they are users' own playlists; there is no record of the previous state to go back to).

**Reviewed by:** _pending (database owner)_

---

## 2026-11-13: Media player, step 1: listening (songs, albums, playlists, transcripts, listens)

**Existing data affected:**
- **`contents.listens` (an existing field) is now written**, only on songs: each listen that counts (`POST /v1/me/listens`, 30 seconds played or played to the end) adds 1, with one `bulkWrite` of `updateOne({_id, type: 'song'}, {$inc: {listens: n}})` per batch, right after its events are stored. Nothing else in existing documents changes. No migration.
- Everything else below is new: optional fields that nothing stored today has (every existing item reads as before: a song with no `audio` is described with `playable: false`), one new index, and three new collections.

**`contents`: new optional fields** (no defaults, so documents created through the model do not get them; the player reads values in another shape as their defaults)

| Field | On | Purpose |
| --- | --- | --- |
| `audio` | songs | `{key, mimeType, sizeBytes, durationMs, status, uploadedAt}`: the audio file by storage key (never an address), its type, size and length, and `status` `processing`, `ready` or `failed`. The player streams it only when `ready` (`GET /v1/songs/{id}/playback` builds the address from the key). |
| `waveform` | songs | Array of numbers from 0 to 1 (128, made when the audio is processed): the seek bar's loudness. |
| `transcriptLanguages` | songs | Array of language tags with a transcript in `transcripts`, the original first. Kept in step with `transcripts` by whatever writes them. |
| `albumId`, `trackNumber` | songs | The album the song is on (an ObjectId of a `contents` item of type `album`, same owner) and its place there (1, 2, ...). |
| `commentCount` | songs | Integer counter for the comments (step 3 writes it); absent reads as 0. |
| `image.palette`, `image.blurhash` | songs, albums, playlists | The artwork's colours (`{version, seed, accent, neutral}`, as for avatars) and BlurHash, inside the existing `image` sub-document. Worked out when the artwork is stored; absent reads as `null`. |

**`contents`: new index**

| Name | Keys | Options | Serves |
| --- | --- | --- | --- |
| `album_order` | `{albumId: 1, trackNumber: 1, _id: 1}` | partial: `{albumId: {$exists: true}}` (only songs on an album are in it) | `GET /v1/albums/{id}`: `{albumId, ownerId, type: 'song'}` sorted by `trackNumber`, `_id`. Nothing stored today has `albumId`, so it builds empty. |

The other player reads of `contents` are by `_id` (`{_id: {$in: [...]}}`, at most 50 ids for `GET /v1/songs`, or a playlist's song ids), served by the existing `_id` index. The player also reads `users` by `_id` with the projection `{name, avatar}` (artists and playlist owners), and writes nothing there.

**New collections**

| Collection | Holds | Indexes | Clean-up |
| --- | --- | --- | --- |
| `playlist_items` | A playlist's songs: `playlistId` and `songId` (`contents` ids), `position` (number; a song added later gets a higher one), `addedAt` | `playlist_song` `{playlistId: 1, songId: 1}` unique (a song once per playlist); `playlist_order` `{playlistId: 1, position: 1, _id: 1}` (paging) | None yet. Read only in this step (nothing in v1 writes it; Add to Playlist, step 2, will). Whatever deletes playlists or songs later (account deletion) must delete their items. |
| `transcripts` | A song's timed words in one language: `songId`, `language` (tag), `translatedFrom` (the original's tag for a translation, `null` for the original), `lines` (each `{words: [{text, startMs, endMs}]}` or `{text, startMs, endMs}`; the model refuses blank text and times that go back), `updatedAt` | `song_language` `{songId: 1, language: 1}` unique | None yet. Read only in this step (no upload endpoint). |
| `listens` | One reported listen: `listenerId` (a `users` or `guest_accounts` id) and `listenerType` (`user` or `guest`), `songId`, `listenedMs`, `completed`, `endedAt` (the device's time), `source` (`{type, id}` or null), `counted` (met the counting rule), `receivedAt` | `listener_song_end` `{listenerId: 1, songId: 1, endedAt: 1}` unique: a resend is refused by the index and so never counted twice | **None yet: retention is an open question** (`docs/api/PLAYER.md`). A TTL on `receivedAt` can be added once decided; it must be longer than the 30 days an event is accepted, or a late resend would count again. Grows by one small document (about 200 bytes) per listen, at most 50 per request and 60 requests a minute per listener. |

Locally, `tools.local/e2e/seed_player.js` (not in this repo) writes demo rows marked `seed: 'player'` into these collections and `contents`, and refuses any non-localhost database.

**Rollback:**
- Stop the new code.
- Drop `playlist_items`, `transcripts` and `listens`.
- Drop the `album_order` index: `db.contents.dropIndex('album_order')`.
- The new `contents` fields can stay (nothing else reads them), or be removed with `db.contents.updateMany({}, { $unset: { audio: '', waveform: '', transcriptLanguages: '', albumId: '', trackNumber: '', commentCount: '', 'image.palette': '', 'image.blurhash': '' } })`.
- Listens already added to `contents.listens` stay added (the raw events in `listens` say which; count them per song before dropping it if the numbers must be rolled back).

**Reviewed by:** _pending (database owner)_

---

## 2026-10-30: Hand-picked items on the Profile

**Existing data affected:** none. The new code only adds the field below. No migration, no edit of existing documents.

**`users`: new optional field** (absent until the user first saves a list)

| Field | Purpose |
| --- | --- |
| `handPicked` | Array of ObjectIds (`contents._id`), at most 3, in the order the user chose: the Profile's "Hand-picked by <name>" (`GET`/`PUT /v1/me/hand-picked`). Written only by `PUT`, which replaces the whole array in one `$set` after checking that every id is one of the user's own `contents` and that none repeats. `[]` once the user clears it. The model refuses more than 3 (`runValidators` on the update). Absent, or not an array, reads as an empty list. |

Items deleted later stay in the array and are left out when it is read; the array is not cleaned up on read. Nothing deletes a user's content yet (see the `contents` entry below), so whatever does that later may also remove the id from its owner's `handPicked`, though reads already skip it.

**No new collections. No index changes:** the items are read by `_id` (`{_id: {$in: [...]}, ownerId}`), which the existing `_id` index serves.

**Rollback:**
- Stop the new code.
- The field can stay (the old API and the admin panel ignore it), or be removed with `db.users.updateMany({}, { $unset: { handPicked: '' } })`.

**Reviewed by:** _pending (database owner)_

---

## 2026-10-29: Image palette and blur preview (avatar and banner)

**Existing data affected:**
- **By the server: none.** New uploads store two more fields inside the image they already store.
- **By the backfill script, only when someone runs it by hand (and on a shared database only with the database owner's OK):** `scripts/backfill-image-palette.js` adds `palette` and `blurhash` to the existing `users.avatar` and `users.banner` sub-documents that have no palette of the current version. Each write is conditional: it only applies while that image's `path` is unchanged, so a photo replaced in the meantime is never given the old one's colours. It writes nothing else (not even `updatedAt`). Run it with `--dry-run` first to see the counts; `--limit N` does it in batches; it can be stopped and run again, and a second run changes nothing.

**`users`: new optional fields inside the existing `avatar` and `banner` sub-documents**

| Field | Purpose |
| --- | --- |
| `avatar.palette`, `banner.palette` | `{version, seed, accent, neutral}`: the version of the colour rules that made it (1), the picture's main colour and the accent the app uses (`#RRGGBB`, upper case), and whether the picture has no real colour. About 80 bytes. |
| `avatar.blurhash`, `banner.blurhash` | The picture's BlurHash (4x3 components, 28 characters): the blurred stand-in the app paints while the image loads. |

Absent on images stored before this change (the API sends `palette: null`, `blurhash: null`) until the backfill has run. Replacing a photo replaces both with the new photo's; removing it removes them with it. If they cannot be worked out at upload, the photo is saved without them (and the backfill picks it up later).

**What the backfill reads:** `users` in `_id` order, 100 at a time, with the filter `{$or: [{'avatar.path': {$type: 'string'}, 'avatar.palette.version': {$ne: 1}}, {'banner.path': {$type: 'string'}, 'banner.palette.version': {$ne: 1}}]}`. No index serves this beyond `_id`, so a full run reads the collection once; no index is added for a one-off. It reads each image's default size (`<path>/<width>.jpg`) through the media storage driver, so it must run where those files are (`MEDIA_DIR` on the server that stored them, for the local driver).

**No new collections; no index changes.**

**Rollback:**
- Stop the new code.
- The fields can stay (the old API and the admin panel never read them), or be removed with `db.users.updateMany({}, { $unset: { 'avatar.palette': '', 'avatar.blurhash': '', 'banner.palette': '', 'banner.blurhash': '' } })`.

**Reviewed by:** _pending (database owner)_

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

