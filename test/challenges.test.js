process.env.NODE_ENV = 'test';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const mongoose = require('mongoose');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const { SPEC_PATH } = require('../src/middleware/validate');
const { config, loadConfig } = require('../src/config');
const { ApiError } = require('../src/lib/problem');
const realRepo = require('../src/modules/challenges/repo');
const { createChallengeService, RULES } = require('../src/modules/challenges/service');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { createMemorySmsProvider } = require('../src/providers/sms/memory');
const Challenge = require('../models/Challenge');
const CodeSendLog = require('../models/CodeSendLog');
const db = require('./support/db');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A fake clock: tests move time by hand instead of sleeping.
const clock = { t: 0, now: () => clock.t, advance(ms) { clock.t += ms; } };
const email = createMemoryEmailProvider();
const sms = createMemorySmsProvider();
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const make = (overrides = {}) => createChallengeService({
  now: clock.now, emailProvider: email, smsProvider: sms, logger: silent, ...overrides,
});
const service = make();

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
// `format` is not checked (the unknown-format warning is silenced).
const ajv = new Ajv2020({ strict: false, logger: false });
const matchesSpec = (name, value) => ajv.validate({ $ref: `#/components/schemas/${name}`, components: spec.components }, value);
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

before(db.connect);
beforeEach(async () => {
  await db.clear();
  email.clear();
  sms.clear();
  clock.t = Date.now();
});
after(db.disconnect);

const newInstall = () => crypto.randomUUID();
const EMAIL = 'amelia.jane@example.com';

/** Start a sign-up challenge; returns the challenge, the install and a way to read the code that was "sent". */
async function startSignup({ destination = EMAIL, installationId = newInstall(), svc = service } = {}) {
  const challenge = await svc.start({ purpose: 'signup_email', channel: 'email', destination, installationId });
  const normalised = destination.trim().toLowerCase();
  return { challenge, installationId, id: challenge.id, code: () => email.lastCodeFor(normalised) };
}

const wrongCode = (code) => (code === '000000' ? '111111' : '000000');

async function assertRejects(promise, status, code, check) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (check) check(err);
    return true;
  });
}

const rawDocs = (collection) => mongoose.connection.collection(collection).find({}).toArray();

// ---------------------------------------------------------------------------
// start and verify: the happy path
// ---------------------------------------------------------------------------

test('start sends a code and returns a Challenge that matches the spec', async () => {
  const { challenge, code } = await startSignup();
  assert.equal(matchesSpec('Challenge', challenge), true, JSON.stringify(ajv.errors));
  assert.deepEqual(Object.keys(challenge).sort(), [
    'attemptsRemaining', 'channel', 'codeLength', 'destination', 'expiresAt', 'id', 'purpose', 'resendAvailableAt', 'sendsRemaining',
  ]);
  assert.equal(challenge.purpose, 'signup_email');
  assert.equal(challenge.channel, 'email');
  assert.equal(challenge.codeLength, 6);
  assert.equal(challenge.attemptsRemaining, 5);
  assert.equal(challenge.sendsRemaining, 4);
  assert.match(challenge.expiresAt, ISO_SECONDS);
  assert.match(challenge.resendAvailableAt, ISO_SECONDS);
  const now = Math.floor(clock.t / SECOND) * SECOND;
  assert.equal(Date.parse(challenge.expiresAt), now + 10 * MINUTE);
  assert.equal(Date.parse(challenge.resendAvailableAt), now + 30 * SECOND);
  assert.match(challenge.id, /^[0-9a-f]{24}$/);

  // Exactly one message, to the address, with the code, for this purpose.
  assert.equal(email.sent.length, 1);
  assert.equal(sms.sent.length, 0);
  assert.equal(email.sent[0].to, EMAIL);
  assert.equal(email.sent[0].purpose, 'signup_email');
  assert.equal(email.sent[0].expiresInMinutes, 10);
  assert.match(code(), /^\d{6}$/);
});

test('verify with the right code succeeds once and says what it unlocked', async () => {
  const { challenge, installationId, code } = await startSignup();
  clock.advance(5 * SECOND);
  const result = await service.verify({ challengeId: challenge.id, code: code(), installationId });
  assert.equal(result.purpose, 'signup_email');
  assert.equal(result.channel, 'email');
  assert.equal(result.destination, EMAIL, 'the unmasked address, for the next step');
  assert.equal(result.userId, null);
  assert.equal(result.installationId, installationId);
  assert.match(result.verifiedAt, ISO_SECONDS);
  assert.equal(matchesSpec('Challenge', result.challenge), true, JSON.stringify(ajv.errors));
  assert.equal(result.challenge.id, challenge.id);

  const [stored] = await rawDocs('challenges');
  assert.ok(stored.verifiedAt instanceof Date);
  // Single use: the same code again is refused, and so is everything else.
  await assertRejects(service.verify({ challengeId: challenge.id, code: code(), installationId }), 409, 'CHALLENGE_ALREADY_USED');
  await assertRejects(service.resend({ challengeId: challenge.id, installationId }), 409, 'CHALLENGE_ALREADY_USED');
  await assertRejects(service.get({ challengeId: challenge.id, installationId }), 404, 'CHALLENGE_NOT_FOUND');
});

test('every code is 6 digits and they are not all the same', async () => {
  const codes = new Set();
  for (let i = 0; i < 60; i += 1) {
    const { code } = await startSignup({ destination: `user${i}@example.com` });
    assert.match(code(), /^\d{6}$/);
    codes.add(code());
  }
  assert.ok(codes.size > 50, `only ${codes.size} different codes in 60`);
});

test('the code is stored only as a keyed hash, never in the database', async () => {
  const { challenge, code } = await startSignup();
  const sent = code();
  const [stored] = await rawDocs('challenges');
  const expectedHash = crypto.createHmac('sha256', config.codes.hmacKey).update(`code\n${challenge.id}:${sent}`).digest('hex');
  assert.equal(stored.codeHash, expectedHash);
  assert.notEqual(stored.codeHash, crypto.createHash('sha256').update(sent).digest('hex'), 'a plain hash could be reversed by trying 1,000,000 codes');
  assert.match(stored.codeHash, /^[0-9a-f]{64}$/);

  // No stored value anywhere is the code itself. (Ids and hashes are hex and may contain digits by chance, so compare whole values.)
  const everyValue = [];
  const walk = (value) => {
    if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)) Object.values(value).forEach(walk);
    else everyValue.push(String(value));
  };
  (await rawDocs('challenges')).forEach(walk);
  (await rawDocs('code_send_logs')).forEach(walk);
  assert.ok(everyValue.length > 10);
  assert.ok(!everyValue.includes(sent), 'the code was stored');
  // The send log keeps no address at all, only a keyed hash.
  const [log] = await rawDocs('code_send_logs');
  assert.ok(!JSON.stringify(log).includes('example.com'));
  assert.match(log.key, /^[0-9a-f]{64}$/);
});

test('the same code gives a different hash in another challenge', async () => {
  const a = await startSignup({ destination: 'one@example.com' });
  const b = await startSignup({ destination: 'two@example.com' });
  const docs = await rawDocs('challenges');
  assert.notEqual(docs[0].codeHash, docs[1].codeHash);
  assert.ok(a.id !== b.id);
});

// ---------------------------------------------------------------------------
// Wrong codes, attempts and the lock
// ---------------------------------------------------------------------------

