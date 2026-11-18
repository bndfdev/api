# Media player API (spec first)

**Status: Player, Library and Comments built.** The operations tagged Player, Library and Comments in `docs/api/openapi.yaml` are the contract for the app's media player. The Player operations (songs, albums, playlists, playback, transcripts, listens) are built (`src/modules/player`, step 1 of 3), and so are the Library operations (likes, the library's playlists, a song's heart and "+" states, Add to Playlist: `src/modules/player/library.js` and `libraryRoutes.js`, step 2) and the Comments operations (comments, replies, comment likes, deleting: `src/modules/player/comments.js`, `commentsRepo.js` and `commentRoutes.js`, step 3). A `Song`'s `liked` is the viewer's like (always `false` for guests), `commentCount` the song's counter (replies included) and `latestComment` its newest top-level comment (`SOCIAL` in `src/modules/player/service.js`). The data model below is what is built; each step has its own `docs/DB_CHANGES.md` entry for review.

## Decisions

- **Songs, albums and playlists are `Content` items** (same ids as `GET /me/content`, `CONTENT_NOT_FOUND`): one id space with the Profile, no second catalog.
- **The audio address is not in `Song`.** `GET /songs/{id}/playback` returns a signed URL valid 6 hours that answers HTTP Range: song data can be cached and listed freely, and storage can move to a CDN without changing `Song`.
- **`durationMs`, not `durationSec`:** the player and the listen rule need milliseconds; `Content.durationSec` stays for the Profile lists.
- **`waveform` has any length** (the server makes 128 levels at upload): the app resamples to the 37 bars it draws, so the resolution can change without a new API version.
- **`Song` carries `transcriptLanguages`, `commentCount`, `latestComment` and `liked`:** the flip button, the Comments tab label, the pill and the heart come with the song, in one call.
- **`GET /me/library/songs/{id}`** answers the heart and the "+" button together.
- **Guests can listen and read comments**; the library and writing comments need an account (`GUEST_NOT_ALLOWED`).
- **`LibraryPlaylist.artwork` carries the mosaic's covers** (up to 4 distinct `Song.image`s of the first 20 songs by position; `[]` for none and for Liked songs): a playlist without its own `image` draws them without one request per playlist. The server reads them for the whole library at once: the first song ids come with the playlists' counts (one `playlist_items` aggregate), then one read of those songs and one of their albums.
- **Liked songs is a flagged library entry** (`isLikedSongs`), not a stored playlist: a like is a per-user relation and the heart is its only way in.
- **`PUT /me/library/songs/{id}/playlists` sets the exact set,** all or nothing: it is what the Add to Playlist sheet saves, it is idempotent, and no half-saved state exists.
- **Listens are batched events** (`202`, `Idempotency-Key`, and events deduplicated by listener, song and `endedAt`): mobile networks drop requests, and counting can run later.
- **Comments are one level deep,** with the first 3 replies embedded: that is what the drawer shows.
- **The transcript is exactly the app's `TimedTranscript.fromJson` shape** (plus `availableLanguages`): no app change.
- **Followers-only songs are described but not played** (`playable: false`, `CONTENT_RESTRICTED` for audio, transcript and comments), so lists and queues keep their shape.
- **Enum values are `snake_case`** (`recently_updated`, `liked_songs`), as everywhere else in the spec (`recently_followed`, `while_using`).
- **Rate limits per account:** reads 120 a minute; likes, playlist sets and listens 60 a minute; comments and replies 10 a minute; deletes 30 a minute.

## How the app's repositories map to the API

