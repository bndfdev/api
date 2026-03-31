const mongoose = require('mongoose');

/**
 * Migration: Create VerificationToken collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('verificationtokens')) {
      console.log('  ⚠ Collection "verificationtokens" already exists');
      return;
    }
    
    await db.createCollection('verificationtokens');
    console.log('  ✓ Created collection: verificationtokens');
    
    // Create indexes
    const verificationTokenCollection = db.collection('verificationtokens');
    await verificationTokenCollection.createIndex({ email: 1 }, { unique: true });
    await verificationTokenCollection.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    console.log('  ✓ Created indexes for verificationtokens');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('verificationtokens').drop();
      console.log('  ✓ Dropped collection: verificationtokens');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "verificationtokens" does not exist');
      } else {
        throw error;
      }
    }
  }
};