test('a wrong code is CODE_INCORRECT with the attempts left, and the right code still works', async () => {
  const { id, installationId, code } = await startSignup();
  await assertRejects(
    service.verify({ challengeId: id, code: wrongCode(code()), installationId }), 422, 'CODE_INCORRECT',
    (err) => assert.deepEqual(err.meta, { attemptsRemaining: 4 }),
  );
  await assertRejects(
    service.verify({ challengeId: id, code: wrongCode(code()), installationId }), 422, 'CODE_INCORRECT',
    (err) => assert.deepEqual(err.meta, { attemptsRemaining: 3 }),
  );
  assert.equal((await service.get({ challengeId: id, installationId })).attemptsRemaining, 3);
  const ok = await service.verify({ challengeId: id, code: code(), installationId });
  assert.equal(ok.purpose, 'signup_email');
});

test('after 5 wrong codes the challenge locks, even for the right code', async () => {
  const { id, installationId, code } = await startSignup();
  for (const remaining of [4, 3, 2, 1]) {
    await assertRejects(
      service.verify({ challengeId: id, code: wrongCode(code()), installationId }), 422, 'CODE_INCORRECT',
      (err) => assert.equal(err.meta.attemptsRemaining, remaining),
    );
  }
  // The 5th wrong code is the one that locks it.
  await assertRejects(service.verify({ challengeId: id, code: wrongCode(code()), installationId }), 423, 'CHALLENGE_LOCKED',
    (err) => assert.ok(Number.isInteger(err.retryAfterSeconds) && err.retryAfterSeconds >= 1, 'a wait of 0 seconds would be no wait'));
  await assertRejects(service.verify({ challengeId: id, code: code(), installationId }), 423, 'CHALLENGE_LOCKED');
  const state = await service.get({ challengeId: id, installationId });
  assert.equal(state.attemptsRemaining, 0);
  const [stored] = await rawDocs('challenges');
  assert.equal(stored.attempts, 5, 'a locked challenge counts no more attempts');
  assert.equal(stored.verifiedAt, null);
});

test('a locked challenge is released by a resend: new code, attempts reset, old code dead', async () => {
  const { id, installationId, code } = await startSignup();
  const first = code();
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(service.verify({ challengeId: id, code: wrongCode(first), installationId }));
  }
  clock.advance(30 * SECOND);
  const resent = await service.resend({ challengeId: id, installationId });
  assert.equal(resent.attemptsRemaining, 5);
  const second = code();
  assert.notEqual(second, first);
  await assertRejects(service.verify({ challengeId: id, code: first, installationId }), 422, 'CODE_INCORRECT');
  assert.equal((await service.verify({ challengeId: id, code: second, installationId })).purpose, 'signup_email');
});

test('a code that is not 6 digits is refused without using up an attempt; spaces around it are ignored', async () => {
  const { id, installationId, code } = await startSignup();
  for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', '١٢٣٤٥٦', undefined, null, 123456]) {
    await assertRejects(
      service.verify({ challengeId: id, code: bad, installationId }), 422, 'CODE_FORMAT_INVALID',
      (err) => assert.equal(err.errors[0].field, '/code'),
    );
  }
  assert.equal((await service.get({ challengeId: id, installationId })).attemptsRemaining, 5);
  const ok = await service.verify({ challengeId: id, code: `  ${code()}\n`, installationId });
  assert.equal(ok.purpose, 'signup_email');
});

