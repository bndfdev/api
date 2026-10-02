const crypto = require('node:crypto');
require('dotenv').config();

const REQUIRED = ['MONGODB_URI'];
// Needed to sign access tokens and to protect the refresh grace data. Required
// in every environment except local development and tests.
const REQUIRED_TOKEN_VARS = ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KEY_ID', 'TOKEN_ENC_KEY'];
const KEYLESS_ENVS = Object.freeze(['development', 'test']);

const TOKEN_DEFAULTS = Object.freeze({
  accessTtlSeconds: 900,
  refreshTtlDays: 60,
  refreshGraceSeconds: 30,
  issuer: 'bondfire-api',
  audience: 'bondfire-app',
});
const TOKEN_LIMITS = Object.freeze({
  accessTtlSeconds: 3600,
  refreshTtlDays: 180,
  refreshGraceSeconds: 120,
});

// Origins allowed when CORS_ORIGINS is unset outside production (local tools,
// the admin panel and the old dev host). In production unset means none.
const DEV_CORS_ORIGINS = Object.freeze([
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:3001',
  'http://localhost:4000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  'http://3.10.42.32:3000',
  'https://3.10.42.32:3000',
  'http://3.10.42.32',
  'https://3.10.42.32',
]);

/** Parse a comma-separated origin list: trimmed, empty entries and a trailing slash dropped. */
function parseOrigins(value) {
  return String(value)
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// Ephemeral development keys are generated once per process, so every
// loadConfig() call in the same process agrees on them.
let ephemeralSigningKeys;
let ephemeralEncKey;

function getEphemeralSigningKeys() {
  if (!ephemeralSigningKeys) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    ephemeralSigningKeys = { privateKey, publicKey, keyId: `ephemeral-${crypto.randomBytes(4).toString('hex')}` };
  }
  return ephemeralSigningKeys;
}

function getEphemeralEncKey() {
  if (!ephemeralEncKey) ephemeralEncKey = crypto.randomBytes(32);
  return ephemeralEncKey;
}

/** PEM values in env files often carry literal "\n" sequences. */
function normalizePem(value) {
  return value ? String(value).replace(/\\n/g, '\n').trim() : undefined;
}

/** Integer from 1 to `max` from env, or the default when unset or (when not validating) out of range. */
function readBoundedInt(env, name, fallback, max, invalid) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= max) return Number(raw);
  invalid.push(`${name} (must be an integer from 1 to ${max})`);
  return fallback;
}

/** Name of the problem with the signing keys, or null when they are a usable ES256 pair. */
function signingKeyProblem(privatePem, publicPem) {
  const ecP256 = (key) => key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1';
  let privateKey;
  let publicKey;
  try {
    privateKey = crypto.createPrivateKey(privatePem);
  } catch {
    return 'JWT_PRIVATE_KEY (not a valid PEM private key)';
  }
  try {
    publicKey = crypto.createPublicKey(publicPem);
  } catch {
    return 'JWT_PUBLIC_KEY (not a valid PEM public key)';
  }
  if (!ecP256(privateKey)) return 'JWT_PRIVATE_KEY (must be an ES256 / P-256 key)';
  if (!ecP256(publicKey)) return 'JWT_PUBLIC_KEY (must be an ES256 / P-256 key)';
  const exportSpki = (key) => key.export({ type: 'spki', format: 'der' });
  if (!exportSpki(crypto.createPublicKey(privateKey)).equals(exportSpki(publicKey))) {
    return 'JWT_PUBLIC_KEY (does not match JWT_PRIVATE_KEY)';
  }
  return null;
}

/**
 * Build the runtime config from an env map.
 * With `validate` (default) throws an Error naming any missing or invalid vars
 * (names only, never values). MONGODB_URI is not required when NODE_ENV=test.
 * The JWT and token-encryption vars are required unless NODE_ENV is
 * development (also when unset) or test; there, missing keys are generated for
 * this process (`jwt.ephemeral`, `tokenEncKeyEphemeral`).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{validate?: boolean}} [options]
 */
