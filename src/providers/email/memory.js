const { createMemoryProvider } = require('../memory');

const createMemoryEmailProvider = () => createMemoryProvider('email');

module.exports = { createMemoryEmailProvider };
