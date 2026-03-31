const mongoose = require('mongoose');

/**
 * Migration: Create PasswordResetToken collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('passwordresettokens')) {
      console.log('  ⚠ Collection "passwordresettokens" already exists');
      return;
    }
    
    await db.createCollection('passwordresettokens');
    console.log('  ✓ Created collection: passwordresettokens');
    
    // Create indexes
    const passwordResetTokenCollection = db.collection('passwordresettokens');
    await passwordResetTokenCollection.createIndex({ email: 1 }, { unique: true });
    await passwordResetTokenCollection.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    console.log('  ✓ Created indexes for passwordresettokens');
  },
  
  async down() {
    const db = mongoose.connection.db;
    try {
      await db.collection('passwordresettokens').drop();
      console.log('  ✓ Dropped collection: passwordresettokens');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "passwordresettokens" does not exist');
      } else {
        throw error;
      }
    }
  }
};
