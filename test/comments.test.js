process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const request = require('supertest');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { createApp } = require('../src/app');
const { config } = require('../src/config');
const { iso } = require('../src/lib/time');
const { createLocalStorage } = require('../src/providers/storage/local');
const { toImage } = require('../src/modules/users/service');
const { createPlayerService, SOCIAL, latestCommentsFrom } = require('../src/modules/player/service');
const { createPlayerRouter } = require('../src/modules/player/routes');
const { createLibraryService } = require('../src/modules/player/library');
const { createLibraryRouter } = require('../src/modules/player/libraryRoutes');
const { createCommentService, CURSOR_TTL_MS } = require('../src/modules/player/comments');
const { createCommentRouter, LIMITS } = require('../src/modules/player/commentRoutes');
const commentsRepo = require('../src/modules/player/commentsRepo');
const usersRepo = require('../src/modules/users/repo');
const Content = require('../models/Content');
const Comment = require('../models/Comment');
const CommentLike = require('../models/CommentLike');
const PlaylistItem = require('../models/PlaylistItem');
const SongLike = require('../models/SongLike');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bondfire-comments-'));
const storage = createLocalStorage({ dir, publicUrl: config.media.publicUrl });
// Whole seconds, so `createdAt` in answers (no milliseconds) is exactly the clock.
const clock = { t: Math.floor(Date.now() / 1000) * 1000, now: () => clock.t };
const commentsWith = (deps = {}) => createCommentService({ storage, now: clock.now, ...deps });
const svc = commentsWith();

/** The whole /v1 API with these comments: the Player and Library build their songs' comment fields from them too. */
function buildApp({ comments = svc, router = {} } = {}) {
  const player = createPlayerService({ storage, now: clock.now, social: { ...SOCIAL, latestComments: latestCommentsFrom(comments) } });
  return createApp({
    trustProxy: 1,
    storage,
    playerRouter: createPlayerRouter({ player }),
    libraryRouter: createLibraryRouter({ library: createLibraryService({ player, now: clock.now }) }),
    commentsRouter: createCommentRouter({ comments, ...router }),
  });
}
const app = buildApp();

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
const ajv = new Ajv2020({ strict: false, logger: false });
const assertMatchesSpec = (name, value) => assert.equal(
  ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value),
  true,
  `${name}: ${JSON.stringify(ajv.errors)}`,
);