function loadConfig(env = process.env, { validate = true } = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isTest = nodeEnv === 'test';
  const isProduction = nodeEnv === 'production';
  const mayGenerateKeys = KEYLESS_ENVS.includes(nodeEnv);

  const privatePem = normalizePem(env.JWT_PRIVATE_KEY);
  const publicPem = normalizePem(env.JWT_PUBLIC_KEY);

  if (validate) {
    const missing = isTest ? [] : REQUIRED.filter((name) => !env[name]);
    if (!mayGenerateKeys) {
      missing.push(...REQUIRED_TOKEN_VARS.filter((name) => !env[name]));
    } else if (Boolean(privatePem) !== Boolean(publicPem)) {
      missing.push(privatePem ? 'JWT_PUBLIC_KEY' : 'JWT_PRIVATE_KEY');
    }
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  const portValid = env.PORT === undefined || env.PORT === '' ||
    (/^\d+$/.test(env.PORT) && Number(env.PORT) <= 65535);
  if (validate && !portValid) {
    throw new Error('Invalid environment variable: PORT (must be an integer 0-65535)');
  }
  const port = portValid && env.PORT ? Number(env.PORT) : 3000;

  let corsOrigins;
  if (env.CORS_ORIGINS !== undefined && env.CORS_ORIGINS.trim() !== '') {
    corsOrigins = parseOrigins(env.CORS_ORIGINS);
  } else {
    corsOrigins = isProduction ? [] : [...DEV_CORS_ORIGINS];
  }

  const invalid = [];
  const accessTtlSeconds = readBoundedInt(
    env, 'ACCESS_TOKEN_TTL_SECONDS', TOKEN_DEFAULTS.accessTtlSeconds, TOKEN_LIMITS.accessTtlSeconds, invalid);
  const refreshTtlDays = readBoundedInt(
    env, 'REFRESH_TOKEN_TTL_DAYS', TOKEN_DEFAULTS.refreshTtlDays, TOKEN_LIMITS.refreshTtlDays, invalid);
  const refreshGraceSeconds = readBoundedInt(
    env, 'REFRESH_GRACE_SECONDS', TOKEN_DEFAULTS.refreshGraceSeconds, TOKEN_LIMITS.refreshGraceSeconds, invalid);

  let signing = { privateKey: privatePem, publicKey: publicPem, keyId: env.JWT_KEY_ID || (privatePem ? 'dev' : undefined) };
  let ephemeral = false;
  if (mayGenerateKeys && !privatePem && !publicPem) {
    signing = getEphemeralSigningKeys();
    ephemeral = true;
  }

  let tokenEncKey;
  let tokenEncKeyEphemeral = false;
  if (env.TOKEN_ENC_KEY) {
    tokenEncKey = Buffer.from(env.TOKEN_ENC_KEY, 'base64');
    if (tokenEncKey.length !== 32) {
      invalid.push('TOKEN_ENC_KEY (must be 32 bytes, base64-encoded)');
      tokenEncKey = undefined;
    }
  } else if (mayGenerateKeys) {
    tokenEncKey = getEphemeralEncKey();
    tokenEncKeyEphemeral = true;
  }

  if (validate) {
    if (signing.privateKey && signing.publicKey && !ephemeral) {
      const problem = signingKeyProblem(signing.privateKey, signing.publicKey);
      if (problem) invalid.push(problem);
    }
    if (invalid.length > 0) {
      throw new Error(`Invalid environment variable${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`);
    }
  }

  return Object.freeze({
    env: nodeEnv,
    isProduction,
    isTest,
    port,
    mongodbUri: env.MONGODB_URI,
    logLevel: env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
    apiBaseUrl: env.API_BASE_URL || undefined,
    corsOrigins: Object.freeze(corsOrigins),
    jwt: Object.freeze({
      privateKey: signing.privateKey,
      publicKey: signing.publicKey,
      keyId: signing.keyId,
      issuer: env.JWT_ISSUER || TOKEN_DEFAULTS.issuer,
      audience: env.JWT_AUDIENCE || TOKEN_DEFAULTS.audience,
      accessTtlSeconds,
      ephemeral,
    }),
    refreshToken: Object.freeze({ ttlDays: refreshTtlDays, graceSeconds: refreshGraceSeconds }),
    tokenEncKey,
    tokenEncKeyEphemeral,
  });
}

// Importing never throws; the server entry calls loadConfig() to validate.
const config = loadConfig(process.env, { validate: false });

module.exports = { config, loadConfig };
