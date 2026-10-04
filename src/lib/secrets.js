const crypto = require('node:crypto');
const { config } = require('../config');

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 32 random bytes as base64url: the raw form of an opaque token. */
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Hex SHA-256 of a string: how tokens and codes are stored. */
function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('TOKEN_ENC_KEY is not configured');
  }
}

/**
 * AES-256-GCM. Returns base64url(iv | tag | ciphertext). `aad` is authenticated
 * but not stored, so a ciphertext only decrypts in the context it was made for.
 * @param {string} plaintext
 * @param {{key?: Buffer, aad?: string}} [options]
 */
function encrypt(plaintext, { key = config.tokenEncKey, aad } = {}) {
  checkKey(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * Reverse of `encrypt`. Throws if the payload was tampered with, was made with
 * another key, or was made for another `aad`.
 * @param {string} payload
 * @param {{key?: Buffer, aad?: string}} [options]
 * @returns {string}
 */
function decrypt(payload, { key = config.tokenEncKey, aad } = {}) {
  checkKey(key);
  const data = Buffer.from(String(payload), 'base64url');
  if (data.length < IV_BYTES + TAG_BYTES) throw new Error('Invalid ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  try {
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Invalid ciphertext');
  }
}

module.exports = { randomToken, sha256, encrypt, decrypt };
