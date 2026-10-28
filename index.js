// Entry shim: the app lives in src/. Keeps `npm start` / `node index.js` working.
const { start } = require('./src/server');
start();
