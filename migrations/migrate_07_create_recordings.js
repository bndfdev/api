const mongoose = require('mongoose');

/**
 * Migration: Create Recording collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('recordings')) {
      console.log('  ⚠ Collection "recordings" already exists');
      return;
    }
    
    await db.createCollection('recordings');
    console.log('  ✓ Created collection: recordings');
    
    // Create indexes
    const recordingCollection = db.collection('recordings');
    await recordingCollection.createIndex({ userId: 1 });
    await recordingCollection.createIndex({ createdAt: 1 });
    await recordingCollection.createIndex({ isPublic: 1 });
    console.log('  ✓ Created indexes for recordings');
  },
  
  async down() {
    const db = mongoose.connection.db;
    try {
      await db.collection('recordings').drop();
      console.log('  ✓ Dropped collection: recordings');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "recordings" does not exist');
      } else {
        throw error;
      }
    }
  }
};