before(db.connect);
beforeEach(async () => {
  await db.clear();
  clock.t = Math.floor(Date.now() / 1000) * 1000;
});
after(async () => {
  await db.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
const AVATAR = Object.freeze({
  path: 'avatars/a1b2/c3d4', width: 512, height: 512, variants: [{ width: 128, height: 128 }, { width: 512, height: 512 }],
  updatedAt: new Date('2026-11-01T10:00:00Z'), palette: { version: 1, seed: '#B0522F', accent: '#A84E2D', neutral: false },
  blurhash: 'L*J3}y{@OGOHspn~a}a}fQfQfQfQ',
});
const oid = () => String(new mongoose.Types.ObjectId());
let files = 0;
const audio = () => ({
  key: `audio/s${(files += 1)}/f${files}.mp3`, mimeType: 'audio/mpeg', sizeBytes: 4096, durationMs: 187040,
  status: 'ready', uploadedAt: new Date(),
});
/** A character outside the Basic Multilingual Plane: one code point, two UTF-16 units. */
const NOTE = String.fromCodePoint(0x1F3B5);

async function account(extra = {}) {
  return signIn(await makeUser({ password: HASH, emailVerified: true, ...extra }));
}

async function guest() {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(res.status, 201, res.text);
  return { guest: true, headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

/** `req.auth` of an account, for calling the service directly (no rate limit). */
const authOf = (who) => ({ userId: String(who.user._id), sessionId: String(who.session._id), accountType: 'user' });
const GUEST_AUTH = Object.freeze({ userId: oid(), sessionId: oid(), accountType: 'guest' });

async function add(owner, fields = {}) {
  const doc = await Content.create({ ownerId: owner.user._id, type: 'song', title: 'Untitled', durationSec: 200, ...fields });
  return String(doc._id);
}
const song = (owner, fields = {}) => add(owner, { type: 'song', audio: audio(), ...fields });

const call = (who, method, url, body, { target = app, headers = {} } = {}) => {
  const req = request(target)[method](`/v1${url}`).set(who.headers).set(headers);
  return body === undefined ? req : req.send(body);
};
const get = (who, url, opts) => call(who, 'get', url, undefined, opts);
const postComment = (who, songId, text, opts) => call(who, 'post', `/songs/${songId}/comments`, { text }, opts);
const postReply = (who, commentId, text, opts) => call(who, 'post', `/comments/${commentId}/replies`, { text }, opts);
const likeIt = (who, id, opts) => call(who, 'put', `/comments/${id}/like`, undefined, opts);
const unlikeIt = (who, id, opts) => call(who, 'delete', `/comments/${id}/like`, undefined, opts);
const deleteIt = (who, id, opts) => call(who, 'delete', `/comments/${id}`, undefined, opts);

/** A top-level comment, posted through the service one second after the previous one. */
async function comment(who, songId, text = 'A comment', { step = 1000, service = svc } = {}) {
  clock.t += step;
  return service.postSongComment(authOf(who), songId, { text });
}
/** A reply, posted through the service one second after the previous one. */
async function replyTo(who, commentId, text = 'A reply', { step = 1000, service = svc } = {}) {
  clock.t += step;
  return service.postCommentReply(authOf(who), commentId, { text });
}

const ids = (res) => res.body.data.map((c) => c.id);
const storedCount = async (songId) => (await Content.findById(songId).lean()).commentCount;

function assertOk(res, schema, status = 200) {
  assert.equal(res.status, status, res.text);
  assertMatchesSpec(schema, res.body);
  assert.equal(res.headers['cache-control'], 'private, no-cache');
}

/**
 * Every counter equals its rows: the song's `commentCount` (replies included), each comment's `replyCount` and
 * `likeCount`; no reply without its comment, no like without its comment, no counter below 0.
 */
async function assertCounters(songId) {
  const docs = await Comment.find({ songId }).lean();
  const likes = await CommentLike.find().lean();
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const counted = (await Content.findById(songId).lean()).commentCount;
  assert.equal(counted === undefined ? 0 : counted, docs.length, 'commentCount');
  for (const doc of docs) {
    assert.ok(doc.likeCount >= 0 && doc.replyCount >= 0, 'never below 0');
    assert.equal(doc.likeCount, likes.filter((row) => String(row.commentId) === String(doc._id)).length, 'likeCount');
    if (doc.parentId) {
      assert.ok(byId.has(String(doc.parentId)) && !byId.get(String(doc.parentId)).parentId, 'a reply has its top-level comment');
    } else {
      assert.equal(doc.replyCount, docs.filter((r) => String(r.parentId) === String(doc._id)).length, 'replyCount');
    }
  }
  const all = new Set((await Comment.find({}, { _id: 1 }).lean()).map((doc) => String(doc._id)));
  assert.ok(likes.every((row) => all.has(String(row.commentId))), 'no like outlives its comment');
}

// ---------------------------------------------------------------------------
// Guests and accounts
// ---------------------------------------------------------------------------

test('reading is open to guests; posting, replying, liking and deleting are for accounts (403 GUEST_NOT_ALLOWED); no token 401', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const id = await song(mara);
  const top = await comment(mara, id);
  const g = await guest();
  assertOk(await get(g, `/songs/${id}/comments`), 'CommentPage');
  assertOk(await get(g, `/comments/${top.id}/replies`), 'CommentReplyPage');
  const writes = [
    ['post', `/songs/${id}/comments`, { text: 'Hello' }], ['post', `/comments/${top.id}/replies`, { text: 'Hello' }],
    ['put', `/comments/${top.id}/like`], ['delete', `/comments/${top.id}/like`], ['delete', `/comments/${top.id}`],
  ];
  for (const [method, url, body] of writes) assertProblem(await call(g, method, url, body), 403, 'GUEST_NOT_ALLOWED');
  for (const [method, url, body] of [...writes, ['get', `/songs/${id}/comments`], ['get', `/comments/${top.id}/replies`]]) {
    const res = await call({ headers: CLIENT }, method, url, body);
    assertProblem(res, 401, 'UNAUTHENTICATED');
    assert.ok(res.headers['www-authenticate']);
  }
  assert.equal(await Comment.countDocuments(), 1);
  assert.equal(await CommentLike.countDocuments(), 0);
  await assertCounters(id);
});

// ---------------------------------------------------------------------------
// POST /songs/{songId}/comments
// ---------------------------------------------------------------------------

test('POST /songs/{id}/comments: 201 with the comment as saved; the song counts it and shows it as its latest comment', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane', avatar: AVATAR });
  const other = await account();
  const id = await song(mara);
  const res = await postComment(amelia, id.toUpperCase(), '  \n The quiet bridge before the last chorus.\nIs perfect. \t ');
  assertOk(res, 'Comment', 201);
  const expected = {
    id: res.body.id,
    parentId: null,
    author: { id: String(amelia.user._id), name: 'Amelia Jane', avatar: toImage(AVATAR, (key) => storage.publicUrl(key)) },
    text: 'The quiet bridge before the last chorus.\nIs perfect.',
    createdAt: iso(clock.t),
    likeCount: 0,
    likedByMe: false,
    replyCount: 0,
    replies: [],
    isMine: true,
  };
  assert.deepEqual(res.body, expected);
  assert.ok(expected.author.avatar.palette && expected.author.avatar.blurhash, 'the author photo keeps its look');
  const [stored] = await Comment.find().lean();
  assert.deepEqual(
    [String(stored.songId), stored.parentId, String(stored.authorId), stored.text, stored.createdAt.getTime(), stored.likeCount, stored.replyCount],
    [id, null, String(amelia.user._id), expected.text, clock.t, 0, 0],
  );

  const forAuthor = await get(amelia, `/songs/${id}`);
  assertOk(forAuthor, 'Song');
  assert.equal(forAuthor.body.commentCount, 1);
  assert.deepEqual(forAuthor.body.latestComment, expected);
  const forOther = await get(other, `/songs/${id}`);
  assert.deepEqual(forOther.body.latestComment, { ...expected, isMine: false });
  assert.deepEqual((await get(await guest(), `/songs/${id}`)).body.latestComment, { ...expected, isMine: false });
  const page = await get(other, `/songs/${id}/comments`);
  assertOk(page, 'CommentPage');
  assert.deepEqual(page.body, { data: [{ ...expected, isMine: false }], page: { nextCursor: null, hasMore: false, total: 1 }, commentCount: 1 });
  await assertCounters(id);
});

test('text: trimmed, then 1 to 500 characters (code points); otherwise 422 VALIDATION_FAILED on /text and nothing is stored', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const me = await account();
  // Refused posts still count towards the 10 a minute: the accepted ones are another account's.
  const you = await account();
  const id = await song(mara);
  const top = await comment(mara, id);
  const refused = [
    ['blank', ' \n\t  '],
    ['501 characters', 'x'.repeat(501)],
    ['501 characters once trimmed', ` ${'x'.repeat(501)} `],
    ['501 characters outside the BMP', NOTE.repeat(501)],
  ];
  for (const [what, text] of refused) {
    for (const res of [await postComment(me, id, text), await postReply(me, top.id, text)]) {
      assertProblem(res, 422, 'VALIDATION_FAILED');
      assertMatchesSpec('Problem', res.body);
      assert.deepEqual(res.body.errors.map((e) => [e.field, e.code]), [['/text', 'VALIDATION_FAILED']], what);
    }
  }
  // The validator's own bounds (CommentCreate): 1 to 1000, a string, nothing else.
  for (const body of [{ text: '' }, { text: 'y'.repeat(1001) }, { text: 7 }, {}, { text: 'ok', extra: 1 }]) {
    const res = await call(me, 'post', `/songs/${id}/comments`, body);
    assertProblem(res, 422, 'VALIDATION_FAILED');
  }
  assert.equal(await Comment.countDocuments(), 1, 'nothing refused is stored');
  await assertCounters(id);

  const accepted = [
    ['one character', 'a', 'a'],
    ['500 characters', 'z'.repeat(500), 'z'.repeat(500)],
    ['500 once trimmed', `\n  ${'w'.repeat(500)}  \n`, 'w'.repeat(500)],
    ['500 code points, 1000 UTF-16 units', NOTE.repeat(500), NOTE.repeat(500)],
    ['line breaks inside kept', 'one\n\ntwo\r\nthree', 'one\n\ntwo\r\nthree'],
  ];
  for (const [what, text, saved] of accepted) {
    clock.t += 1000;
    const res = await postComment(you, id, text);
    assertOk(res, 'Comment', 201);
    assert.equal(res.body.text, saved, what);
    assert.equal((await Comment.findById(res.body.id).lean()).text, saved, what);
  }
  await assertCounters(id);
  assert.equal(await storedCount(id), 1 + accepted.length);
});

test('POST comments: CONTENT_NOT_FOUND for an unknown id, an album or an id in no known format; CONTENT_RESTRICTED unless the viewer may play it', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const me = await account();
  const albumId = await add(mara, { type: 'album', songCount: 1 });
  const closed = await song(mara, { followersOnly: true });
  const onClosedAlbum = await song(mara, { albumId: await add(mara, { type: 'album', followersOnly: true }), trackNumber: 1 });
  for (const songId of [oid(), albumId, 'not-an-id']) assertProblem(await postComment(me, songId, 'Hello'), 404, 'CONTENT_NOT_FOUND');
  for (const songId of [closed, onClosedAlbum]) {
    const res = await postComment(me, songId, 'Hello');
    assertProblem(res, 403, 'CONTENT_RESTRICTED');
    assertMatchesSpec('Problem', res.body);
  }
  assert.equal(await Comment.countDocuments(), 0);
  assertOk(await postComment(mara, closed, 'Only for my followers'), 'Comment', 201);
  assertOk(await postComment(mara, onClosedAlbum, 'Same here'), 'Comment', 201);
  assert.deepEqual([await storedCount(closed), await storedCount(onClosedAlbum)], [1, 1]);
});