test('a code with leading zeros keeps them', async () => {
  // Draw until the random code starts with a zero (1 in 10).
  for (let i = 0; i < 200; i += 1) {
    const { id, installationId, code } = await startSignup({ destination: `zero${i}@example.com` });
    if (code().startsWith('0')) {
      assert.equal(code().length, 6);
      assert.equal((await service.verify({ challengeId: id, code: code(), installationId })).purpose, 'signup_email');
      return;
    }
  }
  assert.fail('no code with a leading zero in 200 tries');
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test('a code works until 10 minutes after it was sent, then the challenge is expired', async () => {
  const { id, installationId, code } = await startSignup();
  clock.advance(10 * MINUTE - SECOND);
  assert.equal((await service.get({ challengeId: id, installationId })).id, id);
  clock.advance(SECOND);
  await assertRejects(service.verify({ challengeId: id, code: code(), installationId }), 410, 'CHALLENGE_EXPIRED');
  await assertRejects(service.get({ challengeId: id, installationId }), 410, 'CHALLENGE_EXPIRED');
  await assertRejects(service.resend({ challengeId: id, installationId }), 410, 'CHALLENGE_EXPIRED');
});

test('an expired challenge does not count the wrong guesses made against it', async () => {
  const { id, installationId, code } = await startSignup();
  clock.advance(11 * MINUTE);
  await assertRejects(service.verify({ challengeId: id, code: wrongCode(code()), installationId }), 410, 'CHALLENGE_EXPIRED');
  const [stored] = await rawDocs('challenges');
  assert.equal(stored.attempts, 0);
});

test('starting again after expiry sends a fresh code in a new challenge', async () => {
  const first = await startSignup();
  clock.advance(10 * MINUTE);
  const second = await startSignup({ installationId: first.installationId });
  assert.notEqual(second.id, first.id);
  assert.equal(email.sent.length, 2);
  assert.equal(second.challenge.sendsRemaining, 3);
});

test('challenges and send-log rows clean themselves up (TTL indexes)', () => {
  const ttl = (model) => model.schema.indexes().filter(([, options]) => options && options.expireAfterSeconds !== undefined);
  assert.deepEqual(ttl(Challenge).map(([fields, options]) => [fields, options.expireAfterSeconds]), [[{ purgeAt: 1 }, 0]]);
  assert.deepEqual(ttl(CodeSendLog).map(([fields, options]) => [fields, options.expireAfterSeconds]), [[{ sentAt: 1 }, DAY / SECOND]]);
  // No index that nothing uses, and no field that nothing sets.
  assert.deepEqual(Challenge.schema.indexes().map(([fields]) => Object.keys(fields)), [['activeKey'], ['purgeAt']]);
  assert.equal(Challenge.schema.path('consumedAt'), undefined);
});

test('a challenge outlives its code by an hour, so a late request hears "expired", not "not found"', async () => {
  await startSignup();
  const [stored] = await rawDocs('challenges');
  assert.equal(stored.purgeAt.getTime() - stored.expiresAt.getTime(), HOUR);
});

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

test('resend waits 30 seconds, and says how long is left', async () => {
  const { id, installationId } = await startSignup();
  await assertRejects(service.resend({ challengeId: id, installationId }), 429, 'RESEND_TOO_SOON',
    (err) => assert.equal(err.retryAfterSeconds, 30));
  clock.advance(29 * SECOND);
  await assertRejects(service.resend({ challengeId: id, installationId }), 429, 'RESEND_TOO_SOON',
    (err) => assert.equal(err.retryAfterSeconds, 1));
  assert.equal(email.sent.length, 1, 'nothing was sent');
  clock.advance(SECOND);
  const resent = await service.resend({ challengeId: id, installationId });
  assert.equal(email.sent.length, 2);
  assert.equal(matchesSpec('Challenge', resent), true, JSON.stringify(ajv.errors));
  assert.equal(resent.id, id, 'the same challenge');
  assert.equal(resent.sendsRemaining, 3);
  const now = Math.floor(clock.t / SECOND) * SECOND;
  assert.equal(Date.parse(resent.resendAvailableAt), now + 30 * SECOND);
  assert.equal(Date.parse(resent.expiresAt), now + 10 * MINUTE, 'the expiry moves');
});

test('a resend replaces the code: the old one stops working and the attempts start again', async () => {
  const { id, installationId, code } = await startSignup();
  const first = code();
  await assertRejects(service.verify({ challengeId: id, code: wrongCode(first), installationId }), 422, 'CODE_INCORRECT');
  clock.advance(30 * SECOND);
  const resent = await service.resend({ challengeId: id, installationId });
  assert.equal(resent.attemptsRemaining, 5);
  const second = code();
  assert.notEqual(second, first);
  await assertRejects(service.verify({ challengeId: id, code: first, installationId }), 422, 'CODE_INCORRECT',
    (err) => assert.equal(err.meta.attemptsRemaining, 4));
  assert.equal((await service.verify({ challengeId: id, code: second, installationId })).purpose, 'signup_email');
});

test('two resends at once: one wins, the other is told to wait, one message is sent', async () => {
  const { id, installationId } = await startSignup();
  clock.advance(30 * SECOND);
  const results = await Promise.allSettled([
    service.resend({ challengeId: id, installationId }),
    service.resend({ challengeId: id, installationId }),
    service.resend({ challengeId: id, installationId }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) {
    assert.equal(r.reason.code, 'RESEND_TOO_SOON');
  }
  assert.equal(email.sent.length, 2);
});

// ---------------------------------------------------------------------------
// Send limit (5 per address per rolling 24 hours)
// ---------------------------------------------------------------------------

test('at most 5 codes go to one address in 24 hours, counted over a rolling window', async () => {
  const sendsRemaining = [];
  for (let i = 0; i < 5; i += 1) {
    const { challenge } = await startSignup(); // a new install each time, so each one is a new send
    sendsRemaining.push(challenge.sendsRemaining);
    clock.advance(HOUR);
  }
  assert.deepEqual(sendsRemaining, [4, 3, 2, 1, 0]);
  assert.equal(email.sent.length, 5);

  // The first send was 5 hours ago, so it leaves the window in 19 hours.
  await assertRejects(startSignup(), 429, 'SEND_LIMIT_REACHED', (err) => assert.equal(err.retryAfterSeconds, 19 * 3600));
  assert.equal(email.sent.length, 5);
  assert.equal(await Challenge.countDocuments(), 5, 'the refused challenge was not kept');
  assert.equal(await CodeSendLog.countDocuments(), 5);

  clock.advance(19 * HOUR - SECOND);
  await assertRejects(startSignup(), 429, 'SEND_LIMIT_REACHED', (err) => assert.equal(err.retryAfterSeconds, 1));
  clock.advance(SECOND);
  const { challenge } = await startSignup();
  assert.equal(challenge.sendsRemaining, 0, 'the window is full again: 4 old sends plus this one');
  assert.equal(email.sent.length, 6);
});

test('resends count toward the same limit, across purposes for one address', async () => {
  const { id, installationId } = await startSignup();
  for (let i = 0; i < 3; i += 1) {
    clock.advance(30 * SECOND);
    await service.resend({ challengeId: id, installationId });
  }
  // 4 sends so far. A password reset to the same address is the 5th.
  const reset = await service.start({ purpose: 'password_reset', channel: 'email', destination: EMAIL, installationId: newInstall() });
  assert.equal(reset.sendsRemaining, 0);
  clock.advance(30 * SECOND);
  await assertRejects(service.resend({ challengeId: id, installationId }), 429, 'SEND_LIMIT_REACHED');
  // The refused resend left the old code working.
  assert.equal(email.sent.length, 5);
  const [stored] = await rawDocs('challenges').then((docs) => docs.filter((d) => String(d._id) === id));
  assert.equal(stored.sendCount, 4);
  const sentCode = email.sent.filter((m) => m.purpose === 'signup_email').at(-1).code;
  assert.equal((await service.verify({ challengeId: id, code: sentCode, installationId })).purpose, 'signup_email');
});

test('different addresses have their own limits, and a refused send leaves no trace', async () => {
  for (let i = 0; i < 5; i += 1) await startSignup();
  await assertRejects(startSignup(), 429, 'SEND_LIMIT_REACHED');
  const other = await startSignup({ destination: 'someone.else@example.com' });
  assert.equal(other.challenge.sendsRemaining, 4);
});

// ---------------------------------------------------------------------------
// Delivery failures
// ---------------------------------------------------------------------------

test('if the email cannot be sent, start fails with EMAIL_DELIVERY_FAILED and nothing counts', async () => {
  email.failNext(new Error('smtp down'));
  await assertRejects(startSignup(), 503, 'EMAIL_DELIVERY_FAILED', (err) => assert.ok(err.retryAfterSeconds > 0));
  assert.equal(await Challenge.countDocuments(), 0);
  assert.equal(await CodeSendLog.countDocuments(), 0);
  const { challenge } = await startSignup();
  assert.equal(challenge.sendsRemaining, 4, 'the failed send was not counted');
});

test('the problem for a failed send does not carry the provider error', async () => {
  email.failNext(new Error('550 mailbox amelia.jane@example.com unavailable'));
  await assert.rejects(startSignup(), (err) => {
    assert.ok(!JSON.stringify({ ...err, message: err.message }).includes('mailbox'));
    return true;
  });
});

test('a failed resend keeps the old code and its attempts, counts no send, and keeps the cooldown', async () => {
  const { id, installationId, code } = await startSignup();
  const first = code();
  await assertRejects(service.verify({ challengeId: id, code: wrongCode(first), installationId }), 422, 'CODE_INCORRECT');
  const before = (await rawDocs('challenges'))[0];
  clock.advance(30 * SECOND);
  email.failNext(new Error('smtp down'));
  await assertRejects(service.resend({ challengeId: id, installationId }), 503, 'EMAIL_DELIVERY_FAILED',
    (err) => assert.equal(err.retryAfterSeconds, 30));
  const after = (await rawDocs('challenges'))[0];
  // Nothing about the code changed: not the hash, not the attempts (they are NOT given back), not the expiry.
  for (const field of ['codeHash', 'attempts', 'sendCount', 'expiresAt', 'purgeAt']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.equal(after.attempts, 1);
  // The cooldown was used up, not rewound: the client waits before asking again.
  assert.equal(after.lastSentAt.getTime(), Math.floor(clock.t / SECOND) * SECOND);
  assert.equal(await CodeSendLog.countDocuments(), 1);
  await assertRejects(service.resend({ challengeId: id, installationId }), 429, 'RESEND_TOO_SOON',
    (err) => assert.equal(err.retryAfterSeconds, 30));
  assert.equal((await service.get({ challengeId: id, installationId })).sendsRemaining, 4);
  // The old code still works; after the wait a resend goes through.
  clock.advance(30 * SECOND);
  await service.resend({ challengeId: id, installationId });
  assert.equal(email.sent.length, 2);
});

test('an SMS that cannot be sent is SMS_DELIVERY_FAILED', async () => {
  sms.failNext();
  await assertRejects(
    service.start({ purpose: 'phone_verification', channel: 'sms', destination: '+14155550123', installationId: newInstall(), userId: String(new mongoose.Types.ObjectId()) }),
    503, 'SMS_DELIVERY_FAILED',
  );
});

// ---------------------------------------------------------------------------
// Starting twice
// ---------------------------------------------------------------------------

test('starting again from the same install returns the same challenge and sends nothing', async () => {
  const first = await startSignup();
  const again = await service.start({ purpose: 'signup_email', channel: 'email', destination: ' Amelia.Jane@Example.COM ', installationId: first.installationId });
  assert.deepEqual(again, first.challenge);
  assert.equal(email.sent.length, 1);
  assert.equal(await Challenge.countDocuments(), 1);
});

test('starting is per install and per purpose', async () => {
  const first = await startSignup();
  const otherInstall = await startSignup();
  assert.notEqual(otherInstall.id, first.id);
  const reset = await service.start({ purpose: 'password_reset', channel: 'email', destination: EMAIL, installationId: first.installationId });
  assert.notEqual(reset.id, first.id);
  assert.equal(email.sent.length, 3);
});

test('a locked or used challenge is not handed out again', async () => {
  const first = await startSignup();
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(service.verify({ challengeId: first.id, code: wrongCode(first.code()), installationId: first.installationId }));
  }
  const second = await startSignup({ installationId: first.installationId });
  assert.notEqual(second.id, first.id, 'a locked challenge cannot be reused');
  await service.verify({ challengeId: second.id, code: second.code(), installationId: first.installationId });
  const third = await startSignup({ installationId: first.installationId });
  assert.notEqual(third.id, second.id, 'a used challenge cannot be reused');
});

test('many starts at once (a double tap) give one challenge and one message', async () => {
  const installationId = newInstall();
  const results = await Promise.all(Array.from({ length: 6 }, () => service.start({
    purpose: 'signup_email', channel: 'email', destination: EMAIL, installationId,
  })));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(await Challenge.countDocuments(), 1);
  assert.equal(email.sent.length, 1);
  assert.equal(await CodeSendLog.countDocuments(), 1);
});

test('the address is normalised: case and spaces do not matter, and the message goes to the normalised address', async () => {
  const { id, installationId } = await startSignup({ destination: '  Amelia.Jane@EXAMPLE.com ' });
  assert.equal(email.sent[0].to, 'amelia.jane@example.com');
  const result = await service.verify({ challengeId: id, code: email.sent[0].code, installationId });
  assert.equal(result.destination, 'amelia.jane@example.com');
  const [stored] = await rawDocs('challenges');
  assert.equal(stored.destination, 'amelia.jane@example.com');
});

test('start rejects input that is not a purpose, a channel, a destination and an install', async () => {
  const ok = { purpose: 'signup_email', channel: 'email', destination: EMAIL, installationId: newInstall() };
  for (const bad of [
    { purpose: 'login' }, { purpose: 'toString' }, { purpose: undefined }, { channel: 'push' }, { channel: undefined },
    { destination: undefined }, { destination: 5 }, { installationId: '' }, { installationId: undefined },
    { deliver: 'no' }, { deliver: 0 },
  ]) {
    await assert.rejects(service.start({ ...ok, ...bad }), TypeError, JSON.stringify(bad));
  }
  assert.equal(email.sent.length, 0);
  assert.equal(await Challenge.countDocuments(), 0);
});

test('an address that is not one plain email is refused with EMAIL_INVALID before anything is created', async () => {
  const ok = { purpose: 'signup_email', channel: 'email', installationId: newInstall() };
  for (const destination of [
    'a@b.com:x@y.z', 'a@b.com(evil@x.com)', 'a@b.com,x@y.z', 'a@b.com;x@y.z', 'a b@c.co', 'a@b.co/x', 'a@b.co:25',
    '', '   ', 'nobody', 'a@b', 'a%b@c.co', 'a!b@c.co', `${'a'.repeat(250)}@example.com`, 'a@b.co\r\nBcc: x@y.z',
  ]) {
    await assertRejects(service.start({ ...ok, destination }), 422, 'EMAIL_INVALID',
      (err) => assert.deepEqual(err.errors.map((e) => [e.field, e.code]), [['/email', 'EMAIL_INVALID']]));
    // The same goes for a password reset.
    await assertRejects(service.start({ ...ok, purpose: 'password_reset', destination }), 422, 'EMAIL_INVALID');
  }
  assert.equal(email.sent.length, 0);
  assert.equal(await Challenge.countDocuments(), 0);
  assert.equal(await CodeSendLog.countDocuments(), 0);
});

test('spelling variants of one address share one send limit', async () => {
  const variants = ['amelia@example.com', 'AMELIA@example.com', ' Amelia@Example.COM ', 'amelia@EXAMPLE.com\t', 'aMeLiA@example.com'];
  for (const destination of variants) await startSignup({ destination }); // five installs, five sends
  assert.equal(email.sent.length, 5);
  assert.ok(email.sent.every((m) => m.to === 'amelia@example.com'));
  await assertRejects(startSignup({ destination: 'AMELIA@EXAMPLE.COM' }), 429, 'SEND_LIMIT_REACHED');
  assert.equal(email.sent.length, 5);
});

test('phone numbers lose spaces, dashes and parentheses, so variants share a challenge; a bad number is PHONE_INVALID', async () => {
  const userId = String(new mongoose.Types.ObjectId());
  const installationId = newInstall();
  const base = { purpose: 'phone_verification', channel: 'sms', installationId, userId };
  const first = await service.start({ ...base, destination: '+1 (415) 555-0123' });
  const again = await service.start({ ...base, destination: ' +1-415-555 0123 ' });
  assert.equal(again.id, first.id);
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].to, '+14155550123');
  for (const destination of ['4155550123', '+1', 'call me', '+1 415 555 0123;x', '']) {
    await assertRejects(service.start({ ...base, destination }), 422, 'PHONE_INVALID',
      (err) => assert.equal(err.errors[0].field, '/phoneNumber'));
  }
  assert.equal(sms.sent.length, 1);
});

test('which purposes belong to a user: phone_verification must have one, the others must not', async () => {
  const userId = String(new mongoose.Types.ObjectId());
  const installationId = newInstall();
  const phone = { purpose: 'phone_verification', channel: 'sms', destination: '+14155550123', installationId };
  for (const bad of [{}, { userId: null }, { userId: '' }, { userId: 'not-an-id' }, { userId: undefined }]) {
    await assert.rejects(service.start({ ...phone, ...bad }), /needs the userId/, JSON.stringify(bad));
  }
  for (const purpose of ['signup_email', 'password_reset']) {
    await assert.rejects(
      service.start({ purpose, channel: 'email', destination: EMAIL, installationId, userId }),
      /does not belong to a user/, purpose,
    );
  }
  // Each purpose is sent over its own channel.
  await assert.rejects(service.start({ ...phone, userId, channel: 'email', destination: EMAIL }), /sent by sms/);
  await assert.rejects(service.start({ purpose: 'signup_email', channel: 'sms', destination: '+14155550123', installationId }), /sent by email/);
  assert.equal(await Challenge.countDocuments(), 0);
  assert.equal(sms.sent.length + email.sent.length, 0);
  // And the right combination works.
  assert.equal((await service.start({ ...phone, userId })).channel, 'sms');
});

// ---------------------------------------------------------------------------
// Who may use a challenge
// ---------------------------------------------------------------------------

test('another install gets "not found" for get, resend and verify, and cannot use up attempts', async () => {
  const { id, installationId, code } = await startSignup();
  const other = newInstall();
  await assertRejects(service.get({ challengeId: id, installationId: other }), 404, 'CHALLENGE_NOT_FOUND');
  await assertRejects(service.resend({ challengeId: id, installationId: other }), 404, 'CHALLENGE_NOT_FOUND');
  await assertRejects(service.verify({ challengeId: id, code: code(), installationId: other }), 404, 'CHALLENGE_NOT_FOUND');
  await assertRejects(service.verify({ challengeId: id, code: code(), installationId: undefined }), 404, 'CHALLENGE_NOT_FOUND');
  assert.equal((await rawDocs('challenges'))[0].verifiedAt, null, 'the stolen code was not accepted');
  assert.equal((await service.get({ challengeId: id, installationId })).id, id);
});

test('unknown and malformed ids are "not found"', async () => {
  const installationId = newInstall();
  for (const challengeId of [String(new mongoose.Types.ObjectId()), 'nope', '', undefined, '{"$ne":null}', { $ne: null }, 'chl_01J8Z4A7']) {
    await assertRejects(service.get({ challengeId, installationId }), 404, 'CHALLENGE_NOT_FOUND');
    await assertRejects(service.verify({ challengeId, code: '123456', installationId }), 404, 'CHALLENGE_NOT_FOUND');
    await assertRejects(service.resend({ challengeId, installationId }), 404, 'CHALLENGE_NOT_FOUND');
  }
});

test('a phone challenge belongs to its user: anyone else gets "not found"', async () => {
  const userId = String(new mongoose.Types.ObjectId());
  const installationId = newInstall();
  const challenge = await service.start({ purpose: 'phone_verification', channel: 'sms', destination: '+14155550123', installationId, userId });
  assert.equal(matchesSpec('Challenge', challenge), true, JSON.stringify(ajv.errors));
  assert.equal(challenge.channel, 'sms');
  assert.equal(challenge.destination, '+••• ••• 0123');
  assert.equal(sms.sent.length, 1);
  assert.equal(email.sent.length, 0);
  const code = sms.sent[0].code;

  const intruder = String(new mongoose.Types.ObjectId());
  await assertRejects(service.get({ challengeId: challenge.id, installationId }), 404, 'CHALLENGE_NOT_FOUND');
  await assertRejects(service.get({ challengeId: challenge.id, installationId, userId: intruder }), 404, 'CHALLENGE_NOT_FOUND');
  await assertRejects(service.verify({ challengeId: challenge.id, code, installationId, userId: intruder }), 404, 'CHALLENGE_NOT_FOUND');
  assert.equal((await service.get({ challengeId: challenge.id, installationId, userId })).id, challenge.id);
  // Starting again as the same user reuses it; as another user it does not.
  const again = await service.start({ purpose: 'phone_verification', channel: 'sms', destination: '+14155550123', installationId, userId });
  assert.equal(again.id, challenge.id);
  const result = await service.verify({ challengeId: challenge.id, code, installationId, userId });
  assert.equal(result.userId, userId);
  assert.equal(result.purpose, 'phone_verification');
  assert.equal(result.destination, '+14155550123');
});

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

test('the right code sent in parallel works exactly once', async () => {
  const { id, installationId, code } = await startSignup();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => service.verify({ challengeId: id, code: code(), installationId })),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason && r.reason.code)));
  assert.equal(refused.length, 7);
  // Each refusal is "already used", or, when it was counted after the first five had taken every attempt
  // and before the winner marked the challenge used, "locked". Both refuse; neither gives another guess.
  for (const r of refused) {
    assert.ok(r.reason instanceof ApiError);
    assert.ok(['CHALLENGE_ALREADY_USED', 'CHALLENGE_LOCKED'].includes(r.reason.code), r.reason.code);
  }
  assert.ok(refused.some((r) => r.reason.code === 'CHALLENGE_ALREADY_USED'));
  assert.equal((await rawDocs('challenges'))[0].attempts <= 5, true, 'never more than 5 counted');
});

