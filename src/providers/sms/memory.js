const { createMemoryProvider } = require('../memory');

const createMemorySmsProvider = () => createMemoryProvider('sms');

module.exports = { createMemorySmsProvider };
