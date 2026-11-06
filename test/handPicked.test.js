process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const mongoose = require('mongoose');
const request = require('supertest');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { createApp } = require('../src/app');
const handPickedRepo = require('../src/modules/handPicked/repo');
const Content = require('../models/Content');
const User = require('../models/User');
const db = require('./support/db');
const { assertProblem, makeUser, signIn, CLIENT } = require('./support/api');

const app = createApp({ trustProxy: 1 });

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
const ajv = new Ajv2020({ strict: false, logger: false });
const assertMatchesSpec = (name, value) => assert.equal(
  ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value),
  true,
  `${name}: ${JSON.stringify(ajv.errors)}`,
);

before(db.connect);
beforeEach(db.clear);
after(db.disconnect);

async function account() {
  return signIn(await makeUser({ password: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', emailVerified: true }));
}

async function guest() {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(res.status, 201, res.text);
  return { headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

/** One item owned by `who`; items are made in order, so their ids (and the collection's order) ascend. */
async function item(who, fields = {}) {
  const doc = await Content.create({ ownerId: who.user._id, type: 'song', title: 'Untitled', durationSec: 200, ...fields });
  return String(doc._id);
}

/** Four items: a playlist, a song, a story and an album, in that order. */
async function library(who) {
  return {
    a: await item(who, { type: 'playlist', title: 'Alpha', songCount: 12 }),
    b: await item(who, { type: 'song', title: 'Bravo' }),
    c: await item(who, { type: 'story', title: 'Charlie' }),
    d: await item(who, { type: 'album', title: 'Delta', songCount: 9, year: 2024 }),
  };
}

const getPicked = (who) => request(app).get('/v1/me/hand-picked').set(who.headers);
const putPicked = (who, body) => request(app).put('/v1/me/hand-picked').set(who.headers).send(body);
const ids = (res) => res.body.items.map((c) => c.id);
/** The stored field, read straight from the collection (no model casting). */
const storedDoc = async (who) => User.collection.findOne({ _id: who.user._id });

/** A 200 `HandPicked` with these item ids, in this order, checked against the spec. */
function assertItems(res, expected) {
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('HandPicked', res.body);
  assert.equal(res.headers['cache-control'], 'private, no-cache');
  assert.deepEqual(ids(res), expected);
}

/** A 422 HAND_PICKED_INVALID whose `errors[]` point at exactly these indexes of `contentIds`. */
function assertInvalid(res, indexes) {
  assertProblem(res, 422, 'HAND_PICKED_INVALID');
  assertMatchesSpec('Problem', res.body);
  assert.deepEqual(res.body.errors.map((e) => e.field), indexes.map((i) => `/contentIds/${i}`));
  for (const e of res.body.errors) assert.equal(e.code, 'HAND_PICKED_INVALID');
}

// ---------------------------------------------------------------------------
// GET and PUT /me/hand-picked
// ---------------------------------------------------------------------------

test('an account that never picked anything gets an empty list, and nothing is stored', async () => {
  const me = await account();
  await library(me);
  assertItems(await getPicked(me), []);
  assert.equal(Object.hasOwn(await storedDoc(me), 'handPicked'), false);
});

test('PUT 3 items: the answer and GET keep the order sent, stored as ObjectIds in users.handPicked', async () => {
  const me = await account();
  const s = await library(me);
  const order = [s.c, s.a, s.d];
  assertItems(await putPicked(me, { contentIds: order }), order);
  assertItems(await getPicked(me), order);
  const stored = await storedDoc(me);
  assert.ok(Array.isArray(stored.handPicked));
  assert.ok(stored.handPicked.every((id) => id instanceof mongoose.Types.ObjectId), 'stored as ObjectIds');
  assert.deepEqual(stored.handPicked.map(String), order);
});

test('reordering (drag) and swapping items replace the list in the new order', async () => {
  const me = await account();
  const s = await library(me);
  await putPicked(me, { contentIds: [s.a, s.b, s.c] });
  assertItems(await putPicked(me, { contentIds: [s.c, s.a, s.b] }), [s.c, s.a, s.b]);
  assertItems(await getPicked(me), [s.c, s.a, s.b]);
  assertItems(await putPicked(me, { contentIds: [s.b, s.d] }), [s.b, s.d]);
  assertItems(await getPicked(me), [s.b, s.d]);
  assert.deepEqual((await storedDoc(me)).handPicked.map(String), [s.b, s.d]);
});

test('PUT is idempotent: the same list again gives the same answer and the same stored list', async () => {
  const me = await account();
  const s = await library(me);
  const first = await putPicked(me, { contentIds: [s.d, s.b] });
  const second = await putPicked(me, { contentIds: [s.d, s.b] });
  assertItems(second, [s.d, s.b]);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual((await storedDoc(me)).handPicked.map(String), [s.d, s.b]);
});

test('PUT [] clears the list', async () => {
  const me = await account();
  const s = await library(me);
  await putPicked(me, { contentIds: [s.a, s.b, s.c] });
  assertItems(await putPicked(me, { contentIds: [] }), []);
  assertItems(await getPicked(me), []);
  assert.deepEqual((await storedDoc(me)).handPicked, []);
  assertItems(await putPicked(me, { contentIds: [s.d] }), [s.d]);
});

test('the items have the full Content shape, as /me/content gives them', async () => {
  const me = await account();
  const s = await library(me);
  const res = await putPicked(me, { contentIds: [s.d, s.a] });
  assertItems(res, [s.d, s.a]);
  const listed = await request(app).get('/v1/me/content').set(me.headers);
  assert.equal(listed.status, 200, listed.text);
  const fromList = new Map(listed.body.data.map((c) => [c.id, c]));
  assert.deepEqual(res.body.items, [fromList.get(s.d), fromList.get(s.a)]);
  assert.equal(res.body.items[0].type, 'album');
  assert.equal(res.body.items[0].songCount, 9);
  assert.equal(res.body.items[0].year, 2024);
});

test('a 4th id is refused by the validator (VALIDATION_FAILED) and nothing changes', async () => {
  const me = await account();
  const s = await library(me);
  await putPicked(me, { contentIds: [s.a, s.b] });
  const res = await putPicked(me, { contentIds: [s.a, s.b, s.c, s.d] });
  assertProblem(res, 422, 'VALIDATION_FAILED');
  assert.deepEqual(res.body.errors.map((e) => e.field), ['/contentIds']);
  assertItems(await getPicked(me), [s.a, s.b]);
});

test('a body in another shape is refused by the validator', async () => {
  const me = await account();
  const s = await library(me);
  const bodies = [
    {}, { contentIds: s.a }, { contentIds: null }, { contentIds: [1] }, { contentIds: [''] }, { contentIds: ['x'.repeat(65)] },
    { contentIds: [s.a], extra: true }, { ids: [s.a] }, [s.a],
  ];
  for (const body of bodies) {
    assertProblem(await putPicked(me, body), 422, 'VALIDATION_FAILED');
  }
  const broken = await request(app).put('/v1/me/hand-picked').set({ ...me.headers, 'Content-Type': 'application/json' }).send('{"contentIds":');
  assertProblem(broken, 400, 'MALFORMED_REQUEST');
  assertProblem(await request(app).put('/v1/me/hand-picked').set(me.headers), 400, 'MALFORMED_REQUEST');
  assert.equal(Object.hasOwn(await storedDoc(me), 'handPicked'), false);
});

test('a duplicate id is HAND_PICKED_INVALID, also when it differs only by case, and nothing changes', async () => {
  const me = await account();
  const s = await library(me);
  await putPicked(me, { contentIds: [s.d] });
  assertInvalid(await putPicked(me, { contentIds: [s.a, s.a] }), [1]);
  assertInvalid(await putPicked(me, { contentIds: [s.a, s.b, s.a] }), [2]);
  assertInvalid(await putPicked(me, { contentIds: [s.b, s.b.toUpperCase()] }), [1]);
  assertItems(await getPicked(me), [s.d]);
});

test('an id may differ in case from the stored one: it is the same item', async () => {
  const me = await account();
  const s = await library(me);
  assertItems(await putPicked(me, { contentIds: [s.c.toUpperCase(), s.a] }), [s.c, s.a]);
  assertItems(await getPicked(me), [s.c, s.a]);
});

test('someone else\'s item is HAND_PICKED_INVALID, answered as an unknown one, and nothing changes', async () => {
  const me = await account();
  const other = await account();
  const s = await library(me);
  const theirs = await item(other, { title: 'Not yours' });
  await putPicked(me, { contentIds: [s.a] });
  const res = await putPicked(me, { contentIds: [s.b, theirs] });
  assertInvalid(res, [1]);
  const unknown = await putPicked(me, { contentIds: [s.b, String(new mongoose.Types.ObjectId())] });
  assert.deepEqual(unknown.body.errors, res.body.errors, 'the same answer: it never says whether an id exists');
  assertItems(await getPicked(me), [s.a]);
  assertItems(await getPicked(other), []);
});

test('unknown and malformed ids are HAND_PICKED_INVALID, one error per bad id', async () => {
  const me = await account();
  const s = await library(me);
  const unknown = String(new mongoose.Types.ObjectId());
  assertInvalid(await putPicked(me, { contentIds: [unknown] }), [0]);
  assertInvalid(await putPicked(me, { contentIds: ['not-an-id', s.a, unknown] }), [0, 2]);
  assertInvalid(await putPicked(me, { contentIds: ['zzzzzzzzzzzzzzzzzzzzzzzz'] }), [0]);
  const deleted = await item(me, { title: 'Gone' });
  await Content.deleteOne({ _id: deleted });
  assertInvalid(await putPicked(me, { contentIds: [s.a, deleted] }), [1]);
  assert.equal(Object.hasOwn(await storedDoc(me), 'handPicked'), false);
});

test('GET skips an item deleted after it was picked, and keeps the stored list as it is', async () => {
  const me = await account();
  const s = await library(me);
  await putPicked(me, { contentIds: [s.c, s.b, s.a] });
  await Content.deleteOne({ _id: s.b });
  assertItems(await getPicked(me), [s.c, s.a]);
  assert.deepEqual((await storedDoc(me)).handPicked.map(String), [s.c, s.b, s.a]);
  // Every item gone: an empty list, not an error.
  await Content.deleteMany({ ownerId: me.user._id });
  assertItems(await getPicked(me), []);
});

test('a hidden or followers-only item can be picked and comes back with its flags', async () => {
  const me = await account();
  const s = await library(me);
  const hidden = await item(me, { title: 'Hidden', hidden: true });
  const restricted = await item(me, { title: 'Restricted', followersOnly: true });
  const res = await putPicked(me, { contentIds: [hidden, s.a, restricted] });
  assertItems(res, [hidden, s.a, restricted]);
  assert.deepEqual(res.body.items.map((c) => [c.hidden, c.followersOnly]), [[true, false], [false, false], [false, true]]);
  // Hidden later through Privacy > Hide Content: still listed, now flagged.
  const patched = await request(app).patch(`/v1/me/content/${s.a}`).set(me.headers).send({ hidden: true });
  assert.equal(patched.status, 200, patched.text);
  const after = await getPicked(me);
  assertItems(after, [hidden, s.a, restricted]);
  assert.equal(after.body.items[1].hidden, true);
});

test('hand-picked needs a session and an account; a deleted account is signed out', async () => {
  assertProblem(await request(app).get('/v1/me/hand-picked').set(CLIENT), 401, 'UNAUTHENTICATED');
  assertProblem(await request(app).put('/v1/me/hand-picked').set(CLIENT).send({ contentIds: [] }), 401, 'UNAUTHENTICATED');
  const g = await guest();
  assertProblem(await getPicked(g), 403, 'GUEST_NOT_ALLOWED');
  assertProblem(await putPicked(g, { contentIds: [] }), 403, 'GUEST_NOT_ALLOWED');
  const me = await account();
  const s = await library(me);
  await User.deleteOne({ _id: me.user._id });
  assertProblem(await getPicked(me), 401, 'SESSION_REVOKED');
  assertProblem(await putPicked(me, { contentIds: [s.a] }), 401, 'SESSION_REVOKED');
  assertProblem(await putPicked(me, { contentIds: [] }), 401, 'SESSION_REVOKED');
});

test('one user\'s list never touches another\'s', async () => {
  const me = await account();
  const other = await account();
  const mine = await library(me);
  const theirs = await library(other);
  await putPicked(me, { contentIds: [mine.a, mine.b] });
  await putPicked(other, { contentIds: [theirs.d] });
  assertItems(await getPicked(me), [mine.a, mine.b]);
  assertItems(await getPicked(other), [theirs.d]);
  await putPicked(other, { contentIds: [] });
  assertItems(await getPicked(me), [mine.a, mine.b]);
});

test('stored values written elsewhere: other owners\' items are skipped, more than 3 read as the first 3', async () => {
  const me = await account();
  const other = await account();
  const s = await library(me);
  const theirs = await item(other, { title: 'Not yours' });
  const oid = (id) => new mongoose.Types.ObjectId(id);
  await User.collection.updateOne({ _id: me.user._id }, { $set: { handPicked: [oid(theirs), oid(s.b), oid(s.a)] } });
  assertItems(await getPicked(me), [s.b, s.a]);
  await User.collection.updateOne({ _id: me.user._id }, { $set: { handPicked: [s.d, s.c, s.b, s.a].map(oid) } });
  assertItems(await getPicked(me), [s.d, s.c, s.b]);
  await User.collection.updateOne({ _id: me.user._id }, { $set: { handPicked: 'not a list' } });
  assertItems(await getPicked(me), []);
});

test('the model refuses more than 3 hand-picked ids (a safety net behind the validator)', async () => {
  const me = await account();
  const s = await library(me);
  const four = [s.a, s.b, s.c, s.d];
  await assert.rejects(new User({ handPicked: four }).validate(['handPicked']), (err) => Boolean(err.errors?.handPicked));
  await new User({ handPicked: four.slice(0, 3) }).validate(['handPicked']);
  await new User({ handPicked: [] }).validate(['handPicked']);
  await assert.rejects(handPickedRepo.replace(String(me.user._id), four), (err) => err.name === 'ValidationError');
  assert.equal(Object.hasOwn(await storedDoc(me), 'handPicked'), false);
});

test('the spec: the operations, the catalog code, no rate limit and no Idempotency-Key', () => {
  const path = spec.paths['/me/hand-picked'];
  assert.equal(path.get.operationId, 'getMyHandPicked');
  assert.equal(path.put.operationId, 'replaceMyHandPicked');
  assert.ok(spec.components.schemas.ErrorCode.enum.includes('HAND_PICKED_INVALID'));
  assert.equal(spec.components.schemas.HandPickedReplace.properties.contentIds.maxItems, 3);
  assert.equal(spec.components.schemas.HandPicked.properties.items.maxItems, 3);
  for (const operation of [path.get, path.put]) {
    assert.equal(operation['x-rate-limit'], undefined, `${operation.operationId} now has an x-rate-limit: add the limiter`);
    const params = JSON.stringify(operation.parameters || []);
    assert.doesNotMatch(params, /IdempotencyKey|Idempotency-Key/, `${operation.operationId} now takes an Idempotency-Key`);
  }
});