test('wrong codes sent in parallel never get more than 5 guesses', async () => {
  const { id, installationId, code } = await startSignup();
  const bad = wrongCode(code());
  const results = await Promise.allSettled(
    Array.from({ length: 25 }, () => service.verify({ challengeId: id, code: bad, installationId })),
  );
  const codes = results.map((r) => (r.status === 'rejected' ? r.reason.code : 'OK'));
  assert.equal(codes.filter((c) => c === 'OK').length, 0);
  const incorrect = codes.filter((c) => c === 'CODE_INCORRECT').length;
  const lockedCount = codes.filter((c) => c === 'CHALLENGE_LOCKED').length;
  assert.equal(incorrect, 4, 'four wrong answers, then the lock');
  assert.equal(incorrect + lockedCount, 25);
  assert.equal((await rawDocs('challenges'))[0].attempts, 5);
});

test('a right code mixed into parallel wrong ones still works if it is among the first 5 compared', async () => {
  const { id, installationId, code } = await startSignup();
  const bad = wrongCode(code());
  // Four wrong guesses and the right one, all together: five attempts are allowed.
  const results = await Promise.allSettled([bad, bad, bad, bad, code()].map((c) => service.verify({ challengeId: id, code: c, installationId })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

// ---------------------------------------------------------------------------
// Test mode (staging)
// ---------------------------------------------------------------------------

const testModeConfig = (extra = {}) => loadConfig({
  NODE_ENV: 'test',
  CODE_TEST_MODE: 'true',
  CODE_TEST_RECIPIENTS: 'Tester@Example.com, +919999900000',
  CODE_TEST_VALUE: '135790',
  ...extra,
});

test('test mode: a listed address gets the fixed code and nothing is sent, but the send still counts', async () => {
  const svc = make({ config: testModeConfig() });
  const { id, installationId } = await startSignup({ destination: 'tester@example.com', svc });
  assert.equal(email.sent.length, 0, 'nothing was sent');
  assert.equal(await CodeSendLog.countDocuments(), 1, 'but it counts toward the limit');
  const challenge = await svc.get({ challengeId: id, installationId });
  assert.equal(challenge.sendsRemaining, RULES.sendLimit - 1);
  // The fixed code is stored as a hash like any other.
  const [stored] = await rawDocs('challenges');
  assert.equal(stored.codeHash, crypto.createHmac('sha256', config.codes.hmacKey).update(`code\n${id}:135790`).digest('hex'));
  await assertRejects(svc.verify({ challengeId: id, code: '111111', installationId }), 422, 'CODE_INCORRECT');
  assert.equal((await svc.verify({ challengeId: id, code: '135790', installationId })).destination, 'tester@example.com');
});

test('test mode: the listed address is matched after normalising, and a resend uses the fixed code too', async () => {
  const svc = make({ config: testModeConfig() });
  const { id, installationId } = await startSignup({ destination: '  TESTER@example.COM ', svc });
  clock.advance(30 * SECOND);
  await svc.resend({ challengeId: id, installationId });
  assert.equal(email.sent.length, 0);
  assert.equal((await svc.verify({ challengeId: id, code: '135790', installationId })).purpose, 'signup_email');
});

test('test mode: a listed phone number gets the fixed code and no text message', async () => {
  const svc = make({ config: testModeConfig() });
  const userId = String(new mongoose.Types.ObjectId());
  const installationId = newInstall();
  const challenge = await svc.start({ purpose: 'phone_verification', channel: 'sms', destination: '+919999900000', installationId, userId });
  assert.equal(sms.sent.length, 0);
  assert.equal((await svc.verify({ challengeId: challenge.id, code: '135790', installationId, userId })).purpose, 'phone_verification');
});

test('test mode: everyone else is unaffected (random code, really sent, limited)', async () => {
  const svc = make({ config: testModeConfig() });
  const { challenge, code } = await startSignup({ destination: 'someone.else@example.com', svc });
  assert.equal(email.sent.length, 1);
  assert.equal(challenge.sendsRemaining, 4);
  assert.match(code(), /^\d{6}$/);
  assert.equal(await CodeSendLog.countDocuments(), 1);
  // The fixed code opens nothing for them (unless the random code happens to be the same).
  const { id, installationId } = await startSignup({ destination: 'another.person@example.com', svc });
  if (email.lastCodeFor('another.person@example.com') !== '135790') {
    await assertRejects(svc.verify({ challengeId: id, code: '135790', installationId }), 422, 'CODE_INCORRECT');
  }
});

test('test mode off: a listed address is treated like any other', async () => {
  const svc = make({ config: loadConfig({ NODE_ENV: 'test' }) });
  await startSignup({ destination: 'tester@example.com', svc });
  assert.equal(email.sent.length, 1);
});

test('an unvalidated production config never has test mode on (the validated one refuses it: see config.test.js)', () => {
  const unvalidated = loadConfig(
    { NODE_ENV: 'production', CODE_TEST_MODE: 'true', CODE_TEST_RECIPIENTS: 'tester@example.com', CODE_TEST_VALUE: '135790' },
    { validate: false },
  );
  assert.equal(unvalidated.codes.testMode, false);
});

test('test mode: the fixed code is limited like any other (5 sends a day, 5 guesses per code)', async () => {
  const svc = make({ config: testModeConfig() });
  for (let i = 0; i < 5; i += 1) await startSignup({ destination: 'tester@example.com', svc });
  await assertRejects(startSignup({ destination: 'tester@example.com', svc }), 429, 'SEND_LIMIT_REACHED');
  assert.equal(email.sent.length, 0);
  assert.equal(await Challenge.countDocuments(), 5);

  // Guesses: a listed phone number is just as capped, so the fixed code cannot be brute-forced.
  const userId = String(new mongoose.Types.ObjectId());
  const installationId = newInstall();
  const challenge = await svc.start({ purpose: 'phone_verification', channel: 'sms', destination: '+919999900000', installationId, userId });
  for (const remaining of [4, 3, 2, 1]) {
    await assertRejects(svc.verify({ challengeId: challenge.id, code: '000000', installationId, userId }), 422, 'CODE_INCORRECT',
      (err) => assert.equal(err.meta.attemptsRemaining, remaining));
  }
  await assertRejects(svc.verify({ challengeId: challenge.id, code: '000000', installationId, userId }), 423, 'CHALLENGE_LOCKED');
  await assertRejects(svc.verify({ challengeId: challenge.id, code: '135790', installationId, userId }), 423, 'CHALLENGE_LOCKED');
  assert.equal(sms.sent.length, 0);
});

// ---------------------------------------------------------------------------
// A resend cannot be used to get more guesses
// ---------------------------------------------------------------------------

/** The real repo with a hook that runs right after one of its steps. */
function hookedRepo({ afterReserve, afterClaim }) {
  return {
    ...realRepo,
    async reserveSend(args) {
      const result = await realRepo.reserveSend(args);
      if (afterReserve) await afterReserve(result);
      return result;
    },
    async claimResend(args) {
      const result = await realRepo.claimResend(args);
      if (afterClaim) await afterClaim(result);
      return result;
    },
  };
}

/** An email provider that runs a hook while the message is "on its way", then sends normally (or throws what the hook throws). */
function hookedEmail(onSend) {
  return {
    name: 'hooked',
    async send(message) {
      await onSend(message);
      return email.send(message);
    },
  };
}

const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const challengeDoc = async (id) => (await rawDocs('challenges')).find((doc) => String(doc._id) === id);

test('a resend refused by the send limit changes nothing, so guesses made while it runs get no fresh attempts', async () => {
  const { id, installationId, code } = await startSignup();
  const first = code();
  for (let i = 0; i < 4; i += 1) {
    await assertRejects(service.verify({ challengeId: id, code: wrongCode(first), installationId }), 422, 'CODE_INCORRECT');
  }
  for (let i = 0; i < 4; i += 1) await startSignup(); // five sends in 24 hours: the limit is full
  clock.advance(30 * SECOND); // the cooldown is over, so only the limit stands in the way
  const before = await challengeDoc(id);
  assert.equal(before.attempts, 4);

  const results = [];
  const svc = make({
    repo: hookedRepo({
      // The resend has just been told the limit is full. Guess against the challenge right now.
      async afterReserve(reservation) {
        assert.equal(reservation.ok, false);
        results.push(await settle(service.verify({ challengeId: id, code: wrongCode(first), installationId })));
        results.push(await settle(service.verify({ challengeId: id, code: first, installationId })));
        results.push(await settle(service.verify({ challengeId: id, code: wrongCode(first), installationId })));
      },
    }),
  });
  await assertRejects(svc.resend({ challengeId: id, installationId }), 429, 'SEND_LIMIT_REACHED');

  // The 5th attempt locked it, and nothing, not even the right code, got in afterwards.
  assert.deepEqual(results.map((r) => r.error && r.error.code), ['CHALLENGE_LOCKED', 'CHALLENGE_LOCKED', 'CHALLENGE_LOCKED']);
  const after = await challengeDoc(id);
  assert.equal(after.attempts, 5, 'five guesses in all, the cap');
  for (const field of ['codeHash', 'sendCount', 'lastSentAt', 'expiresAt', 'verifiedAt']) assert.deepEqual(after[field], before[field], field);
  await assertRejects(service.verify({ challengeId: id, code: first, installationId }), 423, 'CHALLENGE_LOCKED');
  assert.equal(await CodeSendLog.countDocuments(), 5, 'the refused send left no row');
});

test('a resend that fails to send never exposes the new code and gives no attempts back, however the guesses interleave', async () => {
  const { id, installationId, code } = await startSignup();
  const first = code();
  for (let i = 0; i < 2; i += 1) {
    await assertRejects(service.verify({ challengeId: id, code: wrongCode(first), installationId }), 422, 'CODE_INCORRECT');
  }
  clock.advance(30 * SECOND);
  const before = await challengeDoc(id);

  const inFlight = [];
  const svc = make({
    emailProvider: hookedEmail(async (message) => {
      // The new code exists but has not been delivered. Try it, and then use up the remaining guesses.
      const probe = message.code === first ? wrongCode(first) : message.code;
      inFlight.push(await settle(service.verify({ challengeId: id, code: probe, installationId })));
      inFlight.push(await settle(service.verify({ challengeId: id, code: wrongCode(first), installationId })));
      inFlight.push(await settle(service.verify({ challengeId: id, code: wrongCode(first), installationId })));
      throw new Error('smtp down');
    }),
  });
  await assertRejects(svc.resend({ challengeId: id, installationId }), 503, 'EMAIL_DELIVERY_FAILED');

  // The undelivered code was refused like any wrong code; the attempts counted once each, from where they were.
  assert.deepEqual(inFlight.map((r) => r.error.code), ['CODE_INCORRECT', 'CODE_INCORRECT', 'CHALLENGE_LOCKED']);
  assert.deepEqual(inFlight.slice(0, 2).map((r) => r.error.meta.attemptsRemaining), [2, 1]);
  const after = await challengeDoc(id);
  assert.equal(after.attempts, 5, 'a failed send does not give the attempts back');
  assert.equal(after.codeHash, before.codeHash, 'the old code is still the code');
  assert.equal(after.sendCount, before.sendCount);
  assert.deepEqual(after.expiresAt, before.expiresAt);
  // Locked: not even the old, right code gets through.
  await assertRejects(service.verify({ challengeId: id, code: first, installationId }), 423, 'CHALLENGE_LOCKED');
  assert.equal(await CodeSendLog.countDocuments(), 1, 'the failed send was released');
  // Retrying at once is a cooldown matter; after the wait a real resend is the way out of the lock.
  await assertRejects(service.resend({ challengeId: id, installationId }), 429, 'RESEND_TOO_SOON');
  clock.advance(30 * SECOND);
  assert.equal((await service.resend({ challengeId: id, installationId })).attemptsRemaining, 5);
});

test('a code cannot be tried before it is delivered, and works as soon as the resend has finished', async () => {
  const { id, installationId, code } = await startSignup();
  const first = code();
  clock.advance(30 * SECOND);
  const inFlight = [];
  const svc = make({
    emailProvider: hookedEmail(async (message) => {
      const probe = message.code === first ? wrongCode(first) : message.code;
      inFlight.push(await settle(service.verify({ challengeId: id, code: probe, installationId })));
    }),
  });
  const resent = await svc.resend({ challengeId: id, installationId });
  assert.equal(inFlight[0].error.code, 'CODE_INCORRECT');
  assert.equal(resent.attemptsRemaining, 5, 'the attempts start again once the new code is out');
  const second = email.sent.at(-1).code;
  assert.notEqual(second, first);
  assert.equal((await service.verify({ challengeId: id, code: second, installationId })).purpose, 'signup_email');
});

test('the old code keeps working while a resend is on its way; if it is used, the resend ends as "already used"', async () => {
  const { id, installationId, code } = await startSignup();
  const first = code();
  clock.advance(30 * SECOND);
  let outcome;
  const svc = make({
    emailProvider: hookedEmail(async () => {
      outcome = await settle(service.verify({ challengeId: id, code: first, installationId }));
    }),
  });
  await assertRejects(svc.resend({ challengeId: id, installationId }), 409, 'CHALLENGE_ALREADY_USED');
  assert.equal(outcome.value.purpose, 'signup_email', 'the old code was accepted while the message was in flight');
  const doc = await challengeDoc(id);
  assert.ok(doc.verifiedAt instanceof Date);
  assert.equal(doc.sendCount, 1, 'the new code never became the code');
});

test('a resend loses cleanly to another one: its send is released, one message goes out, and the code changes once', async () => {
  const { id, installationId } = await startSignup();
  clock.advance(30 * SECOND);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => service.resend({ challengeId: id, installationId })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(email.sent.length, 2);
  assert.equal(await CodeSendLog.countDocuments(), 2, 'the losers released their reservations');
  assert.equal((await challengeDoc(id)).sendCount, 2);
});

test('a resend whose claim is lost after the send was counted releases the count', async () => {
  const { id, installationId } = await startSignup();
  clock.advance(30 * SECOND);
  // Another resend takes the claim between this one counting its send and claiming.
  const racing = {
    ...realRepo,
    async reserveSend(args) {
      const result = await realRepo.reserveSend(args);
      await realRepo.claimResend({ id, at: args.at, cooldownMs: 30 * SECOND });
      return result;
    },
  };
  const loser = make({ repo: racing });
  await assertRejects(loser.resend({ challengeId: id, installationId }), 429, 'RESEND_TOO_SOON');
  assert.equal(await CodeSendLog.countDocuments(), 1, 'only the first send is counted');
  assert.equal(email.sent.length, 1);
});

test('the send limit is never exceeded by sends that arrive together', async () => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => startSignup()));
  const admitted = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(admitted <= RULES.sendLimit, `${admitted} sends admitted`);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'SEND_LIMIT_REACHED');
  assert.equal(email.sent.length, admitted);
  assert.equal(await CodeSendLog.countDocuments(), admitted);
  assert.equal(await Challenge.countDocuments(), admitted);
});

