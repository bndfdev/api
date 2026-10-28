/**
 * In-memory MongoDB (a one-member replica set, so transactions work) for tests
 * that need a database. Tests that don't need one never load this file.
 *
 *   before(connect); beforeEach(clear); after(disconnect);
 *
 * Require the models (or the module under test) before calling connect(), so
 * their indexes are built.
 */
const mongoose = require('mongoose');

let replSet;

async function connect() {
  // Loaded here, not at the top: `node --test` also runs this file as if it were a test.
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  // The TTL monitor runs every second (default 60) so tests can see expiry happen. Test files run in
  // parallel, each with its own database, so on a busy machine one can take longer than the default
  // 10 seconds to start; that used to fail every test in the file at once.
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--setParameter', 'ttlMonitorSleepSecs=1'], launchTimeout: 60000 }],
  });
  await mongoose.connect(replSet.getUri(), { dbName: 'bondfire_test' });
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
}

/** Empty every collection; indexes stay. */
async function clear() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

async function disconnect() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
  replSet = undefined;
}

module.exports = { connect, clear, disconnect };
