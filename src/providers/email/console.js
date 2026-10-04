const { createConsoleProvider } = require('../console');

/** @param {{logger?: object, logCodes?: boolean}} [options] */
const createConsoleEmailProvider = (options) => createConsoleProvider('email', options);

module.exports = { createConsoleEmailProvider };