test('a wait is never 0 seconds: a locked challenge whose cooldown is long over says 1', async () => {
  const { id, installationId, code } = await startSignup();
  for (let i = 0; i < 5; i += 1) await assert.rejects(service.verify({ challengeId: id, code: wrongCode(code()), installationId }));
  clock.advance(10 * MINUTE - SECOND);
  await assertRejects(service.verify({ challengeId: id, code: code(), installationId }), 423, 'CHALLENGE_LOCKED',
    (err) => assert.equal(err.retryAfterSeconds, 1));
});

// ---------------------------------------------------------------------------
// Decoys (start with deliver: false) for password reset
// ---------------------------------------------------------------------------

/** A service whose real sends take a controlled time and whose decoy waits are recorded. */
function decoyHarness() {
  const sleeps = [];
  const timer = { t: 0, sendTakes: 120 };
  const svc = make({
    sleep: async (ms) => { sleeps.push(ms); },
    monotonic: () => timer.t,
    emailProvider: hookedEmail(async () => { timer.t += timer.sendTakes; }),
  });
  return { svc, sleeps, timer };
}

const resetStart = (svc, destination, extra = {}) => svc.start({
  purpose: 'password_reset', channel: 'email', destination, installationId: newInstall(), ...extra,
});

test('a decoy sends nothing but looks like a real reset: same shape, limits and database work', async () => {
  const { svc, sleeps } = decoyHarness();
  const real = await resetStart(svc, 'known@example.com');
  assert.equal(email.sent.length, 1);
  assert.deepEqual(sleeps, [], 'a real send does not wait');

  const decoy = await resetStart(svc, 'ghost@example.com', { deliver: false });
  assert.equal(email.sent.length, 1, 'nothing was sent for the decoy');
  assert.deepEqual(sleeps, [120], 'it waited as long as a real send took');
  assert.equal(matchesSpec('Challenge', decoy), true, JSON.stringify(ajv.errors));
  // Everything a client can see is of the same kind and has the same values (apart from the id and the masked address).
  assert.deepEqual({ ...decoy, id: 'x', destination: 'x' }, { ...real, id: 'x', destination: 'x' });
  assert.equal(decoy.destination, 'g•••••t@example.com');
  assert.equal(decoy.sendsRemaining, 4);

  // The same rows, written the same way: a challenge and one counted send.
  const docs = await rawDocs('challenges');
  const [realDoc, decoyDoc] = [docs.find((d) => d.destination === 'known@example.com'), docs.find((d) => d.destination === 'ghost@example.com')];
  assert.deepEqual(Object.keys(decoyDoc).sort(), Object.keys(realDoc).sort());
  assert.equal(decoyDoc.decoy, true);
  assert.equal(realDoc.decoy, false);
  assert.equal(await CodeSendLog.countDocuments(), 2);
});

