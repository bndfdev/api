# Media player API (spec first)

**Status: spec only.** The operations tagged Player, Library and Comments in `docs/api/openapi.yaml` are the contract for the app's media player. None is built: each answers `404` until its route exists. The data model below is **planned**; nothing in the database changes until the PRs that build it, which add their own `docs/DB_CHANGES.md` entries for review.

## Decisions

- **Songs, albums and playlists are `Content` items** (same ids as `GET /me/content`, `CONTENT_NOT_FOUND`): one id space with the Profile, no second catalog.
- **The audio address is not in `Song`.** `GET /songs/{id}/playback` returns a signed URL valid 6 hours that answers HTTP Range: song data can be cached and listed freely, and storage can move to a CDN without changing `Song`.
- **`durationMs`, not `durationSec`:** the player and the listen rule need milliseconds; `Content.durationSec` stays for the Profile lists.
- **`waveform` has any length** (the server makes 128 levels at upload): the app resamples to the 37 bars it draws, so the resolution can change without a new API version.
- **`Song` carries `transcriptLanguages`, `commentCount`, `latestComment` and `liked`:** the flip button, the Comments tab label, the pill and the heart come with the song, in one call.
- **`GET /me/library/songs/{id}`** answers the heart and the "+" button together.
- **Guests can listen and read comments**; the library and writing comments need an account (`GUEST_NOT_ALLOWED`).
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
| `LibraryPlaylist` | `image` → `cover`, `songCount` → `itemCount`; `updatedAt`, `savedAt`, `playedAt`, `isLikedSongs` as they are; `editable` is new |
| `CommentsRepository.comments(id, cursor, limit)` | `GET /songs/{id}/comments` (`commentCount` → `total`, `page.nextCursor` → `nextCursor`) |
| `count`, `latest` | `Song.commentCount`, `Song.latestComment` |
| `setLiked(trackId, commentId, liked)` | `PUT` / `DELETE /comments/{id}/like` (answers `likeCount`) |
| `post`, `reply` | `POST /songs/{id}/comments`, `POST /comments/{id}/replies`; more replies: `GET /comments/{id}/replies` |
| `PlayerComment` | `author.name` → `authorName` (`null`: the app's placeholder), `author.avatar` → `avatar`; the other fields as they are |
| `TranscriptRepository.transcriptFor(id, language)` | `GET /songs/{id}/transcript?language=`; `404 TRANSCRIPT_NOT_FOUND` → `Ok(null)` |
| `ListenEvent` (not sent yet) | `POST /me/listens`: `trackId` → `songId`, `listened` → `listenedMs`, `completed`; plus `endedAt` and `source` |

## Planned data model (for the build; not applied)

**`contents` (existing): new optional fields**

| Field | On | Purpose |
| --- | --- | --- |
| `audio` | songs | `{key, mimeType, sizeBytes, durationMs, status: processing / ready / failed, uploadedAt}`: the stored file by storage key, never a URL. `playable` needs `status: ready`. |
| `waveform` | songs | 128 numbers from 0 to 1, made when the audio is processed |
| `transcriptLanguages` | songs | Languages with a transcript, original first; kept in step with `transcripts` |
| `albumId`, `trackNumber` | songs | Album membership and order (a song is on at most one album) |
| `commentCount` | songs | Counter, replies included |
| `image.palette`, `image.blurhash` | songs, albums | Artwork colours and blur preview, made at upload as for photos |

New index: `album_order` `{albumId: 1, trackNumber: 1}` (partial: songs on an album).

**New collections**

| Collection | Holds | Indexes |
| --- | --- | --- |
| `playlist_items` | `playlistId`, `songId`, `position`, `addedAt` | `{playlistId, songId}` unique; `{playlistId, position}` |
| `library_entries` | `userId`, `playlistId` (or `kind: 'liked_songs'`), `savedAt`, `playedAt` | `{userId, playlistId}` unique |
| `song_likes` | `userId`, `songId`, `likedAt` | `{userId, songId}` unique; `{userId, likedAt: -1, _id: -1}` |
| `comments` | `songId`, `parentId` (null for top-level), `authorId`, `text`, `likeCount`, `replyCount`, `createdAt` | `{songId, parentId, createdAt: -1, _id: -1}`; `{parentId, createdAt: 1, _id: 1}` |
| `comment_likes` | `commentId`, `userId`, `createdAt` | `{commentId, userId}` unique |
| `listens` | listener (user or guest), `songId`, `listenedMs`, `completed`, `endedAt`, `source`, `counted`, `receivedAt` | `{listenerId, songId, endedAt}` unique (dedupe); TTL on `receivedAt` (retention to decide) |
| `transcripts` | `songId`, `language`, `translatedFrom`, `lines`, `updatedAt` | `{songId, language}` unique |

The Liked songs entry is built from `song_likes` (count; newest `likedAt` as `updatedAt`) plus its `library_entries` row (`playedAt`); its id is derived from the user (`liked_<userId>`). Counted listens increment `contents.listens`. Account deletion will have to remove likes, library entries, the user's playlists' items, comment likes and listens, and remove or anonymise comments.

## Storage

Today every file sits on the API server's disk: `src/providers/storage` has only the `local` driver (`MEDIA_DIR`, served at `/media` by `express.static`, which answers Range requests). The player can be built and tested on that: `/playback` would return a `/media/...` URL (it does not really expire). Real streaming needs object storage and a CDN, which is infrastructure for the seniors.

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

Building the endpoints; uploading songs and albums; creating or editing playlists; search; artist pages; recommendations; queue sync; offline downloads; notifications for comments and likes; moderation tools; stories.
