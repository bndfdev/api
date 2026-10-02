require('dotenv').config();

const REQUIRED = ['MONGODB_URI'];

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

/**
 * Build the runtime config from an env map.
 * With `validate` (default) throws an Error naming any missing required vars
 * (names only, never values). MONGODB_URI is not required when NODE_ENV=test.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{validate?: boolean}} [options]
 */
function loadConfig(env = process.env, { validate = true } = {}) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isTest = nodeEnv === 'test';

  if (validate && !isTest) {
    const missing = REQUIRED.filter((name) => !env[name]);
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

  const isProduction = nodeEnv === 'production';
  let corsOrigins;
  if (env.CORS_ORIGINS !== undefined && env.CORS_ORIGINS.trim() !== '') {
    corsOrigins = parseOrigins(env.CORS_ORIGINS);
  } else {
    corsOrigins = isProduction ? [] : [...DEV_CORS_ORIGINS];
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
  });
}

// Importing never throws; the server entry calls loadConfig() to validate.
const config = loadConfig(process.env, { validate: false });

module.exports = { config, loadConfig };