| App (Dart) | API |
| --- | --- |
| `PlayerRepository.track(id)` | `GET /songs/{id}`, then `GET /songs/{id}/playback` right before it plays |
| Starting or restoring a queue | `GET /songs?ids=` (up to 50, order kept), `GET /albums/{id}`, `GET /playlists/{id}/songs` |
| `PlayerTrack` | `id`, `title`; `artist.name` / `artist.id` → `artistName` / `artistId`; `album.title` → `albumName` (`album.id` is new, for "Go to album"); `durationMs` → `duration`; `image` → `cover`; `artist.image` → `artistPicture`; playback `url` → `audio` (`null` while `playable` is `false`); `transcriptLanguages` not empty → `hasTranscript`; `waveform` is new |
| `LibraryRepository.playlists()` | `GET /me/library/playlists?limit=200` (every page); the app keeps sorting and searching on the device |
| `isLiked`, `playlistsContaining` | `GET /me/library/songs/{id}` (`liked`, `playlistIds`) |
| `setLiked(id, liked)` | `PUT` / `DELETE /me/liked-songs/{id}` |
| `setPlaylistsFor(id, ids)` | `PUT /me/library/songs/{id}/playlists` |
| `likedTrackIds()` | `GET /me/liked-songs` (ids in order, newest like first) |
| `LibraryPlaylist` | `image` → `cover`, `artwork` → `artwork` (the mosaic when `cover` is null), `songCount` → `itemCount`; `updatedAt`, `savedAt`, `playedAt`, `isLikedSongs` as they are; `editable` is new |
| `CommentsRepository.comments(id, cursor, limit)` | `GET /songs/{id}/comments` (`commentCount` → `total`, `page.nextCursor` → `nextCursor`) |
| `count`, `latest` | `Song.commentCount`, `Song.latestComment` |
| `setLiked(trackId, commentId, liked)` | `PUT` / `DELETE /comments/{id}/like` (answers `likeCount`) |
| `post`, `reply` | `POST /songs/{id}/comments`, `POST /comments/{id}/replies`; more replies: `GET /comments/{id}/replies` |
| `PlayerComment` | `author.name` → `authorName` (`null`: the app's placeholder), `author.avatar` → `avatar`; the other fields as they are |
| `TranscriptRepository.transcriptFor(id, language)` | `GET /songs/{id}/transcript?language=`; `404 TRANSCRIPT_NOT_FOUND` → `Ok(null)` |
| `ListenEvent` (not sent yet) | `POST /me/listens`: `trackId` → `songId`, `listened` → `listenedMs`, `completed`; plus `endedAt` and `source` |

## Data model (built in steps 1 to 3)

**`contents` (existing): new optional fields** (`models/Content.js`; absent on everything stored before)

| Field | On | Purpose |
| --- | --- | --- |
| `audio` | songs | `{key, mimeType, sizeBytes, durationMs, status: processing / ready / failed, uploadedAt}`: the stored file by storage key, never a URL. `playable` and `/playback` need `status: ready` with a key, a type and a size. |
| `waveform` | songs | 128 numbers from 0 to 1, made when the audio is processed (any 1 to 1024 are served; another shape reads as `null`) |
| `transcriptLanguages` | songs | Languages with a transcript, original first, then translations by tag; kept in step with `transcripts` |
| `albumId`, `trackNumber` | songs | Album membership and order (a song is on at most one album, and only on an album of the same owner) |
| `commentCount` | songs | Counter, replies included (written by the comments since step 3, atomically and never below 0; absent reads as 0) |
| `image.palette`, `image.blurhash` | songs, albums, playlists | Artwork colours and blur preview, made at upload as for photos (read as stored; `null` when absent) |
| `songsUpdatedAt` | playlists | Step 2: when Add to Playlist last added the song to or took it out of the playlist. A playlist's `updatedAt` is the later of this and its newest item's `addedAt` (its creation while it has neither). Not the document's `updatedAt`, which moves with any change. |

Existing fields now written: `listens` (songs), incremented by counted listens; `songCount` (playlists, step 2), set to the playlist's number of items by Add to Playlist, so the Profile's count stays in step; `commentCount` (songs, step 3), by posting and deleting comments.

New index: `album_order` `{albumId: 1, trackNumber: 1, _id: 1}` (partial: `albumId` exists, so only songs on an album).

**New collections**

| Collection | Holds | Indexes |
| --- | --- | --- |
| `playlist_items` (built; written by Add to Playlist since step 2) | `playlistId`, `songId`, `position`, `addedAt` | `playlist_song` `{playlistId, songId}` unique; `playlist_order` `{playlistId, position, _id}` |
| `transcripts` (built) | `songId`, `language`, `translatedFrom` (null for the original), `lines`, `updatedAt` | `song_language` `{songId, language}` unique |
| `listens` (built) | `listenerId` (user or guest), `listenerType`, `songId`, `listenedMs`, `completed`, `endedAt`, `source`, `counted`, `receivedAt` | `listener_song_end` `{listenerId, songId, endedAt}` unique (dedupe). No TTL yet: retention is to decide, and it must outlast the 30 days an event is accepted, or a late resend would count again. |
| `song_likes` (built, step 2) | `userId`, `songId`, `likedAt` | `user_song` `{userId, songId}` unique; `user_liked` `{userId, likedAt: -1, _id: -1}` |
| `library_entries` (built, step 2) | `userId`, `kind` (`playlist` or `liked_songs`), `playlistId` (null for Liked songs), `savedAt` (playlists), `playedAt`, `unlikedAt` (Liked songs) | `user_playlist` `{userId, playlistId}` unique (one row per playlist, one Liked songs row) |
| `library_locks` (built, step 2) | `_id` (the account's id), `owner`, `expiresAt` | `expires` TTL on `expiresAt` |
| `comments` (built, step 3) | `songId`, `parentId` (the top-level comment for a reply, null for a top-level comment), `authorId`, `text`, `likeCount`, `replyCount` (top-level only), `createdAt` | `song_thread` `{songId, parentId, createdAt: -1, _id: -1}`: a song's top-level comments newest first and, read backwards, a comment's replies oldest first (one index for both; replies are stored with their song) |
| `comment_likes` (built, step 3) | `commentId`, `userId`, `createdAt` | `comment_user` `{commentId, userId}` unique |

The library is the user's own playlists (`contents`, no row needed), the playlists saved from others (a `library_entries` row each: nothing in v1 saves them yet; locally the seed does), and the Liked songs entry, built from `song_likes` (count; newest `likedAt`) plus its `library_entries` row (`playedAt`, `unlikedAt`); its id is derived from the user (`liked_<userId>`). An own playlist gets a row the first time it is played from (for `playedAt`). `library_locks` holds an account's Add to Playlist lock for the few milliseconds of its writes. Counted listens increment `contents.listens`. Account deletion will have to remove likes, library entries, the user's playlists' items, comment likes and listens, and remove or anonymise comments.

**How step 1 reads it (choices the spec left open)**

- `Song.image` is the album's artwork when the album has some, else the song's own. A song whose `albumId` is missing, not an album, or someone else's album is a single.
- `ArtistSummary.name` is `''` when the publishing account has no name (the spec makes it a non-null string); a playlist owner's `name` is then `null`.
- Followers-only songs play only for their artist; Restrict Content on a playlist changes nothing yet.
- A playlist's `songCount` (and `page.total`) counts its items; an item whose song no longer exists is left out of the pages and of `durationMs`. `updatedAt` is the later of `songsUpdatedAt` (Add to Playlist, step 2, which also covers removals) and the newest item's `addedAt`; the playlist's creation while it has neither.
- Transcripts: `language` must match a stored tag, compared without regard to case (`pt-br` finds `pt-BR`); without it, each Accept-Language range by preference matches the same tag first, then the same main subtag, `*` is the original, and nothing matching gives the original (the first translation by tag if no original is stored).
- Listens: "may not play" means followers-only (audio not ready does not drop an event). Counting happens right after the events are stored, before the `202`; if adding the counts fails the events stay stored, are not counted, and the answer is still `202`. A `playlist` or `liked_songs` source moves that library entry's `playedAt` (step 2, below).

**How step 2 reads it (choices the spec left open)**

- Likes: a followers-only song can be liked (the spec lists no restriction for `likeSong`) and is listed with `playable: false`. Unliking an id in no known format is `204`, like any song that is not liked.
- Liked songs pages (newest like first, the like's id breaking ties): a like whose song no longer exists, or is no longer a song, is left out of its page but still counted in `page.total` and in the entry's `songCount`, as step 1 does for playlist items. Liked songs' `updatedAt` is the newer of the newest like and the last unlike; `savedAt`, and `updatedAt` before any like, is the account's creation.
- The library lists hidden and followers-only own playlists (the owner's view) and saved playlists that still exist (hidden ones too, as they still answer by id). Own playlists' `savedAt` is their creation. It is sorted in memory (a library is small); ties by id (A to Z), so the order is total; `title` compares without case or accents (as the Profile's A to Z).
- `playedAt` moves with listens played from the entry: the newest `endedAt` of the batch, never ahead of the server's clock, never back. A `playlist` source marks the user's own playlist (its row is made then) or a saved one; someone else's playlist that is not saved, and guests, mark nothing.
- Add to Playlist: an id is "not a playlist in the user's library" (`404 PLAYLIST_NOT_FOUND`) when it is unknown, in no known format, not a playlist, someone else's playlist that is not saved, or another account's Liked songs id; a saved playlist of someone else is `403 PLAYLIST_NOT_EDITABLE`. `meta.playlistIds` lists them as sent, each once. The song is checked first (`CONTENT_NOT_FOUND`). The answer lists the saved set in lower case, in the order sent.
- All or nothing without transactions (nothing else in this API uses them): an account's sets run one at a time under a lock (`library_locks`, a 10-second lease that a crashed request's successor takes over; a waiting request gives up after 12 seconds with `500`), and if a write fails, what was written is undone (added items deleted, removed ones put back with their ids and positions, counts and times restored) before the request fails.
- New items go after the playlist's highest position (1 in an empty playlist); removing one leaves the others' positions as they are. Each playlist that changes gets `songsUpdatedAt` and `songCount` (its items counted after the change).

**How step 3 reads it (choices the spec left open)**

- Text: made well formed (a lone surrogate becomes U+FFFD), trimmed (`String.prototype.trim`: spaces, tabs and line breaks at both ends; line breaks inside are kept), then 1 to 500 characters counted as Unicode code points, as the spec's JSON Schema counts `maxLength` (an emoji outside the BMP is one character). Checked before the song or comment is looked up, so a blank text is `422` even on an unknown song.
- Who may read: a followers-only song's comments follow `mayPlay` (only its artist, for now): listing, replies, posting, replying, liking and unliking are `403 CONTENT_RESTRICTED` for anyone else, as the spec lists. Deleting lists no such code, so an author may delete their comment on a song that became followers-only. A `Song` stays described with its `commentCount`, but its `latestComment` is `null` for a viewer who may not read its comments.
- Deleting: the author, or the song's owner (`Song.artist.id`); anyone else `403 FORBIDDEN`. A comment whose song no longer exists (nothing deletes songs yet) is `COMMENT_NOT_FOUND` everywhere except to its author's delete.
- Counters: `commentCount` (song, replies included), `replyCount` and `likeCount` are stored and changed atomically, never below 0; each moves up before its row is stored and down after a row is deleted, so concurrent posts and deletes can only leave it briefly high, never low. `page.total` of a song's comments is counted from the rows (top-level only); a replies page's `page.total` is the comment's `replyCount`, as the spec says.
- Pages: newest first by `createdAt`, then id (the newer id first on the same millisecond); replies oldest first, by `createdAt` then id. A cursor holds the last comment's time and id and is tied to the song (or to the comment): one from another song's or comment's list is `CURSOR_INVALID`. `GET /comments/{id}/replies` on a reply answers an empty page (`total: 0`).
- A reply to a reply is stored under the same top-level comment, and so are its counts (the top-level comment's `replyCount`). A reply posted while its comment is deleted is deleted again and answers `404 COMMENT_NOT_FOUND`; so is a like stored while its comment is deleted.
- Rate limits: one counter of 10 a minute for posting comments and replies together; listing 120, likes and unlikes 60 each, deletes 30, each its own counter. `Idempotency-Key` replays a post's or reply's `201`.

## Storage

Today every file sits on the API server's disk: `src/providers/storage` has only the `local` driver (`MEDIA_DIR`, served at `/media` by `express.static`, which answers Range requests with `206`). The player is built and tested on that: `/playback` returns the file's `/media/...` URL with `expiresAt` 6 hours ahead, but that URL does not really expire. Real streaming needs object storage and a CDN, which is infrastructure for the seniors. Locally, `tools.local/e2e/seed_player.js` (not in this repo) seeds an album, a single, a playlist, generated audio, artwork and transcripts; for a second (listener) account, a library: two own playlists, a saved playlist and two liked songs; and comments with replies and likes on two songs, by two demo accounts with invented names.

**What the infrastructure needs**

- [ ] A private S3 bucket for audio and artwork (no public listing), with `Content-Type` set on upload and long, immutable caching (keys change with every upload).
- [ ] CloudFront in front with signed URLs (or S3 pre-signed GET URLs), 6-hour expiry; the signing key in Secrets Manager, handed to the API as configuration.
- [ ] HTTP Range passed through end to end (`Accept-Ranges`, `206`), and the cache keyed on the object, not on the signature.
- [ ] CORS for the web build: `GET` and `HEAD` from the app's origins, exposing `Content-Length`, `Content-Range` and `Accept-Ranges`.
- [ ] An IAM role for the API limited to the bucket's prefixes (put, get, delete).
- [ ] An upload and processing path for audio (pre-signed `PUT`, then a worker that checks the file, transcodes if needed, and makes the waveform and the artwork palette).
- [ ] An `s3` storage driver with the same interface plus a signed-URL method (API work, once the above exists).

## Open questions

- **Guests:** may they listen without limit and read comments, as drafted?
- **Listen count:** 30 seconds or completed, as drafted? A per-listener daily cap against inflated counts?
- **Comment length:** 500 characters?
- **Transcripts:** their source, and the rights to show them.
- **Hide and Restrict Content:** are hidden songs still playable from playlists and links (drafted: yes)? What does Restrict do to a playlist? There is no follow data yet, so followers-only songs play for their artist only.
- **Playlists:** creating, renaming, saving others', deleting, reordering; the same song twice.
- **Artist page:** `ArtistSummary` is the publishing account for now.
- **Server-side queue sync** across devices.
- **Offline downloads** (longer-lived URLs, protection).
- **Moderation:** reporting comments, blocking, removing them.
- **Waveform resolution:** is 128 levels enough?
- **Listen retention:** how long raw listen events are kept.

## Out of scope

Uploading songs and albums; creating or editing playlists; search; artist pages; recommendations; queue sync; offline downloads; notifications for comments and likes; moderation tools; stories.
