/**
 * Picks the email provider named by config (`email.provider`): `smtp` (real
 * mail) or `console` (logs only; development and test only). The memory
 * provider is for tests and is injected, never chosen from config.
 */
const { config: defaultConfig } = require('../../config');
const { logger: defaultLogger } = require('../../lib/logger');
const { createConsoleEmailProvider } = require('./console');
const { createSmtpEmailProvider } = require('./smtp');

const CONSOLE_ENVS = Object.freeze(['development', 'test']);

/** @param {{config?: object, logger?: object}} [options] */
function createEmailProvider({ config = defaultConfig, logger = defaultLogger } = {}) {
  switch (config.email.provider) {
    case 'smtp':
      return createSmtpEmailProvider({ smtp: config.email.smtp, requireTLS: config.email.smtp.requireTls });
    case 'console':
      // The config check already refuses this elsewhere; this is the second lock, for a config that was never validated.
      if (!CONSOLE_ENVS.includes(config.env)) throw new Error('The console email provider is only for development and test');
      return createConsoleEmailProvider({ logger, logCodes: config.codes.logInDev });
    default:
      throw new Error('Unknown email provider');
  }
}

module.exports = { createEmailProvider };
