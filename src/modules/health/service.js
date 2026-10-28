const mongoose = require('mongoose');

const CONNECTED = 1;

/**
 * Readiness per `readiness` in docs/api/paths/catalog.yaml:
 * status ready | degraded | down, checks map of name -> ok | failing.
 * Only the database is checked for now; email, sms and storage checks join
 * when those providers are wired in.
 */
function getReadiness() {
  const database = mongoose.connection.readyState === CONNECTED ? 'ok' : 'failing';
  return {
    status: database === 'ok' ? 'ready' : 'down',
    checks: { database },
  };
}

module.exports = { getReadiness };
