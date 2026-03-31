const mongoose = require('mongoose');

/**
 * Migration: Create Artist collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('artists')) {
      console.log('  ⚠ Collection "artists" already exists');
      return;
    }
    
    await db.createCollection('artists');
    console.log('  ✓ Created collection: artists');
    
    // Create indexes
    const artistsCollection = db.collection('artists');
    await artistsCollection.createIndex({ name: 1 });
    await artistsCollection.createIndex({ active: 1 });
    console.log('  ✓ Created indexes for artists');
  },
  
  async down() {
    const db = mongoose.connection.db;
    try {
      await db.collection('artists').drop();
      console.log('  ✓ Dropped collection: artists');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "artists" does not exist');
      } else {
        throw error;
      }
    }
  }
};
