const { createConsoleProvider } = require('../console');

/** @param {{logger?: object, logCodes?: boolean}} [options] */
const createConsoleSmsProvider = (options) => createConsoleProvider('sms', options);

module.exports = { createConsoleSmsProvider };