test('Idempotency-Key on posts and replies: a retry gets the stored 201 again; another text is IDEMPOTENCY_KEY_REUSED; a retry while the first runs is IDEMPOTENCY_IN_PROGRESS', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const me = await account();
  const id = await song(mara);
  const key = crypto.randomUUID();
  const first = await postComment(me, id, 'Once only', { headers: { 'Idempotency-Key': key } });
  assertOk(first, 'Comment', 201);
  const retry = await postComment(me, id, 'Once only', { headers: { 'Idempotency-Key': key } });
  assert.equal(retry.status, 201);
  assert.equal(retry.headers['idempotent-replayed'], 'true');
  assert.deepEqual(retry.body, first.body);
  assertProblem(await postComment(me, id, 'Something else', { headers: { 'Idempotency-Key': key } }), 422, 'IDEMPOTENCY_KEY_REUSED');
  assertProblem(await postComment(me, id, 'x', { headers: { 'Idempotency-Key': 'not-a-uuid' } }), 400, 'MALFORMED_REQUEST');

  const replyKey = crypto.randomUUID();
  const reply = await postReply(me, first.body.id, 'A reply, once', { headers: { 'Idempotency-Key': replyKey } });
  assertOk(reply, 'Comment', 201);
  const again = await postReply(me, first.body.id, 'A reply, once', { headers: { 'Idempotency-Key': replyKey } });
  assert.deepEqual([again.status, again.headers['idempotent-replayed'], again.body], [201, 'true', reply.body]);
  assert.equal(await Comment.countDocuments(), 2);
  await assertCounters(id);

  // The first request is held inside the service: its retry finds it still running.
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const inside = new Promise((resolve) => { entered = resolve; });
  const slow = { ...svc, postSongComment: async (...args) => { entered(); await gate; return svc.postSongComment(...args); } };
  const target = buildApp({ comments: slow });
  const held = crypto.randomUUID();
  const running = postComment(me, id, 'Slow one', { target, headers: { 'Idempotency-Key': held } }).then((res) => res);
  await inside;
  const meanwhile = await postComment(me, id, 'Slow one', { target, headers: { 'Idempotency-Key': held } });
  assertProblem(meanwhile, 409, 'IDEMPOTENCY_IN_PROGRESS');
  release();
  assert.equal((await running).status, 201);
  assert.equal(await Comment.countDocuments(), 3);
  await assertCounters(id);
});

// ---------------------------------------------------------------------------
// GET /songs/{songId}/comments
// ---------------------------------------------------------------------------

test('GET /songs/{id}/comments: newest first, each with replyCount and its first 3 replies oldest first; commentCount counts replies, page.total does not', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane' });
  const noName = await account();
  const id = await song(mara);
  const elsewhere = await song(mara);
  const c1 = await comment(amelia, id, 'First');
  const c2 = await comment(noName, id, 'Second');
  const r1 = [];
  for (let i = 0; i < 5; i += 1) r1.push(await replyTo(i % 2 ? mara : noName, c1.id, `Reply ${i + 1}`));
  const c3 = await comment(mara, id, 'Third');
  const r3 = [await replyTo(amelia, c3.id, 'Only reply')];
  const c4 = await comment(amelia, id, 'Fourth');
  await comment(amelia, elsewhere, 'On another song');

  const res = await get(amelia, `/songs/${id}/comments`);
  assertOk(res, 'CommentPage');
  assert.deepEqual(ids(res), [c4.id, c3.id, c2.id, c1.id]);
  assert.deepEqual(res.body.data.map((c) => [c.replyCount, c.replies.map((r) => r.id)]), [
    [0, []], [1, [r3[0].id]], [0, []], [5, r1.slice(0, 3).map((r) => r.id)],
  ]);
  const shown = res.body.data[3].replies[1];
  assert.deepEqual(shown, {
    id: r1[1].id, parentId: c1.id, author: { id: String(mara.user._id), name: 'Mara Quillon', avatar: null }, text: 'Reply 2',
    createdAt: r1[1].createdAt, likeCount: 0, likedByMe: false, replyCount: 0, isMine: false,
  });
  assert.equal(Object.hasOwn(shown, 'replies'), false, 'a reply carries no replies');
  assert.deepEqual(res.body.data[2].author, { id: String(noName.user._id), name: null, avatar: null }, 'no name: null');
  assert.deepEqual(res.body.data.map((c) => c.isMine), [true, false, false, true]);
  assert.deepEqual([res.body.commentCount, res.body.page], [10, { nextCursor: null, hasMore: false, total: 4 }]);
  assert.equal((await get(amelia, `/songs/${id}`)).body.commentCount, 10, 'Song.commentCount is the same number');
  await assertCounters(id);
});

