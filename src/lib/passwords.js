/**
 * Passwords: the policy, hashing and checking. No database, no HTTP.
 *
 * - New passwords are hashed with argon2id (OWASP parameters by default:
 *   19 MiB of memory, 2 passes, 1 lane; see ARGON2_* in .env.example). The
 *   parameters are stored inside each hash, so changing them never breaks old hashes.
 * - Passwords are NFKC-normalised before hashing and checking (docs/api: `Password`),
 *   so the same text typed on another keyboard or platform still matches.
 * - Hashes made by the old API (bcrypt) still verify, so existing users can sign in.
 *   `needsRehash` tells the caller to store a fresh argon2id hash after a good login.
 * - `dummyHash` lets an unknown email, or an account with nothing to check a password against, cost the
 *   same as a wrong password.
 */
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { hash: argon2Hash, verify: argon2Verify, Algorithm } = require('@node-rs/argon2');
const { config: defaultConfig } = require('../config');
const { ApiError } = require('./problem');

/** `PasswordPolicy` in docs/api (components/schemas.yaml), the same as served by GET /config. */
const PASSWORD_POLICY = Object.freeze({
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: false,
  requireDigit: true,
  requireSymbol: true,
});

// Letters and digits are Unicode categories, so "Ä" is an uppercase letter and "٣" a digit. A symbol is
// punctuation or a symbol character (so every ASCII punctuation mark counts, and so does "€"); letters,
// marks, spaces and control characters do not.
const UPPERCASE = /\p{Lu}/u;
const DIGIT = /\p{Nd}/u;
const SYMBOL = /[\p{P}\p{S}]/u;

const ARGON2_PHC = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/;
// 60 characters: "$2b$", the cost, then 22 characters of salt and 31 of hash. A damaged one is not recognised.
const BCRYPT = /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const normalizePassword = (password) => String(password).normalize('NFKC');

/**
 * The rules a password breaks, by name: `min_length`, `max_length`, `uppercase`, `digit`, `symbol`
 * (`errors[].meta.unmetRules` in the spec). Empty when the password meets the policy.
 * @param {unknown} password
 * @returns {string[]}
 */
function unmetRules(password) {
  const text = typeof password === 'string' ? normalizePassword(password) : '';
  const length = [...text].length; // characters, not UTF-16 units
  const unmet = [];
  if (length < PASSWORD_POLICY.minLength) unmet.push('min_length');
  if (length > PASSWORD_POLICY.maxLength) unmet.push('max_length');
  if (PASSWORD_POLICY.requireUppercase && !UPPERCASE.test(text)) unmet.push('uppercase');
  if (PASSWORD_POLICY.requireDigit && !DIGIT.test(text)) unmet.push('digit');
  if (PASSWORD_POLICY.requireSymbol && !SYMBOL.test(text)) unmet.push('symbol');
  return unmet;
}

const RULE_MESSAGES = Object.freeze({
  min_length: `Use at least ${PASSWORD_POLICY.minLength} characters.`,
  max_length: `Use at most ${PASSWORD_POLICY.maxLength} characters.`,
  uppercase: 'Add an uppercase letter.',
  digit: 'Add a number.',
  symbol: 'Add a symbol.',
});

/** The `FieldError` for a password that breaks the policy (same shape as responses.yaml#/Unprocessable). */
function policyFieldError(field, unmet) {
  return {
    field,
    code: 'PASSWORD_POLICY_VIOLATION',
    message: unmet.map((rule) => RULE_MESSAGES[rule]).join(' '),
    meta: { unmetRules: unmet },
  };
}

/**
 * 422 VALIDATION_FAILED whose first field error is PASSWORD_POLICY_VIOLATION.
 * @param {string[]} unmet from `unmetRules`
 * @param {string} [field] JSON pointer of the password field
 */
function policyViolation(unmet, field = '/password') {
  return new ApiError({
    status: 422,
    code: 'VALIDATION_FAILED',
    title: 'Some details need fixing',
    errors: [policyFieldError(field, unmet)],
  });
}

/**
 * @param {{config?: {passwords: {memoryKib: number, timeCost: number, parallelism: number}}}} [deps]
 */
function createPasswords({ config = defaultConfig } = {}) {
  const params = () => ({
    memoryCost: config.passwords.memoryKib,
    timeCost: config.passwords.timeCost,
    parallelism: config.passwords.parallelism,
  });

  /** Which scheme made a stored hash: 'argon2id', 'bcrypt', or null when it is neither. */
  function identify(stored) {
    if (typeof stored !== 'string') return null;
    if (stored.startsWith('$argon2id$')) return 'argon2id';
    if (BCRYPT.test(stored)) return 'bcrypt';
    return null;
  }

  /** Hash a new password with argon2id. The caller has already checked the policy. */
  function hash(password) {
    return argon2Hash(normalizePassword(password), { algorithm: Algorithm.Argon2id, ...params() });
  }

  /**
   * Whether `password` matches a stored hash of either scheme. Never throws: an
   * unreadable or missing hash simply does not match (after the same work as a real
   * check, when the hash is damaged, so that is not faster either).
   * @param {unknown} stored
   * @param {string} password
   * @returns {Promise<boolean>}
   */
  async function verify(stored, password) {
    const scheme = identify(stored);
    try {
      if (scheme === 'argon2id') return await argon2Verify(stored, normalizePassword(password));
      // bcrypt hashes were made from the password exactly as typed, before normalisation existed.
      if (scheme === 'bcrypt') return await bcrypt.compare(String(password), stored);
    } catch {
      // A damaged hash: fall through to the dummy check below.
      await burn(password);
      return false;
    }
    // Neither scheme: a caller that wants the same timing as a real check passes `dummyHash()` itself and ignores the answer.
    return false;
  }

  /** The work of one real check, for a hash that cannot be checked. Never throws. */
  async function burn(password) {
    try {
      await argon2Verify(await dummyHash(), normalizePassword(password));
    } catch {
      // Nothing to do: only the time spent matters.
    }
  }

  /** True for a bcrypt hash, or an argon2id hash made with other parameters than the current ones. */
  function needsRehash(stored) {
    const scheme = identify(stored);
    if (scheme === 'bcrypt') return true;
    if (scheme !== 'argon2id') return false;
    const match = ARGON2_PHC.exec(stored);
    if (!match) return true;
    const current = params();
    return Number(match[1]) !== current.memoryCost || Number(match[2]) !== current.timeCost || Number(match[3]) !== current.parallelism;
  }

  // A hash of a random value nobody knows, made with the current parameters: checking a
  // password against it takes as long as a real check, so a login for an unknown email
  // takes as long as one with a wrong password. Made once (the server makes it at startup);
  // a failure to make it is not remembered, so the next call tries again.
  let dummy;
  /** @returns {Promise<string>} */
  function dummyHash() {
    if (!dummy) {
      const made = (async () => hash(`dummy-${crypto.randomBytes(16).toString('hex')}`))();
      dummy = made;
      made.catch(() => {
        if (dummy === made) dummy = undefined;
      });
    }
    return dummy;
  }

  return { hash, verify, needsRehash, identify, dummyHash };
}

module.exports = {
  PASSWORD_POLICY,
  unmetRules,
  policyFieldError,
  policyViolation,
  createPasswords,
  ...createPasswords(),
};
