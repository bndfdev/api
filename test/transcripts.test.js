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
const { preferredLanguages, chooseTranscript } = require('../src/modules/player/service');
const Content = require('../models/Content');
const Transcript = require('../models/Transcript');
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

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';

async function account(extra = {}) {
  return signIn(await makeUser({ password: HASH, emailVerified: true, ...extra }));
}

async function guest() {
  const installationId = crypto.randomUUID();
  const headers = { ...CLIENT, 'X-Installation-Id': installationId };
  const res = await request(app).post('/v1/auth/guest').set(headers)
    .send({ device: { installationId, platform: 'ios', appVersion: '1.4.0' }, dateOfBirth: '2000-01-01' });
  assert.equal(res.status, 201, res.text);
  return { headers: { ...headers, Authorization: `Bearer ${res.body.tokens.accessToken}` } };
}

/** Original placeholder lines (not from any real song): one timed word by word, one timed as a whole line. */
const ORIGINAL = Object.freeze([
  { words: [{ text: 'We', startMs: 12400, endMs: 12620 }, { text: 'fly', startMs: 12620, endMs: 12980 }, { text: 'paper', startMs: 12980, endMs: 13410 }] },
  { text: 'Over the bay the gulls reply', startMs: 15200, endMs: 18900 },
]);
const SPANISH = Object.freeze([
  { text: 'Volamos cometas de papel', startMs: 12400, endMs: 14800 },
  { text: 'Sobre la bahía responden las gaviotas', startMs: 15200, endMs: 18900 },
]);
const FRENCH = Object.freeze([{ text: 'Nous volons des cerfs-volants', startMs: 12400, endMs: 14800 }]);

async function songWith(owner, transcripts, fields = {}) {
  const song = await Content.create({
    ownerId: owner.user._id, type: 'song', title: 'Kites', durationSec: 200,
    transcriptLanguages: transcripts.map((t) => t.language), ...fields,
  });
  for (const t of transcripts) {
    await Transcript.create({ songId: song._id, translatedFrom: null, updatedAt: new Date(), ...t });
  }
  return String(song._id);
}

/** A song with an English original and Spanish and French translations. */
const trilingual = (owner, fields) => songWith(owner, [
  { language: 'en', lines: ORIGINAL },
  { language: 'es', translatedFrom: 'en', lines: SPANISH },
  { language: 'fr', translatedFrom: 'en', lines: FRENCH },
], fields);

const transcriptOf = (who, songId, { language, acceptLanguage } = {}) => {
  const req = request(app).get(`/v1/songs/${songId}/transcript`).set(who.headers);
  if (language !== undefined) req.query({ language });
  if (acceptLanguage !== undefined) req.set('Accept-Language', acceptLanguage);
  return req;
};

function assertTranscript(res, language) {
  assert.equal(res.status, 200, res.text);
  assertMatchesSpec('Transcript', res.body);
  assert.equal(res.body.language, language);
  assert.equal(res.headers['cache-control'], 'private, no-cache');
  assert.match(res.headers.vary || '', /Accept-Language/i);
}

test('the original by default, in exactly the app\'s shape, with every language listed, the original first', async () => {
  const owner = await account();
  const id = await trilingual(owner);
  const g = await guest();
  const res = await transcriptOf(g, id);
  assertTranscript(res, 'en');
  assert.deepEqual(res.body, {
    language: 'en',
    translatedFrom: null,
    lines: ORIGINAL.map((line) => (line.words ? { words: line.words.map((w) => ({ ...w })) } : { ...line })),
    availableLanguages: ['en', 'es', 'fr'],
  });
  const song = await request(app).get(`/v1/songs/${id}`).set(g.headers);
  assert.deepEqual(song.body.transcriptLanguages, res.body.availableLanguages, 'the same list as Song.transcriptLanguages');
});

test('language picks a transcript; a language it has no transcript in is TRANSCRIPT_NOT_FOUND', async () => {
  const owner = await account();
  const id = await trilingual(owner);
  const es = await transcriptOf(owner, id, { language: 'es' });
  assertTranscript(es, 'es');
  assert.deepEqual([es.body.translatedFrom, es.body.lines, es.body.availableLanguages], ['en', SPANISH.map((l) => ({ ...l })), ['en', 'es', 'fr']]);
  assertTranscript(await transcriptOf(owner, id, { language: 'en' }), 'en');
  assertTranscript(await transcriptOf(owner, id, { language: 'fr' }), 'fr');
  for (const language of ['de', 'es-MX', 'pt']) {
    const missing = await transcriptOf(owner, id, { language });
    assertProblem(missing, 404, 'TRANSCRIPT_NOT_FOUND');
    assertMatchesSpec('Problem', missing.body);
  }
  // `language` wins over the header.
  assertTranscript(await transcriptOf(owner, id, { language: 'en', acceptLanguage: 'es' }), 'en');
});