test('GET comments: pages by cursor, ties on createdAt broken by id, 20 by default; a cursor works only for its song and for 24 hours', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const id = await song(mara);
  const other = await song(mara);
  // 25 comments, three posted in the same second each time.
  const made = [];
  for (let i = 0; i < 25; i += 1) made.push(await comment(mara, id, `Comment ${i + 1}`, { step: i % 3 === 0 ? 1000 : 0 }));
  const docs = await Comment.find({ songId: id }).sort({ createdAt: -1, _id: -1 }).lean();
  const newestFirst = docs.map((doc) => String(doc._id));
  assert.equal(new Set(made.map((c) => c.createdAt)).size, 9, 'ties exist');
  const g = await guest();

  const first = await get(g, `/songs/${id}/comments`);
  assertOk(first, 'CommentPage');
  assert.deepEqual(ids(first), newestFirst.slice(0, 20));
  assert.equal(first.body.page.hasMore, true);
  const seen = [];
  let cursor = null;
  do {
    const res = await get(g, `/songs/${id}/comments?limit=7${cursor ? `&cursor=${cursor}` : ''}`);
    assertOk(res, 'CommentPage');
    assert.equal(res.body.page.total, seen.length === 0 ? 25 : 26);
    seen.push(...ids(res));
    cursor = res.body.page.nextCursor;
    assert.equal(res.body.page.hasMore, cursor !== null);
    // A comment posted meanwhile is newer than every page: it shifts nothing.
    if (seen.length === 7) await comment(mara, id, 'Posted while paging');
  } while (cursor);
  assert.deepEqual(seen, newestFirst);

  const { nextCursor } = (await get(g, `/songs/${id}/comments?limit=2`)).body.page;
  const elsewhere = await get(g, `/songs/${other}/comments?cursor=${nextCursor}`);
  assertProblem(elsewhere, 422, 'CURSOR_INVALID');
  assert.equal(elsewhere.body.errors[0].field, 'cursor');
  const top = docs[0];
  assertProblem(await get(g, `/comments/${top._id}/replies?cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  clock.t += CURSOR_TTL_MS - 1000;
  assert.equal((await get(g, `/songs/${id}/comments?limit=2&cursor=${nextCursor}`)).status, 200);
  clock.t += 2000;
  assertProblem(await get(g, `/songs/${id}/comments?limit=2&cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  clock.t -= CURSOR_TTL_MS;
  const decoded = JSON.parse(Buffer.from(nextCursor, 'base64url').toString('utf8'));
  const forge = (change) => Buffer.from(JSON.stringify({ ...decoded, ...change })).toString('base64url');
  for (const bad of ['not%20a%20cursor', 'bm90LWpzb24', forge({ i: 'nope' }), forge({ k: 'then' }), forge({ f: 'other' }),
    forge({ t: Math.floor((clock.t + 60 * 60 * 1000) / 1000) }), Buffer.from('null').toString('base64url')]) {
    assertProblem(await get(g, `/songs/${id}/comments?cursor=${bad}`), 422, 'CURSOR_INVALID');
  }
  for (const query of ['limit=0', 'limit=51', 'limit=x', `cursor=${'a'.repeat(513)}`, 'other=1']) {
    assertProblem(await get(g, `/songs/${id}/comments?${query}`), 422, 'VALIDATION_FAILED');
  }
});

test('GET comments: CONTENT_NOT_FOUND for what is not a song; a followers-only song (or album) is CONTENT_RESTRICTED except for its artist', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const me = await account();
  const g = await guest();
  const closed = await song(mara, { followersOnly: true });
  const onClosedAlbum = await song(mara, { albumId: await add(mara, { type: 'album', followersOnly: true }), trackNumber: 1 });
  const top = await comment(mara, closed, 'For followers');
  const reply = await replyTo(mara, top.id, 'Still for followers');
  for (const who of [me, g]) {
    for (const url of [`/songs/${closed}/comments`, `/songs/${onClosedAlbum}/comments`, `/comments/${top.id}/replies`, `/comments/${reply.id}/replies`]) {
      const res = await get(who, url);
      assertProblem(res, 403, 'CONTENT_RESTRICTED');
      assertMatchesSpec('Problem', res.body);
    }
  }
  for (const write of [() => postReply(me, top.id, 'Hi'), () => likeIt(me, top.id), () => unlikeIt(me, reply.id)]) {
    assertProblem(await write(), 403, 'CONTENT_RESTRICTED');
  }
  assertOk(await get(mara, `/songs/${closed}/comments`), 'CommentPage');
  assertOk(await get(mara, `/comments/${top.id}/replies`), 'CommentReplyPage');
  for (const songId of [oid(), await add(mara, { type: 'playlist' }), 'nope']) {
    assertProblem(await get(me, `/songs/${songId}/comments`), 404, 'CONTENT_NOT_FOUND');
  }
});

test('likedByMe and isMine are the viewer\'s in pages, replies and latestComment; always false for guests', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane' });
  const theo = await account({ name: 'Theo Brannick' });
  const id = await song(mara);
  const top = await comment(amelia, id, 'Lovely');
  const reply = await replyTo(theo, top.id, 'Agreed');
  await svc.likeComment(authOf(amelia), reply.id);
  await svc.likeComment(authOf(theo), top.id);
  await svc.likeComment(authOf(mara), top.id);
  const view = async (who) => {
    const page = (await get(who, `/songs/${id}/comments`)).body.data[0];
    const replies = (await get(who, `/comments/${top.id}/replies`)).body.data[0];
    const latest = (await get(who, `/songs/${id}`)).body.latestComment;
    return [page.likedByMe, page.isMine, page.likeCount, page.replies[0].likedByMe, page.replies[0].isMine,
      replies.likedByMe, replies.isMine, latest.likedByMe, latest.isMine];
  };
  assert.deepEqual(await view(amelia), [false, true, 2, true, false, true, false, false, true]);
  assert.deepEqual(await view(theo), [true, false, 2, false, true, false, true, true, false]);
  assert.deepEqual(await view(mara), [true, false, 2, false, false, false, false, true, false]);
  assert.deepEqual(await view(await guest()), [false, false, 2, false, false, false, false, false, false]);
  const asGuest = await svc.listSongComments(GUEST_AUTH, id);
  assert.deepEqual([asGuest.data[0].likedByMe, asGuest.data[0].isMine], [false, false]);
});

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

test('POST /comments/{id}/replies: 201 under the comment; a reply to a reply goes under its top-level comment; the counts move', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane' });
  const id = await song(mara);
  const top = await comment(mara, id, 'Thanks for listening');
  clock.t += 1000;
  const res = await postReply(amelia, top.id.toUpperCase(), '  Agreed, that part gets me every time.  ');
  assertOk(res, 'Comment', 201);
  assert.deepEqual(res.body, {
    id: res.body.id, parentId: top.id, author: { id: String(amelia.user._id), name: 'Amelia Jane', avatar: null },
    text: 'Agreed, that part gets me every time.', createdAt: iso(clock.t), likeCount: 0, likedByMe: false, replyCount: 0, isMine: true,
  });
  clock.t += 1000;
  const deeper = await postReply(mara, res.body.id, 'Replying to the reply');
  assertOk(deeper, 'Comment', 201);
  assert.equal(deeper.body.parentId, top.id, 'one level deep: under the top-level comment');
  assert.equal((await Comment.findById(deeper.body.id).lean()).parentId.toString(), top.id);
  const page = (await get(amelia, `/songs/${id}/comments`)).body;
  assert.deepEqual([page.commentCount, page.page.total, page.data[0].replyCount], [3, 1, 2]);
  assert.deepEqual(page.data[0].replies.map((r) => r.id), [res.body.id, deeper.body.id]);
  assert.equal((await get(amelia, `/songs/${id}`)).body.latestComment.id, top.id, 'the latest comment is top-level');
  for (const target of [oid(), 'not-an-id']) assertProblem(await postReply(amelia, target, 'Hi'), 404, 'COMMENT_NOT_FOUND');
  await assertCounters(id);
});

