require('dotenv').config();

const REQUIRED = ['MONGODB_URI'];

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

  return Object.freeze({
    env: nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest,
    port,
    mongodbUri: env.MONGODB_URI,
    logLevel: env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
    apiBaseUrl: env.API_BASE_URL || undefined,
  });
}

// Importing never throws; the server entry calls loadConfig() to validate.
const config = loadConfig(process.env, { validate: false });

module.exports = { config, loadConfig };