test('without language, Accept-Language decides: by preference, on the main subtag; the original when nothing matches', async () => {
  const owner = await account();
  const id = await trilingual(owner);
  const cases = [
    ['es-MX, es;q=0.9, en;q=0.8', 'es'],
    ['de-DE, fr-CA;q=0.7, es;q=0.5', 'fr'],
    ['en;q=0.2, es;q=0.9', 'es'],
    ['es;q=0, fr;q=0.1', 'fr'],
    ['de, it', 'en'],
    ['*', 'en'],
    ['de, *;q=0.5, es;q=0.4', 'en'],
    ['', 'en'],
    ['ES', 'es'],
  ];
  for (const [header, expected] of cases) {
    const res = await transcriptOf(owner, id, { acceptLanguage: header });
    assertTranscript(res, expected);
  }
});

test('an exact regional tag is preferred to another region of the same language', async () => {
  const owner = await account();
  const id = await songWith(owner, [
    { language: 'pt-PT', lines: FRENCH },
    { language: 'pt-BR', translatedFrom: 'pt-PT', lines: SPANISH },
  ]);
  assertTranscript(await transcriptOf(owner, id, { acceptLanguage: 'pt-BR' }), 'pt-BR');
  assertTranscript(await transcriptOf(owner, id, { acceptLanguage: 'pt' }), 'pt-PT');
  assertTranscript(await transcriptOf(owner, id, { acceptLanguage: 'pt-AO' }), 'pt-PT');
  const res = await transcriptOf(owner, id, { language: 'pt-br' });
  assertTranscript(res, 'pt-BR');
  assert.deepEqual([res.body.translatedFrom, res.body.availableLanguages], ['pt-PT', ['pt-PT', 'pt-BR']]);
});

test('a translation whose original is missing: the first listed is sent when nothing matches', async () => {
  const owner = await account();
  const id = await songWith(owner, [
    { language: 'fr', translatedFrom: 'en', lines: FRENCH },
    { language: 'es', translatedFrom: 'en', lines: SPANISH },
  ]);
  const res = await transcriptOf(owner, id, { acceptLanguage: 'de' });
  assertTranscript(res, 'es');
  assert.deepEqual(res.body.availableLanguages, ['es', 'fr']);
});

test('no transcript at all is TRANSCRIPT_NOT_FOUND; an unknown song or another type is CONTENT_NOT_FOUND', async () => {
  const owner = await account();
  const none = await songWith(owner, []);
  assertProblem(await transcriptOf(owner, none), 404, 'TRANSCRIPT_NOT_FOUND');
  assertProblem(await transcriptOf(owner, none, { language: 'en' }), 404, 'TRANSCRIPT_NOT_FOUND');
  const albumDoc = await Content.create({ ownerId: owner.user._id, type: 'album', title: 'A' });
  for (const id of [String(new mongoose.Types.ObjectId()), String(albumDoc._id), 'nope']) {
    assertProblem(await transcriptOf(owner, id), 404, 'CONTENT_NOT_FOUND');
  }
});

test('followers-only: CONTENT_RESTRICTED for guests and other accounts, the transcript for the artist', async () => {
  const owner = await account();
  const id = await trilingual(owner, { followersOnly: true });
  const albumDoc = await Content.create({ ownerId: owner.user._id, type: 'album', title: 'Members', followersOnly: true });
  const onAlbum = await trilingual(owner, { albumId: albumDoc._id, trackNumber: 1 });
  for (const who of [await guest(), await account()]) {
    for (const songId of [id, onAlbum]) {
      const res = await transcriptOf(who, songId);
      assertProblem(res, 403, 'CONTENT_RESTRICTED');
      assertMatchesSpec('Problem', res.body);
    }
  }
  assertTranscript(await transcriptOf(owner, id), 'en');
  assertTranscript(await transcriptOf(owner, onAlbum), 'en');
});

test('language must be a language tag (validator); no token is 401', async () => {
  const owner = await account();
  const id = await trilingual(owner);
  for (const language of ['english', 'EN', 'e', 'en_US', 'en-']) {
    assertProblem(await transcriptOf(owner, id, { language }), 422, 'VALIDATION_FAILED');
  }
  assertProblem(await request(app).get(`/v1/songs/${id}/transcript`).set(CLIENT), 401, 'UNAUTHENTICATED');
});