test('GET /comments/{id}/replies: oldest first by pages, page.total the replyCount; a reply\'s replies are none; COMMENT_NOT_FOUND', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const id = await song(mara);
  const top = await comment(mara, id);
  const other = await comment(mara, id);
  const replies = [];
  for (let i = 0; i < 12; i += 1) replies.push(await replyTo(mara, top.id, `Reply ${i + 1}`, { step: i % 2 ? 0 : 1000 }));
  await replyTo(mara, other.id);
  const oldestFirst = (await Comment.find({ parentId: top.id }).sort({ createdAt: 1, _id: 1 }).lean()).map((doc) => String(doc._id));
  const g = await guest();
  const whole = await get(g, `/comments/${top.id}/replies`);
  assertOk(whole, 'CommentReplyPage');
  assert.deepEqual(ids(whole), oldestFirst);
  assert.deepEqual(whole.body.page, { nextCursor: null, hasMore: false, total: 12 });
  assert.ok(whole.body.data.every((r) => r.parentId === top.id && !Object.hasOwn(r, 'replies')));
  const seen = [];
  let cursor = null;
  do {
    const res = await get(g, `/comments/${top.id}/replies?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
    assertOk(res, 'CommentReplyPage');
    seen.push(...ids(res));
    cursor = res.body.page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, oldestFirst);
  const { nextCursor } = (await get(g, `/comments/${top.id}/replies?limit=1`)).body.page;
  assertProblem(await get(g, `/comments/${other.id}/replies?cursor=${nextCursor}`), 422, 'CURSOR_INVALID');
  assertProblem(await get(g, `/songs/${id}/comments?cursor=${nextCursor}`), 422, 'CURSOR_INVALID');

  const ofReply = await get(g, `/comments/${replies[0].id}/replies`);
  assertOk(ofReply, 'CommentReplyPage');
  assert.deepEqual(ofReply.body, { data: [], page: { nextCursor: null, hasMore: false, total: 0 } });
  for (const target of [oid(), 'not-an-id']) assertProblem(await get(g, `/comments/${target}/replies`), 404, 'COMMENT_NOT_FOUND');
  await Content.deleteOne({ _id: id });
  assertProblem(await get(g, `/comments/${top.id}/replies`), 404, 'COMMENT_NOT_FOUND', 'a comment whose song is gone');
});

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

test('PUT and DELETE /comments/{id}/like: idempotent, per account, on comments and replies; they answer likeCount and likedByMe', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const me = await account();
  const other = await account();
  const id = await song(mara);
  const top = await comment(mara, id);
  const reply = await replyTo(mara, top.id);

  const liked = await likeIt(me, top.id);
  assertOk(liked, 'CommentLike');
  assert.deepEqual(liked.body, { likeCount: 1, likedByMe: true });
  assert.deepEqual((await likeIt(me, top.id.toUpperCase())).body, { likeCount: 1, likedByMe: true }, 'liking again changes nothing');
  assert.deepEqual((await likeIt(other, top.id)).body, { likeCount: 2, likedByMe: true });
  assert.deepEqual((await likeIt(me, reply.id)).body, { likeCount: 1, likedByMe: true });
  assert.equal(await CommentLike.countDocuments({ commentId: top.id }), 2);

  const unliked = await unlikeIt(me, top.id);
  assertOk(unliked, 'CommentLike');
  assert.deepEqual(unliked.body, { likeCount: 1, likedByMe: false });
  assert.deepEqual((await unlikeIt(me, top.id)).body, { likeCount: 1, likedByMe: false }, 'unliking again changes nothing');
  assert.deepEqual((await unlikeIt(mara, top.id)).body, { likeCount: 1, likedByMe: false }, 'unliking one not liked changes nothing');
  assert.equal((await get(other, `/songs/${id}/comments`)).body.data[0].likedByMe, true);
  assert.equal((await get(me, `/songs/${id}/comments`)).body.data[0].likedByMe, false);
  for (const target of [oid(), 'not-an-id']) {
    assertProblem(await likeIt(me, target), 404, 'COMMENT_NOT_FOUND');
    assertProblem(await unlikeIt(me, target), 404, 'COMMENT_NOT_FOUND');
  }
  await assertCounters(id);
});

// ---------------------------------------------------------------------------
// DELETE /comments/{commentId}
// ---------------------------------------------------------------------------

test('DELETE /comments/{id}: its author or the song\'s artist; anyone else 403 FORBIDDEN; a reply goes alone and the counts drop', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane' });
  const theo = await account({ name: 'Theo Brannick' });
  const id = await song(mara);
  const top = await comment(amelia, id);
  const r1 = await replyTo(theo, top.id);
  const r2 = await replyTo(amelia, top.id);
  const r3 = await replyTo(theo, top.id);
  await svc.likeComment(authOf(amelia), r1.id);
  await svc.likeComment(authOf(mara), r2.id);

  for (const [who, target] of [[theo, top.id], [theo, r2.id], [amelia, r1.id]]) {
    const res = await deleteIt(who, target);
    assertProblem(res, 403, 'FORBIDDEN');
    assertMatchesSpec('Problem', res.body);
  }
  assert.equal(await Comment.countDocuments(), 4);

  const byAuthor = await deleteIt(theo, r1.id);
  assert.equal(byAuthor.status, 204, byAuthor.text);
  assert.equal(byAuthor.text, '');
  assert.equal((await deleteIt(mara, r2.id.toUpperCase())).status, 204, 'the song\'s artist deletes any comment on it');
  assert.equal(await CommentLike.countDocuments(), 0, 'their likes went with them');
  const page = (await get(amelia, `/songs/${id}/comments`)).body;
  assert.deepEqual([page.commentCount, page.data[0].replyCount, page.data[0].replies.map((r) => r.id)], [2, 1, [r3.id]]);
  assertProblem(await deleteIt(theo, r1.id), 404, 'COMMENT_NOT_FOUND', 'already deleted');
  for (const target of [oid(), 'not-an-id']) assertProblem(await deleteIt(theo, target), 404, 'COMMENT_NOT_FOUND');
  await assertCounters(id);
});

test('deleting a top-level comment deletes its replies and every like of them; the counts drop at once', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane' });
  const theo = await account({ name: 'Theo Brannick' });
  const id = await song(mara);
  const keep = await comment(theo, id, 'Stays');
  const keepReply = await replyTo(amelia, keep.id, 'Stays too');
  const top = await comment(amelia, id, 'Goes');
  const replies = [];
  for (let i = 0; i < 4; i += 1) replies.push(await replyTo(i % 2 ? theo : mara, top.id, `Goes too ${i + 1}`));
  for (const who of [mara, theo]) {
    await svc.likeComment(authOf(who), top.id);
    for (const r of replies) await svc.likeComment(authOf(who), r.id);
    await svc.likeComment(authOf(who), keep.id);
  }
  await svc.likeComment(authOf(mara), keepReply.id);
  assert.equal((await get(theo, `/songs/${id}`)).body.latestComment.id, top.id);

  assert.equal((await deleteIt(amelia, top.id)).status, 204);
  assert.deepEqual((await Comment.find().lean()).map((doc) => String(doc._id)).sort(), [keep.id, keepReply.id].sort());
  assert.deepEqual((await CommentLike.find().lean()).map((row) => String(row.commentId)).sort(), [keep.id, keep.id, keepReply.id].sort());
  const songNow = (await get(theo, `/songs/${id}`)).body;
  assert.deepEqual([songNow.commentCount, songNow.latestComment.id, songNow.latestComment.likeCount], [2, keep.id, 2]);
  for (const r of replies) assertProblem(await likeIt(theo, r.id), 404, 'COMMENT_NOT_FOUND');
  assertProblem(await deleteIt(amelia, top.id), 404, 'COMMENT_NOT_FOUND');
  await assertCounters(id);

  assert.equal((await deleteIt(mara, keep.id)).status, 204, 'the artist deletes a thread of someone else');
  const empty = (await get(theo, `/songs/${id}`)).body;
  assert.deepEqual([empty.commentCount, empty.latestComment], [0, null]);
  assert.equal(await CommentLike.countDocuments(), 0);
  await assertCounters(id);
});

test('an author may delete their comment on a song that became followers-only; when the song is gone, only its author may', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane' });
  const theo = await account();
  const id = await song(mara);
  const one = await comment(amelia, id);
  const two = await comment(theo, id);
  const three = await comment(theo, id);
  await Content.updateOne({ _id: id }, { $set: { followersOnly: true } });
  assertProblem(await get(amelia, `/songs/${id}/comments`), 403, 'CONTENT_RESTRICTED');
  assert.equal((await deleteIt(amelia, one.id)).status, 204, 'no CONTENT_RESTRICTED on delete');
  assert.equal(await storedCount(id), 2);
  await Content.deleteOne({ _id: id });
  assertProblem(await deleteIt(mara, two.id), 403, 'FORBIDDEN');
  assert.equal((await deleteIt(theo, three.id)).status, 204);
  assert.equal(await Comment.countDocuments(), 1);
});

// ---------------------------------------------------------------------------
// Counters under concurrency, and failures
// ---------------------------------------------------------------------------

test('posts, replies, likes and deletes running at once leave every counter equal to its rows, and no reply without its comment', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const people = [mara];
  for (let i = 0; i < 4; i += 1) people.push(await account());
  const id = await song(mara);
  const notFound = (err) => {
    assert.equal(err.code, 'COMMENT_NOT_FOUND', err.stack);
    return null;
  };
  for (let round = 0; round < 4; round += 1) {
    const top = await comment(people[round % 5], id, `Thread ${round}`);
    const keep = await comment(people[(round + 1) % 5], id, `Kept ${round}`);
    const first = await replyTo(people[2], top.id);
    const tasks = [];
    for (let i = 0; i < 10; i += 1) {
      const who = authOf(people[i % 5]);
      tasks.push(svc.postCommentReply(who, i % 3 ? top.id : first.id, { text: `r${i}` }).catch(notFound));
      tasks.push(svc.postCommentReply(who, keep.id, { text: `k${i}` }));
      tasks.push(svc.likeComment(who, i % 2 ? top.id : keep.id).catch(notFound));
      if (i === 4 + round) tasks.push(svc.deleteComment(authOf(mara), top.id));
      if (i % 4 === 0) tasks.push(svc.unlikeComment(who, keep.id));
      if (i === 7) tasks.push(svc.postSongComment(who, id, { text: 'Another' }));
    }
    tasks.push(svc.deleteComment(authOf(people[2]), first.id).catch(notFound));
    await Promise.all(tasks);
    assert.equal(await Comment.exists({ _id: top.id }), null);
    await assertCounters(id);
  }
  // Two deletes of one reply at once: one deletes it, the other finds it gone.
  const thread = await comment(people[1], id);
  const reply = await replyTo(people[1], thread.id);
  const outcomes = await Promise.allSettled([svc.deleteComment(authOf(people[1]), reply.id), svc.deleteComment(authOf(mara), reply.id)]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
  await assertCounters(id);
  // Many accounts liking and unliking one comment at once.
  const liked = await comment(mara, id);
  await Promise.all(people.flatMap((who) => [svc.likeComment(authOf(who), liked.id), svc.likeComment(authOf(who), liked.id)]));
  assert.equal((await Comment.findById(liked.id).lean()).likeCount, 5);
  await Promise.all(people.slice(0, 3).flatMap((who) => [svc.unlikeComment(authOf(who), liked.id), svc.unlikeComment(authOf(who), liked.id)]));
  assert.equal((await Comment.findById(liked.id).lean()).likeCount, 2);
  await assertCounters(id);
});

test('a reply stored while its comment is being deleted is deleted again (404 COMMENT_NOT_FOUND); the counts stay right', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane' });
  const id = await song(mara);
  const interleave = async (hook) => {
    const top = await comment(amelia, id, 'Going soon');
    const earlier = await replyTo(mara, top.id, 'Earlier reply');
    await svc.likeComment(authOf(mara), earlier.id);
    const service = commentsWith({ comments: hook(() => svc.deleteComment(authOf(amelia), top.id)) });
    await assert.rejects(service.postCommentReply(authOf(mara), top.id, { text: 'Too late' }), (err) => err.code === 'COMMENT_NOT_FOUND');
    assert.equal(await Comment.countDocuments({ songId: id }), 0, 'no reply outlives its comment');
    await assertCounters(id);
  };
  // The delete runs right after the reply is stored: its sweep finds the reply.
  await interleave((deleteNow) => ({
    ...commentsRepo, create: async (fields) => { const doc = await commentsRepo.create(fields); await deleteNow(); return doc; },
  }));
  // The delete runs after the reply counted but before it is stored: the sweep misses it, the reply's request deletes it.
  await interleave((deleteNow) => ({ ...commentsRepo, create: async (fields) => { await deleteNow(); return commentsRepo.create(fields); } }));
  // The delete runs before the reply counted: nothing is stored.
  await interleave((deleteNow) => ({
    ...commentsRepo, addReplies: async (...args) => { if (args[1] > 0) await deleteNow(); return commentsRepo.addReplies(...args); },
  }));
  assert.equal(await storedCount(id), 0);
});

test('a like stored while its comment is deleted goes too (404); a failed write puts the counts back; counters never go below 0', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane' });
  const id = await song(mara);
  const top = await comment(amelia, id);
  const racing = commentsWith({
    comments: { ...commentsRepo, addLike: async (like) => { await svc.deleteComment(authOf(amelia), top.id); return commentsRepo.addLike(like); } },
  });
  await assert.rejects(racing.likeComment(authOf(mara), top.id), (err) => err.code === 'COMMENT_NOT_FOUND');
  assert.equal(await CommentLike.countDocuments(), 0);
  await assertCounters(id);

  const broken = (name) => commentsWith({ comments: { ...commentsRepo, [name]: async () => { throw new Error('the database went away'); } } });
  const kept = await comment(amelia, id);
  await assert.rejects(broken('create').postSongComment(authOf(mara), id, { text: 'Lost' }), /went away/);
  await assert.rejects(broken('create').postCommentReply(authOf(mara), kept.id, { text: 'Lost' }), /went away/);
  await assert.rejects(broken('addLike').likeComment(authOf(mara), kept.id), /went away/);
  const target = buildApp({ comments: broken('create') });
  assertProblem(await postComment(mara, id, 'Lost too', { target }), 500, 'INTERNAL_ERROR');
  await assertCounters(id);
  assert.deepEqual([await storedCount(id), (await Comment.findById(kept.id).lean()).replyCount], [1, 0]);

  // Counters that are already wrong (written elsewhere) stop at 0.
  await svc.likeComment(authOf(mara), kept.id);
  await Comment.updateOne({ _id: kept.id }, { $set: { likeCount: 0 } });
  await Content.updateOne({ _id: id }, { $unset: { commentCount: '' } });
  assert.deepEqual((await unlikeIt(mara, kept.id)).body, { likeCount: 0, likedByMe: false });
  assert.equal((await deleteIt(amelia, kept.id)).status, 204);
  assert.equal(await storedCount(id), 0);
  await Content.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { commentCount: 'many' } });
  assertOk(await postComment(mara, id, 'Counted from 0'), 'Comment', 201);
  assert.equal(await storedCount(id), 1);
});

// ---------------------------------------------------------------------------
// Song.commentCount and Song.latestComment
// ---------------------------------------------------------------------------

test('Song.commentCount and latestComment wherever a Song is built: one song, a list, an album, a playlist, Liked songs', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const me = await account({ name: 'Tess Listener' });
  const albumId = await add(mara, { type: 'album', title: 'Paper Lanterns', songCount: 2 });
  const s1 = await song(mara, { albumId, trackNumber: 1 });
  const s2 = await song(mara, { albumId, trackNumber: 2 });
  const s3 = await song(mara, { title: 'A single' });
  const closed = await song(mara, { followersOnly: true });
  const listId = await add(mara, { type: 'playlist', songCount: 4 });
  await PlaylistItem.insertMany([s3, s1, s2, closed].map((songId, i) => ({ playlistId: listId, songId, position: i + 1, addedAt: new Date() })));
  await SongLike.insertMany([s1, s3, closed].map((songId, i) => ({ userId: me.user._id, songId, likedAt: new Date(clock.t - i * 1000) })));

  const old = await comment(mara, s1, 'Older');
  const newest = await comment(me, s1, 'Newest top-level');
  await replyTo(mara, old.id, 'A reply, newer still');
  await svc.likeComment(authOf(me), newest.id);
  const single = await comment(mara, s3, 'On the single');
  await comment(mara, closed, 'For followers');

  const latestFor = async (who, songId) => ({ ...(await get(who, `/songs/${songId}/comments`)).body.data[0], replies: [] });
  const expected = {
    [s1]: [3, await latestFor(me, s1)],
    [s2]: [0, null],
    [s3]: [1, await latestFor(me, s3)],
    [closed]: [1, null],
  };
  assert.deepEqual([expected[s1][1].id, expected[s1][1].isMine, expected[s1][1].likedByMe], [newest.id, true, true]);
  assert.equal(expected[s3][1].id, single.id);
  const check = (songs, what) => {
    for (const s of songs) assert.deepEqual([s.commentCount, s.latestComment], expected[s.id], `${what} ${s.id}`);
  };
  for (const songId of [s1, s2, s3, closed]) {
    const res = await get(me, `/songs/${songId}`);
    assertOk(res, 'Song');
    check([res.body], 'getSong');
  }
  const list = await get(me, `/songs?ids=${[s1, s2, s3, closed].join(',')}`);
  assertOk(list, 'SongList');
  check(list.body.data, 'listSongs');
  const albumRes = await get(me, `/albums/${albumId}`);
  assertOk(albumRes, 'Album');
  check(albumRes.body.songs, 'getAlbum');
  const listRes = await get(me, `/playlists/${listId}/songs`);
  assertOk(listRes, 'SongPage');
  check(listRes.body.data, 'listPlaylistSongs');
  const likedRes = await get(me, '/me/liked-songs');
  assertOk(likedRes, 'LikedSongPage');
  check(likedRes.body.data, 'listLikedSongs');

  // A followers-only song keeps its count, but its comments are its artist's to read.
  const forArtist = (await get(mara, `/songs/${closed}`)).body;
  assert.deepEqual([forArtist.commentCount, forArtist.latestComment.text, forArtist.latestComment.isMine], [1, 'For followers', true]);
  const forGuest = (await get(await guest(), `/songs?ids=${s1},${closed}`)).body.data;
  assert.deepEqual(forGuest.map((s) => [s.commentCount, s.latestComment && s.latestComment.id]), [[3, newest.id], [1, null]]);
  assert.deepEqual([forGuest[0].latestComment.isMine, forGuest[0].latestComment.likedByMe], [false, false]);
});

test('authors are users (name null when none, the avatar as an Image), read once per page together with the viewer\'s likes', async () => {
  const mara = await account({ name: 'Mara Quillon' });
  const amelia = await account({ name: 'Amelia Jane', avatar: AVATAR });
  const blank = await account({ name: '' });
  const gone = await account({ name: 'Left Already' });
  const id = await song(mara);
  const other = await song(mara);
  for (const who of [mara, amelia, blank, gone]) {
    const top = await comment(who, id, 'Top');
    for (const replier of [amelia, blank, gone, mara]) await replyTo(replier, top.id, 'Re');
    await svc.likeComment(authOf(amelia), top.id);
  }
  await comment(gone, other, 'Elsewhere');
  await User.deleteOne({ _id: gone.user._id });

  const calls = { users: 0, likes: 0 };
  const counting = commentsWith({
    users: { ...usersRepo, findSummaries: (list) => { calls.users += 1; return usersRepo.findSummaries(list); } },
    comments: { ...commentsRepo, likedAmong: (input) => { calls.likes += 1; return commentsRepo.likedAmong(input); } },
  });
  const page = await counting.listSongComments(authOf(amelia), id);
  assert.deepEqual(calls, { users: 1, likes: 1 }, 'one read of the authors and one of the likes for 4 comments and 12 replies');
  assert.equal(page.data.length + page.data.reduce((n, c) => n + c.replies.length, 0), 16);
  const authors = new Map(page.data.flatMap((c) => [c, ...c.replies]).map((c) => [c.author.id, c.author]));
  assert.deepEqual(authors.get(String(amelia.user._id)), {
    id: String(amelia.user._id), name: 'Amelia Jane', avatar: toImage(AVATAR, (key) => storage.publicUrl(key)),
  });
  assert.deepEqual(authors.get(String(blank.user._id)), { id: String(blank.user._id), name: null, avatar: null });
  assert.deepEqual(authors.get(String(gone.user._id)), { id: String(gone.user._id), name: null, avatar: null });
  assert.ok(page.data.every((c) => c.likedByMe));
  await counting.listCommentReplies(authOf(amelia), page.data[0].id);
  const latest = await counting.latestComments(authOf(amelia), [id, other]);
  assert.deepEqual(calls, { users: 3, likes: 3 }, 'once for the replies page, once for both songs\' latest comments');
  assert.deepEqual([...latest.keys()].sort(), [id, other].sort());
  assert.deepEqual((await counting.latestComments(GUEST_AUTH, [id])).get(id).likedByMe, false);
  assert.equal(calls.likes, 3, 'a guest has no likes to read');
});

// ---------------------------------------------------------------------------
// Rate limits, the spec, indexes
// ---------------------------------------------------------------------------

test('posting is limited to 10 a minute per account, comments and replies together; other operations count on their own', async () => {
  const target = buildApp();
  const mara = await account({ name: 'Mara Quillon' });
  const me = await account();
  const id = await song(mara);
  const top = await comment(mara, id);
  for (let i = 0; i < 10; i += 1) {
    const res = i % 2 ? await postComment(me, id, `Post ${i}`, { target }) : await postReply(me, top.id, `Reply ${i}`, { target });
    assert.equal(res.status, 201, `request ${i + 1}: ${res.text}`);
  }
  for (const limited of [await postComment(me, id, 'One more', { target }), await postReply(me, top.id, 'One more', { target })]) {
    assertProblem(limited, 429, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
  }
  assert.equal((await postComment(mara, id, 'Another account', { target })).status, 201, 'another account has its own count');
  assert.equal((await get(me, `/songs/${id}/comments`, { target })).status, 200, 'reading has its own count');
  assert.equal((await likeIt(me, top.id, { target })).status, 200, 'liking has its own count');
  await assertCounters(id);
});

test('the spec: the Comments operations, their rate limits, and the codes they use', () => {
  const operations = {
    listSongComments: ['/songs/{songId}/comments', 'get', 'listSongComments'],
    postSongComment: ['/songs/{songId}/comments', 'post', 'postComment'],
    listCommentReplies: ['/comments/{commentId}/replies', 'get', 'listCommentReplies'],
    postCommentReply: ['/comments/{commentId}/replies', 'post', 'postComment'],
    likeComment: ['/comments/{commentId}/like', 'put', 'likeComment'],
    unlikeComment: ['/comments/{commentId}/like', 'delete', 'unlikeComment'],
    deleteComment: ['/comments/{commentId}', 'delete', 'deleteComment'],
  };
  assert.deepEqual(Object.keys(LIMITS).sort(), [...new Set(Object.values(operations).map(([, , limit]) => limit))].sort());
  for (const [operationId, [route, method, limit]] of Object.entries(operations)) {
    const operation = spec.paths[route][method];
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.tags, ['Comments']);
    const [rule] = operation['x-rate-limit'];
    assert.deepEqual([rule.key, rule.limit, rule.window], ['account', LIMITS[limit].points, '1m'], operationId);
    assert.equal(LIMITS[limit].durationSeconds, 60);
  }
  for (const code of ['GUEST_NOT_ALLOWED', 'FORBIDDEN', 'CONTENT_NOT_FOUND', 'CONTENT_RESTRICTED', 'COMMENT_NOT_FOUND', 'CURSOR_INVALID',
    'VALIDATION_FAILED', 'IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED']) {
    assert.ok(spec.components.schemas.ErrorCode.enum.includes(code), code);
  }
});

test('the indexes: one for a song\'s comments and a comment\'s replies, both without a sort in memory; a like once per account', async () => {
  const keysOf = async (Model) => Object.fromEntries((await Model.collection.indexes()).map((ix) => [ix.name, ix]));
  const comments = await keysOf(Comment);
  assert.deepEqual(comments.song_thread.key, { songId: 1, parentId: 1, createdAt: -1, _id: -1 });
  const likes = await keysOf(CommentLike);
  assert.deepEqual([likes.comment_user.key, likes.comment_user.unique], [{ commentId: 1, userId: 1 }, true]);

  const mara = await account({ name: 'Mara Quillon' });
  const id = await song(mara);
  const top = await comment(mara, id);
  await replyTo(mara, top.id);
  const plans = [
    await Comment.find({ songId: id, parentId: null }).sort({ createdAt: -1, _id: -1 }).limit(21).explain(),
    await Comment.find({ songId: id, parentId: top.id }).sort({ createdAt: 1, _id: 1 }).limit(21).explain(),
  ];
  for (const plan of plans) {
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    assert.match(winning, /song_thread/);
    assert.doesNotMatch(winning, /"stage":"SORT"/);
  }
  await CommentLike.create({ commentId: top.id, userId: mara.user._id, createdAt: new Date() });
  await assert.rejects(CommentLike.create({ commentId: top.id, userId: mara.user._id, createdAt: new Date() }), (err) => err.code === 11000);
});
