process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { randomToken, sha256, encrypt, decrypt } = require('../src/lib/secrets');

const key = crypto.randomBytes(32);

test('randomToken is 32 random bytes as base64url', () => {
  const a = randomToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomToken());
  assert.equal(Buffer.from(a, 'base64url').length, 32);
});

test('sha256 is the hex digest', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('encrypt and decrypt round trip, including non-ASCII text', () => {
  for (const text of ['hello', '', JSON.stringify({ accessToken: 'a.b.c', n: 1 }), 'हिन्दी 🔥']) {
    assert.equal(decrypt(encrypt(text, { key }), { key }), text);
  }
});

test('the default key comes from the config', () => {
  assert.equal(decrypt(encrypt('hello')), 'hello');
});

test('the same text encrypts differently every time and is not stored as plaintext', () => {
  const a = encrypt('secret value', { key });
  assert.notEqual(a, encrypt('secret value', { key }));
  assert.ok(!Buffer.from(a, 'base64url').toString('latin1').includes('secret value'));
});

test('a tampered ciphertext, tag or iv fails to decrypt', () => {
  const data = Buffer.from(encrypt('secret value', { key }), 'base64url');
  for (const index of [0, 11, 12, 27, 28, data.length - 1]) {
    const copy = Buffer.from(data);
    copy[index] ^= 0x01;
    assert.throws(() => decrypt(copy.toString('base64url'), { key }), /Invalid ciphertext/, `byte ${index}`);
  }
});

test('truncated or garbage input fails', () => {
  const payload = encrypt('secret value', { key });
  for (const bad of ['', 'abc', payload.slice(0, 20), `${payload}AA`]) {
    assert.throws(() => decrypt(bad, { key }), /Invalid ciphertext/);
  }
});

test('another key fails', () => {
  assert.throws(() => decrypt(encrypt('x', { key }), { key: crypto.randomBytes(32) }), /Invalid ciphertext/);
});

test('aad binds the ciphertext to its context', () => {
  const payload = encrypt('x', { key, aad: 'token-a' });
  assert.equal(decrypt(payload, { key, aad: 'token-a' }), 'x');
  assert.throws(() => decrypt(payload, { key, aad: 'token-b' }), /Invalid ciphertext/);
  assert.throws(() => decrypt(payload, { key }), /Invalid ciphertext/);
});

test('a missing or short key is refused', () => {
  assert.throws(() => encrypt('x', { key: Buffer.alloc(16) }), /TOKEN_ENC_KEY/);
  assert.throws(() => decrypt('abc', { key: Buffer.alloc(16) }), /TOKEN_ENC_KEY/);
});