test('rows written elsewhere: words and lines not in the player\'s shape are left out; none left is TRANSCRIPT_NOT_FOUND', async () => {
  const owner = await account();
  const id = await trilingual(owner);
  const songId = new mongoose.Types.ObjectId(id);
  await Transcript.collection.updateOne({ songId, language: 'en' }, {
    $set: {
      lines: [
        { words: [{ text: 'Kept', startMs: 10, endMs: 20, extra: 1 }, { text: '  ', startMs: 20, endMs: 30 }, { text: 'Late', startMs: 50, endMs: 40 }] },
        { words: [{ text: 'Gone', startMs: 1.5, endMs: 2 }] },
        { text: 'Line', startMs: 100, endMs: 200, colour: 'red' },
        { text: '', startMs: 300, endMs: 400 },
        'not a line',
        null,
      ],
    },
  });
  const res = await transcriptOf(owner, id);
  assertTranscript(res, 'en');
  assert.deepEqual(res.body.lines, [{ words: [{ text: 'Kept', startMs: 10, endMs: 20 }] }, { text: 'Line', startMs: 100, endMs: 200 }]);
  await Transcript.collection.updateOne({ songId, language: 'es' }, { $set: { lines: [{ text: ' ', startMs: 0, endMs: 1 }], translatedFrom: 'not a tag!' } });
  assertProblem(await transcriptOf(owner, id, { language: 'es' }), 404, 'TRANSCRIPT_NOT_FOUND');
  await Transcript.collection.updateOne({ songId, language: 'es' }, { $set: { lines: SPANISH } });
  const es = await transcriptOf(owner, id, { language: 'es' });
  assertTranscript(es, 'es');
  assert.equal(es.body.translatedFrom, null, 'a translatedFrom that is not a tag reads as null');
});

test('the model refuses lines in another shape and times that go back; one transcript per song and language', async () => {
  const songId = new mongoose.Types.ObjectId();
  const make = (lines, extra = {}) => new Transcript({ songId, language: 'en', lines, updatedAt: new Date(), ...extra }).validate();
  await make(ORIGINAL);
  await make(SPANISH);
  const bad = [
    [],
    [{ words: [{ text: 'a', startMs: 0, endMs: 1 }], text: 'both', startMs: 0, endMs: 1 }],
    [{ text: ' ', startMs: 0, endMs: 1 }],
    [{ text: 'end before start', startMs: 10, endMs: 5 }],
    [{ text: 'fraction', startMs: 0.5, endMs: 5 }],
    [{ text: 'no times' }],
    [{ text: 'b', startMs: 100, endMs: 200 }, { words: [{ text: 'back', startMs: 50, endMs: 60 }] }],
    [{ words: [{ text: 'x', startMs: 20, endMs: 30 }, { text: 'y', startMs: 10, endMs: 40 }] }],
  ];
  for (const lines of bad) await assert.rejects(make(lines), (err) => err.name === 'ValidationError', JSON.stringify(lines));
  await assert.rejects(make(ORIGINAL, { language: 'English' }), (err) => err.name === 'ValidationError');
  await assert.rejects(make(ORIGINAL, { translatedFrom: 'en_US' }), (err) => err.name === 'ValidationError');

  await Transcript.create({ songId, language: 'en', lines: ORIGINAL, updatedAt: new Date() });
  await assert.rejects(Transcript.create({ songId, language: 'en', lines: SPANISH, updatedAt: new Date() }), (err) => err.code === 11000);
  const keys = Object.fromEntries((await Transcript.collection.indexes()).map((ix) => [ix.name, ix]));
  assert.deepEqual([keys.song_language.key, keys.song_language.unique], [{ songId: 1, language: 1 }, true]);
});

test('Accept-Language parsing: q-values, order, q=0 and odd input', () => {
  assert.deepEqual(preferredLanguages('es-MX, es;q=0.9, en;q=0.8'), ['es-mx', 'es', 'en']);
  assert.deepEqual(preferredLanguages('en;q=0.2, fr, es;q=0.9'), ['fr', 'es', 'en']);
  assert.deepEqual(preferredLanguages('de;q=0, it'), ['it']);
  assert.deepEqual(preferredLanguages('a;q=0.5, b;q=0.5'), ['a', 'b'], 'ties keep their order');
  assert.deepEqual(preferredLanguages(' , ;q=1'), []);
  assert.deepEqual(preferredLanguages(undefined), []);
  const available = [{ language: 'en' }, { language: 'es' }];
  assert.equal(chooseTranscript([], undefined, 'en'), null);
  assert.equal(chooseTranscript(available, undefined, 'es-419').language, 'es');
  assert.equal(chooseTranscript(available, 'de', 'es'), null);
});
