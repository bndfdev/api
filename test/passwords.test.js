process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { loadConfig } = require('../src/config');
const { ApiError } = require('../src/lib/problem');
const passwords = require('../src/lib/passwords');

const { PASSWORD_POLICY, unmetRules, policyViolation, createPasswords } = passwords;
const GOOD = 'Correct-Horse-9';

// ---------------------------------------------------------------------------
// The policy (docs/api: Password, PasswordPolicy)
// ---------------------------------------------------------------------------

test("the policy is the spec's: 12 to 128 characters, an uppercase letter, a digit and a symbol, no lowercase needed", () => {
  assert.deepEqual(PASSWORD_POLICY, {
    minLength: 12, maxLength: 128, requireUppercase: true, requireLowercase: false, requireDigit: true, requireSymbol: true,
  });
});

test('unmetRules names every rule that is broken, and nothing for a good password', () => {
  assert.deepEqual(unmetRules(GOOD), []);
  assert.deepEqual(unmetRules('short'), ['min_length', 'uppercase', 'digit', 'symbol']);
  assert.deepEqual(unmetRules('alllowercase1!'), ['uppercase']);
  assert.deepEqual(unmetRules('NoDigitsHere!!'), ['digit']);
  assert.deepEqual(unmetRules('NoSymbolHere12'), ['symbol']);
  assert.deepEqual(unmetRules('ALLUPPERCASE1!'), [], 'a lowercase letter is not required');
  assert.deepEqual(unmetRules(`${'A1!'.repeat(43)}A`), ['max_length'], '130 characters');
  assert.deepEqual(unmetRules(undefined), ['min_length', 'uppercase', 'digit', 'symbol']);
  assert.deepEqual(unmetRules(12345), ['min_length', 'uppercase', 'digit', 'symbol']);
});

test('the length limits are inclusive and count characters, not UTF-16 units', () => {
  assert.deepEqual(unmetRules(`Aa1!${'x'.repeat(8)}`), [], 'exactly 12');
  assert.deepEqual(unmetRules(`Aa1!${'x'.repeat(7)}`), ['min_length'], '11');
  assert.deepEqual(unmetRules(`Aa1!${'x'.repeat(124)}`), [], 'exactly 128');
  assert.deepEqual(unmetRules(`Aa1!${'x'.repeat(125)}`), ['max_length'], '129');
  // 12 characters, 20 UTF-16 units: each emoji counts once.
  assert.deepEqual(unmetRules(`Aa1!${'\u{1F600}'.repeat(8)}`), []);
});

test('uppercase, digit and symbol are Unicode categories (any language works)', () => {
  assert.deepEqual(unmetRules('Ärger-mit-Übung1'), []);
  assert.deepEqual(unmetRules('пароль-Длинный-١٢'), [], 'Cyrillic uppercase, Arabic-Indic digits, a hyphen');
  assert.deepEqual(unmetRules('Aa1€xxxxxxxx'), [], 'the euro sign is a symbol');
  assert.deepEqual(unmetRules('Aa1 xxxxxxxx'), ['symbol'], 'a space is not a symbol');
  for (const symbol of ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '-', '=', '[', ']', '{', '}', ';', ':', '"', '\\', '|', ',', '.', '<', '>', '/', '?', '`', '~', "'"]) {
    assert.deepEqual(unmetRules(`Aa1${symbol}xxxxxxxx`), [], `${symbol} is a symbol`);
  }
});

test('the rules are checked after NFKC normalisation (the same as the hash)', () => {
  // A superscript two is not a digit by itself, but NFKC turns it into "2".
  assert.deepEqual(unmetRules('Aa!xxxxxxxxx²'), []);
  assert.deepEqual(unmetRules('Aa!xxxxxxxxxx'), ['digit']);
});

