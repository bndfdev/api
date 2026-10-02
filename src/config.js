const crypto = require('node:crypto');
const { normalizeDestination } = require('./lib/destination');
require('dotenv').config();

const REQUIRED = ['MONGODB_URI'];
// Needed to sign access tokens, to protect the refresh grace data and to hash
// one-time codes. Required in every environment except local development and tests.
const REQUIRED_TOKEN_VARS = ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KEY_ID', 'TOKEN_ENC_KEY', 'CODE_HMAC_KEY'];
// Needed when email is sent through SMTP.
const REQUIRED_SMTP_VARS = ['SMTP_HOST', 'SMTP_FROM'];
// "Name <address>" or a bare address; no line breaks (header injection).
const MAIL_FROM = /^(?:[^\s<>@]+@[^\s<>@]+|[^<>\r\n]+<[^\s<>@]+@[^\s<>@]+>)$/;
const KEYLESS_ENVS = Object.freeze(['development', 'test']);
// The only NODE_ENV values where CODE_TEST_MODE may be on. Exact match: 'production', 'prod' and 'Production' are all refused.
const TEST_MODE_ENVS = Object.freeze(['staging', 'development', 'test']);

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
// OWASP's minimum for argon2id (memory in KiB), and the most a deployment may ask for.
const ARGON2_DEFAULTS = Object.freeze({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
const ARGON2_LIMITS = Object.freeze({ memoryKib: 1048576, timeCost: 10, parallelism: 16 });
// Most reverse proxies (load balancers, CDNs) we would ever stack in front of the API.
const MAX_TRUSTED_PROXY_HOPS = 10;

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
let ephemeralCodeKey;

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

function getEphemeralCodeKey() {
  if (!ephemeralCodeKey) ephemeralCodeKey = crypto.randomBytes(32);
  return ephemeralCodeKey;
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

/** true / false from env; unset or empty is false. Anything else is reported as invalid. */
function readBool(env, name, invalid) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  invalid.push(`${name} (must be true or false)`);
  return false;
}

/** Comma-separated destinations (emails or phone numbers): trimmed and normalised, empty entries dropped. */
function parseRecipients(value) {
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalizeDestination(entry.includes('@') ? 'email' : 'sms', entry));
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
 * The JWT, token-encryption and code-hashing vars and TRUST_PROXY are required unless
 * NODE_ENV is development (also when unset) or test; there, missing keys are generated
 * for this process (`jwt.ephemeral`, `tokenEncKeyEphemeral`, `codes.hmacKeyEphemeral`).
 * Email goes through SMTP (SMTP_HOST and SMTP_FROM required, TLS required) except in
 * development and test, where it defaults to the console provider, the only place that
 * provider is allowed. CODE_TEST_MODE is only allowed when NODE_ENV is exactly staging,
 * development (also when unset) or test; any other value, such as production, prod or
 * Production, is refused.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{validate?: boolean}} [options]
 */
function loadConfig(env = process.env, { validate = true } = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isTest = nodeEnv === 'test';
  const isProduction = nodeEnv === 'production';
  const mayGenerateKeys = KEYLESS_ENVS.includes(nodeEnv);
  const emailProvider = (env.EMAIL_PROVIDER || '').trim().toLowerCase() || (mayGenerateKeys ? 'console' : 'smtp');

  const privatePem = normalizePem(env.JWT_PRIVATE_KEY);
  const publicPem = normalizePem(env.JWT_PUBLIC_KEY);

  if (validate) {
    const missing = isTest ? [] : REQUIRED.filter((name) => !env[name]);
    if (!mayGenerateKeys) {
      missing.push(...REQUIRED_TOKEN_VARS.filter((name) => !env[name]));
      // A deployed API must say how many proxies are in front of it (0 for none):
      // guessing wrong would make every client look like the load balancer, or
      // let clients choose their own IP address.
      if (env.TRUST_PROXY === undefined || env.TRUST_PROXY.trim() === '') missing.push('TRUST_PROXY');
    } else if (Boolean(privatePem) !== Boolean(publicPem)) {
      missing.push(privatePem ? 'JWT_PUBLIC_KEY' : 'JWT_PRIVATE_KEY');
    }
    if (emailProvider === 'smtp') {
      missing.push(...REQUIRED_SMTP_VARS.filter((name) => !env[name] || env[name].trim() === ''));
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

  // How many reverse proxies sit in front of the API (0 = none). Only a hop
  // count is accepted: trusting every X-Forwarded-For value would let a client
  // pick its own IP address, and with it its rate-limit bucket.
  let trustProxy = false;
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY.trim() !== '') {
    const hops = env.TRUST_PROXY.trim();
    if (/^\d+$/.test(hops) && Number(hops) <= MAX_TRUSTED_PROXY_HOPS) {
      trustProxy = Number(hops) > 0 ? Number(hops) : false;
    } else {
      invalid.push(`TRUST_PROXY (must be a number of proxy hops from 0 to ${MAX_TRUSTED_PROXY_HOPS})`);
    }
  }

  // --- One-time codes ---
  let codeHmacKey;
  let codeHmacKeyEphemeral = false;
  if (env.CODE_HMAC_KEY) {
    codeHmacKey = Buffer.from(env.CODE_HMAC_KEY, 'base64');
    if (codeHmacKey.length !== 32) {
      invalid.push('CODE_HMAC_KEY (must be 32 bytes, base64-encoded)');
      codeHmacKey = undefined;
    }
  } else if (mayGenerateKeys) {
    codeHmacKey = getEphemeralCodeKey();
    codeHmacKeyEphemeral = true;
  }

  // Staging test mode: tester accounts get a fixed code and nothing is sent to them.
  // Only on an allowlist of environments (an allowlist, so a misspelt or differently
  // cased production name cannot switch it on); even an unvalidated config fails closed.
  const testModeRequested = readBool(env, 'CODE_TEST_MODE', invalid);
  const testModeAllowed = TEST_MODE_ENVS.includes(nodeEnv);
  if (testModeRequested && !testModeAllowed) {
    invalid.push('CODE_TEST_MODE (only allowed when NODE_ENV is staging, development or test)');
  }
  const codeTestMode = testModeRequested && testModeAllowed;
  const testRecipients = codeTestMode ? parseRecipients(env.CODE_TEST_RECIPIENTS || '') : [];
  const testValue = codeTestMode ? (env.CODE_TEST_VALUE || '').trim() : undefined;
  if (codeTestMode) {
    if (testRecipients.length === 0) invalid.push('CODE_TEST_RECIPIENTS (required when CODE_TEST_MODE is true)');
    if (!/^\d{6}$/.test(testValue)) invalid.push('CODE_TEST_VALUE (must be exactly 6 digits when CODE_TEST_MODE is true)');
  }
  // --- Password hashing (argon2id) ---
  // Defaults are the OWASP minimum for argon2id: 19 MiB of memory, 2 passes, 1 lane. Raise them as hardware allows.
  const argon2MemoryKib = readBoundedInt(env, 'ARGON2_MEMORY_KIB', ARGON2_DEFAULTS.memoryKib, ARGON2_LIMITS.memoryKib, invalid);
  const argon2TimeCost = readBoundedInt(env, 'ARGON2_TIME_COST', ARGON2_DEFAULTS.timeCost, ARGON2_LIMITS.timeCost, invalid);
  const argon2Parallelism = readBoundedInt(env, 'ARGON2_PARALLELISM', ARGON2_DEFAULTS.parallelism, ARGON2_LIMITS.parallelism, invalid);
  if (argon2MemoryKib < 8 * argon2Parallelism) invalid.push('ARGON2_MEMORY_KIB (must be at least 8 times ARGON2_PARALLELISM)');

  // Printing codes to the log is a development convenience only.
  const logCodesRequested = readBool(env, 'LOG_CODES_IN_DEV', invalid);

  // --- Outgoing email and SMS ---
  if (emailProvider !== 'console' && emailProvider !== 'smtp') {
    invalid.push('EMAIL_PROVIDER (must be console or smtp)');
  } else if (emailProvider === 'console' && !mayGenerateKeys) {
    invalid.push('EMAIL_PROVIDER (console only logs; it is only allowed when NODE_ENV is development or test)');
  }
  const smtpPort = readBoundedInt(env, 'SMTP_PORT', 587, 65535, invalid);
  const smtpUser = env.SMTP_USER || undefined;
  const smtpPass = env.SMTP_PASS || undefined;
  if (Boolean(smtpUser) !== Boolean(smtpPass)) invalid.push('SMTP_USER and SMTP_PASS (set both or neither)');
  const smtpFrom = env.SMTP_FROM ? env.SMTP_FROM.trim() : undefined;
  if (smtpFrom && !MAIL_FROM.test(smtpFrom)) invalid.push('SMTP_FROM (must be an address or "Name <address>")');
  // TODO(PR 4, phone verification): choose the SMS provider; only the console provider exists for now.
  const smsProvider = (env.SMS_PROVIDER || '').trim().toLowerCase() || 'console';
  if (smsProvider !== 'console') invalid.push('SMS_PROVIDER (only console is available for now)');

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
    trustProxy,
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
    passwords: Object.freeze({ memoryKib: argon2MemoryKib, timeCost: argon2TimeCost, parallelism: argon2Parallelism }),
    tokenEncKey,
    tokenEncKeyEphemeral,
    codes: Object.freeze({
      hmacKey: codeHmacKey,
      hmacKeyEphemeral: codeHmacKeyEphemeral,
      testMode: codeTestMode,
      testRecipients: Object.freeze(testRecipients),
      testValue,
      logInDev: logCodesRequested && nodeEnv === 'development',
    }),
    email: Object.freeze({
      provider: emailProvider,
      smtp: Object.freeze({
        host: env.SMTP_HOST ? env.SMTP_HOST.trim() : undefined,
        port: smtpPort,
        secure: smtpPort === 465,
        // Mail carrying codes only goes over an encrypted connection, everywhere except development and test.
        requireTls: !mayGenerateKeys,
        user: smtpUser,
        pass: smtpPass,
        from: smtpFrom,
      }),
    }),
    sms: Object.freeze({ provider: smsProvider }),
  });
}

// Importing never throws; the server entry calls loadConfig() to validate.
const config = loadConfig(process.env, { validate: false });

module.exports = { config, loadConfig };