test('a decoy cannot be told from a real reset by what verify says, and no code ever opens it', async () => {
  const { svc } = decoyHarness();
  const installationId = newInstall();
  const decoy = await resetStart(svc, 'ghost@example.com', { installationId, deliver: false });
  const realInstall = newInstall();
  const real = await resetStart(svc, 'known@example.com', { installationId: realInstall });
  const realCode = email.lastCodeFor('known@example.com');
  const wrong = wrongCode(realCode);

  for (const [challengeId, install] of [[decoy.id, installationId], [real.id, realInstall]]) {
    for (const remaining of [4, 3, 2, 1]) {
      await assertRejects(svc.verify({ challengeId, code: wrong, installationId: install }), 422, 'CODE_INCORRECT',
        (err) => assert.deepEqual(err.meta, { attemptsRemaining: remaining }));
    }
    await assertRejects(svc.verify({ challengeId, code: wrong, installationId: install }), 423, 'CHALLENGE_LOCKED');
  }

  // The decoy's hash is made from random bytes nobody keeps, not from a code, so no code can match it
  // (the guarantee is how it is made; a sample of 60,000 codes is tried here as a check).
  const key = config.codes.hmacKey;
  const stored = (await rawDocs('challenges')).find((d) => d.destination === 'ghost@example.com');
  assert.match(stored.codeHash, /^[0-9a-f]{64}$/);
  let matches = 0;
  for (let n = 0; n < 60000; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (crypto.createHmac('sha256', key).update(`code\n${decoy.id}:${candidate}`).digest('hex') === stored.codeHash) matches += 1;
  }
  assert.equal(matches, 0);
  // Two decoys for the same address differ.
  const other = await resetStart(svc, 'ghost@example.com', { deliver: false });
  assert.notEqual(other.id, decoy.id);
  const hashes = (await rawDocs('challenges')).filter((d) => d.destination === 'ghost@example.com').map((d) => d.codeHash);
  assert.equal(new Set(hashes).size, hashes.length);
});

