/**
 * Development provider: writes "code sent to <masked destination>" to the log
 * and sends nothing. The code itself is never logged, except when
 * `logCodes` is on (config: LOG_CODES_IN_DEV=true with NODE_ENV=development),
 * so a developer can type it into the app.
 */
const { logger: defaultLogger } = require('../lib/logger');
const { maskDestination } = require('../lib/destination');

/**
 * @param {'email' | 'sms'} channel
 * @param {{logger?: object, logCodes?: boolean}} [options]
 */
function createConsoleProvider(channel, { logger = defaultLogger, logCodes = false } = {}) {
  return {
    name: 'console',
    async send({ to, purpose, code }) {
      const masked = maskDestination(channel, to);
      // The code goes into the message text on purpose: structured fields named
      // "code" are redacted by the logger.
      const message = logCodes
        ? `DEV ONLY: ${channel} code for ${masked} is ${code}`
        : `${channel} code sent to ${masked} (console provider: nothing was really sent)`;
      logger.info({ channel, purpose }, message);
    },
  };
}

module.exports = { createConsoleProvider };