test("policyViolation is the spec's problem: VALIDATION_FAILED with a PASSWORD_POLICY_VIOLATION field error", () => {
  const err = policyViolation(['uppercase', 'symbol']);
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 422);
  assert.equal(err.code, 'VALIDATION_FAILED');
  assert.equal(err.errors.length, 1);
  assert.equal(err.errors[0].field, '/password');
  assert.equal(err.errors[0].code, 'PASSWORD_POLICY_VIOLATION');
  assert.deepEqual(err.errors[0].meta, { unmetRules: ['uppercase', 'symbol'] });
  assert.equal(err.errors[0].message, 'Add an uppercase letter. Add a symbol.');
  assert.equal(policyViolation(['digit'], '/newPassword').errors[0].field, '/newPassword');
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

test('hash makes an argon2id hash with the OWASP parameters; verify accepts the password and nothing else', async () => {
  const hash = await passwords.hash(GOOD);
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(!hash.includes(GOOD));
  assert.equal(await passwords.verify(hash, GOOD), true);
  assert.equal(await passwords.verify(hash, `${GOOD}x`), false);
  assert.equal(await passwords.verify(hash, ''), false);
  assert.notEqual(await passwords.hash(GOOD), hash, 'a fresh salt every time');
  assert.equal(passwords.identify(hash), 'argon2id');
  assert.equal(passwords.needsRehash(hash), false);
});

test('passwords are NFKC-normalised: the same text in another form still matches', async () => {
  const composed = 'Café-Au-Lait-7'; // e with an acute accent as one character
  const decomposed = 'Café-Au-Lait-7'; // e + combining accent
  const hash = await passwords.hash(composed);
  assert.equal(await passwords.verify(hash, decomposed), true);
  const fullwidth = await passwords.hash('Ｐassword-Ｏne-1234'); // fullwidth P and O
  assert.equal(await passwords.verify(fullwidth, 'Password-One-1234'), true);
});

test('a password is never truncated: two long passwords that differ only at the end do not match', async () => {
  const long = `A1!${'x'.repeat(100)}`;
  const hash = await passwords.hash(`${long}a`);
  assert.equal(await passwords.verify(hash, `${long}b`), false);
  assert.equal(await passwords.verify(hash, `${long}a`), true);
});

test('hashing parameters come from config and are stored in the hash', async () => {
  const cfg = loadConfig({ NODE_ENV: 'test', ARGON2_MEMORY_KIB: '8192', ARGON2_TIME_COST: '3', ARGON2_PARALLELISM: '2' });
  assert.deepEqual(cfg.passwords, { memoryKib: 8192, timeCost: 3, parallelism: 2 });
  const custom = createPasswords({ config: cfg });
  const hash = await custom.hash(GOOD);
  assert.match(hash, /^\$argon2id\$v=19\$m=8192,t=3,p=2\$/);
  assert.equal(custom.needsRehash(hash), false);
  // Hashes made with other parameters still verify, and are flagged for an upgrade.
  assert.equal(await passwords.verify(hash, GOOD), true);
  assert.equal(passwords.needsRehash(hash), true);
  assert.equal(custom.needsRehash(await passwords.hash(GOOD)), true);
});

test('config: defaults are the OWASP minimum, bad values are refused by name', () => {
  assert.deepEqual(loadConfig({ NODE_ENV: 'test' }).passwords, { memoryKib: 19456, timeCost: 2, parallelism: 1 });
  for (const [name, value] of [['ARGON2_MEMORY_KIB', '0'], ['ARGON2_MEMORY_KIB', 'lots'], ['ARGON2_TIME_COST', '11'], ['ARGON2_PARALLELISM', '17']]) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', [name]: value }), (err) => err.message.includes(name) && !err.message.includes(`=${value}`));
  }
  assert.throws(() => loadConfig({ NODE_ENV: 'test', ARGON2_MEMORY_KIB: '15', ARGON2_PARALLELISM: '2' }), /ARGON2_MEMORY_KIB/);
});

// ---------------------------------------------------------------------------
// Old bcrypt hashes
// ---------------------------------------------------------------------------

test('a bcrypt hash from the old API verifies, and is flagged for an upgrade', async () => {
  const stored = await bcrypt.hash('OldPass123!', 10);
  assert.equal(passwords.identify(stored), 'bcrypt');
  assert.equal(await passwords.verify(stored, 'OldPass123!'), true);
  assert.equal(await passwords.verify(stored, 'oldpass123!'), false);
  assert.equal(passwords.needsRehash(stored), true);
});

test('a bcrypt hash is checked against the password as typed (it was made before normalisation existed)', async () => {
  const typed = 'Café-Old-1!'; // not NFKC-normal
  const stored = await bcrypt.hash(typed, 10);
  assert.equal(await passwords.verify(stored, typed), true);
});

test('verify never throws: garbage, missing and unknown hashes simply do not match', async () => {
  for (const stored of [undefined, null, '', 'plain-text-password', '$argon2id$broken', '$2a$10$tooshort', 42, {}]) {
    assert.equal(await passwords.verify(stored, GOOD), false, String(stored));
  }
  assert.equal(passwords.identify('plain'), null);
  assert.equal(passwords.identify('$2b$10$damaged'), null, 'a bcrypt hash that is too short is not recognised');
  assert.equal(passwords.identify(`$2b$10$${'a'.repeat(53)}`), 'bcrypt');
  assert.equal(passwords.needsRehash('plain'), false);
  assert.equal(passwords.needsRehash(undefined), false);
});

test('dummyHash: a failure to make it is not remembered, the next call tries again and then it is kept', async () => {
  let broken = true;
  const cfg = loadConfig({ NODE_ENV: 'test' });
  const flaky = createPasswords({ config: { get passwords() { if (broken) throw new Error('no memory'); return cfg.passwords; } } });
  await assert.rejects(flaky.dummyHash(), /no memory/);
  await assert.rejects(flaky.dummyHash(), /no memory/, 'still broken: tried again, not a stale answer');
  broken = false;
  const hash = await flaky.dummyHash();
  assert.match(hash, /^\$argon2id\$/);
  broken = true; // would fail if it were made again
  assert.equal(await flaky.dummyHash(), hash, 'made once, then kept');
});

test('dummyHash is a real argon2id hash made once, so an unknown email costs a real check', async () => {
  const first = await passwords.dummyHash();
  assert.match(first, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await passwords.dummyHash(), first);
  assert.equal(await passwords.verify(first, GOOD), false);
});