test('a decoy is limited exactly like a real reset: 5 sends a day, then SEND_LIMIT_REACHED with the same wait', async () => {
  const { svc } = decoyHarness();
  const asks = [['known@example.com', {}], ['ghost@example.com', { deliver: false }]];
  for (let i = 0; i < 5; i += 1) {
    for (const [destination, extra] of asks) {
      assert.equal((await resetStart(svc, destination, extra)).sendsRemaining, 4 - i);
    }
    clock.advance(MINUTE);
  }
  const refusals = [];
  for (const [destination, extra] of asks) {
    refusals.push(await settle(resetStart(svc, destination, extra)));
  }
  assert.ok(refusals.every((r) => r.error instanceof ApiError && r.error.code === 'SEND_LIMIT_REACHED' && r.error.status === 429));
  assert.equal(refusals[0].error.retryAfterSeconds, refusals[1].error.retryAfterSeconds);
  assert.equal(email.sent.length, 5, 'only the real address was written to');
});

test('a decoy can be resent like a real challenge (cooldown, limit, new expiry) and still sends nothing', async () => {
  const { svc, sleeps } = decoyHarness();
  const installationId = newInstall();
  const decoy = await resetStart(svc, 'ghost@example.com', { installationId, deliver: false });
  await assertRejects(svc.resend({ challengeId: decoy.id, installationId }), 429, 'RESEND_TOO_SOON',
    (err) => assert.equal(err.retryAfterSeconds, 30));
  clock.advance(30 * SECOND);
  const resent = await svc.resend({ challengeId: decoy.id, installationId });
  assert.equal(matchesSpec('Challenge', resent), true, JSON.stringify(ajv.errors));
  assert.equal(resent.id, decoy.id);
  assert.equal(resent.sendsRemaining, 3);
  assert.equal(email.sent.length, 0);
  assert.equal(sleeps.length, 2, 'the resend waited like a send too');
  assert.equal((await challengeDoc(decoy.id)).decoy, true);
  assert.equal((await svc.get({ challengeId: decoy.id, installationId })).sendsRemaining, 3);
});

