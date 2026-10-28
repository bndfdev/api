/**
 * Picks the SMS provider named by config (`sms.provider`).
 *
 * TODO(PR 4, phone verification): the real SMS provider (Twilio Verify, AWS SNS
 * or similar) has not been chosen. Until then only the console provider exists,
 * so no text message is ever sent. A real one goes in `sms/<name>.js`, takes the
 * same `send({to, purpose, code, expiresInMinutes})`, and is added to the switch
 * below and to the SMS_PROVIDER check in src/config.js.
 */
const { config: defaultConfig } = require('../../config');
const { logger: defaultLogger } = require('../../lib/logger');
const { createConsoleSmsProvider } = require('./console');

/** @param {{config?: object, logger?: object}} [options] */
function createSmsProvider({ config = defaultConfig, logger = defaultLogger } = {}) {
  switch (config.sms.provider) {
    case 'console':
      return createConsoleSmsProvider({ logger, logCodes: config.codes.logInDev });
    default:
      throw new Error('Unknown SMS provider');
  }
}

module.exports = { createSmsProvider };
