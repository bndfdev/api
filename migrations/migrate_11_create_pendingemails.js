const mongoose = require('mongoose');

/**
 * Migration: Create PendingEmail collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('pendingemails')) {
      console.log('  ⚠ Collection "pendingemails" already exists');
      return;
    }
    
    await db.createCollection('pendingemails');
    console.log('  ✓ Created collection: pendingemails');
    
    // Create indexes
    const pendingEmailCollection = db.collection('pendingemails');
    await pendingEmailCollection.createIndex({ email: 1 }, { unique: true });
    await pendingEmailCollection.createIndex({ createdAt: 1 });
    console.log('  ✓ Created indexes for pendingemails');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('pendingemails').drop();
      console.log('  ✓ Dropped collection: pendingemails');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "pendingemails" does not exist');
      } else {
        throw error;
      }
    }
  }
};