test('a decoy waits about as long as real sends have recently taken (moving average), and 300 ms before any is seen', async () => {
  const { svc, sleeps, timer } = decoyHarness();
  await resetStart(svc, 'ghost1@example.com', { deliver: false });
  assert.deepEqual(sleeps, [300]);
  timer.sendTakes = 120;
  await resetStart(svc, 'known1@example.com');
  await resetStart(svc, 'ghost2@example.com', { deliver: false });
  assert.equal(sleeps.at(-1), 120);
  timer.sendTakes = 220;
  await resetStart(svc, 'known2@example.com');
  await resetStart(svc, 'ghost3@example.com', { deliver: false });
  assert.ok(Math.abs(sleeps.at(-1) - (0.7 * 120 + 0.3 * 220)) < 1e-9, String(sleeps.at(-1)));
  // A failed real send is not counted as a sample, and a very slow one is capped.
  timer.sendTakes = 999999;
  await resetStart(svc, 'known3@example.com');
  await resetStart(svc, 'ghost4@example.com', { deliver: false });
  assert.ok(sleeps.at(-1) <= 0.7 * 150 + 0.3 * 5000 + 1e-9);
});

test('a decoy is only for password reset, and asking twice returns the same decoy', async () => {
  const { svc, sleeps } = decoyHarness();
  await assert.rejects(svc.start({ purpose: 'signup_email', channel: 'email', destination: EMAIL, installationId: newInstall(), deliver: false }), /Only password_reset/);
  await assert.rejects(
    svc.start({ purpose: 'phone_verification', channel: 'sms', destination: '+14155550123', installationId: newInstall(), userId: String(new mongoose.Types.ObjectId()), deliver: false }),
    /Only password_reset/,
  );
  const installationId = newInstall();
  const first = await resetStart(svc, 'ghost@example.com', { installationId, deliver: false });
  const again = await resetStart(svc, 'ghost@example.com', { installationId, deliver: false });
  assert.equal(again.id, first.id);
  assert.equal(sleeps.length, 1);
  assert.equal(await CodeSendLog.countDocuments(), 1);
  // An invalid address is refused for a decoy too: it must not tell a real invalid address from a missing account.
  await assertRejects(resetStart(svc, 'not an email', { deliver: false }), 422, 'EMAIL_INVALID');
});

// ---------------------------------------------------------------------------
// Masking in the shape
// ---------------------------------------------------------------------------

test('the Challenge shape never contains the address or the code', async () => {
  const { challenge, code } = await startSignup();
  assert.equal(challenge.destination, 'a•••••e@example.com');
  const text = JSON.stringify(challenge);
  assert.ok(!text.includes('amelia'));
  assert.ok(!text.includes(code()));
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('the service refuses to hash codes without a configured key', async () => {
  const svc = make({ config: { ...config, codes: { ...config.codes, hmacKey: undefined } } });
  await assert.rejects(startSignup({ svc }), /CODE_HMAC_KEY/);
  assert.equal(email.sent.length, 0);
});

test('the numbers are the ones in the spec', () => {
  assert.deepEqual({ ...RULES }, {
    codeLength: 6, ttlSeconds: 600, maxAttempts: 5, resendCooldownSeconds: 30, sendLimit: 5, sendWindowSeconds: 86400,
  });
  // AppConfig.otp in the spec carries the same values as examples.
  const otp = spec.components.schemas.AppConfig.properties.otp.properties;
  assert.equal(otp.length.const, RULES.codeLength);
  assert.deepEqual(otp.ttlSeconds.examples, [RULES.ttlSeconds]);
  assert.deepEqual(otp.resendCooldownSeconds.examples, [RULES.resendCooldownSeconds]);
  assert.deepEqual(otp.maxAttempts.examples, [RULES.maxAttempts]);
  assert.equal(spec.components.schemas.Challenge.properties.codeLength.const, RULES.codeLength);
});
