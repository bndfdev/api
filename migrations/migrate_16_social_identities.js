const mongoose = require('mongoose');

/**
 * Migration: social login (Google, Facebook). See docs/DB_CHANGES.md, 2026-11-17.
 *
 * - users.email_1 becomes unique AND sparse, so accounts created by a provider that shares no email
 *   (field absent) don't collide with each other. Mongoose autoIndex never replaces an existing index
 *   with different options, so this has to be done here.
 * - users.social_identity_unique: one Bondfire account per provider account.
 * - link_tokens: tokenHash unique, and expiresAt TTL (documents removed when they expire).
 *
 * Needs the database owner's review before it runs against any shared database.
 */

const SOCIAL_INDEX = 'social_identity_unique';

async function indexNamed(collection, name) {
  const indexes = await collection.indexes().catch((error) => {
    if (error.codeName === 'NamespaceNotFound') return [];
    throw error;
  });
  return indexes.find((index) => index.name === name);
}

module.exports = {
  async up() {
    const db = mongoose.connection.db;
    const users = db.collection('users');

    const email = await indexNamed(users, 'email_1');
    if (email && !email.sparse) {
      // Same key, different options: drop and rebuild. Uniqueness is unchanged for every stored address.
      await users.dropIndex('email_1');
      console.log('  ✓ Dropped users.email_1 (unique, not sparse)');
    }
    if (!email || !email.sparse) {
      await users.createIndex({ email: 1 }, { name: 'email_1', unique: true, sparse: true });
      console.log('  ✓ Created users.email_1 (unique, sparse)');
    } else {
      console.log('  ⚠ users.email_1 is already unique and sparse');
    }

    await users.createIndex(
      { 'socialIdentities.provider': 1, 'socialIdentities.providerUserId': 1 },
      { name: SOCIAL_INDEX, unique: true, partialFilterExpression: { 'socialIdentities.providerUserId': { $type: 'string' } } },
    );
    console.log(`  ✓ Created users.${SOCIAL_INDEX}`);

    const linkTokens = db.collection('link_tokens');
    await linkTokens.createIndex({ tokenHash: 1 }, { name: 'tokenHash_1', unique: true });
    await linkTokens.createIndex({ expiresAt: 1 }, { name: 'expiresAt_1', expireAfterSeconds: 0 });
    console.log('  ✓ Created link_tokens indexes');
  },

  async down() {
    const db = mongoose.connection.db;
    const users = db.collection('users');

    if (await indexNamed(users, SOCIAL_INDEX)) await users.dropIndex(SOCIAL_INDEX);
    try {
      await db.collection('link_tokens').drop();
    } catch (error) {
      if (error.codeName !== 'NamespaceNotFound') throw error;
    }

    // The old index refuses more than one account without an email: put it back only when that is safe.
    const withoutEmail = await users.countDocuments({ email: { $exists: false } });
    if (withoutEmail > 1) {
      console.log(`  ⚠ ${withoutEmail} accounts have no email: users.email_1 left sparse (decide what to do with them first)`);
      return;
    }
    const email = await indexNamed(users, 'email_1');
    if (email && email.sparse) await users.dropIndex('email_1');
    if (!email || email.sparse) await users.createIndex({ email: 1 }, { name: 'email_1', unique: true });
    console.log('  ✓ Restored users.email_1 (unique, not sparse)');
  },
};
