const mongoose = require('mongoose');

/**
 * Migration: Create PublishedAudio collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('publishedaudios')) {
      console.log('  ⚠ Collection "publishedaudios" already exists');
      return;
    }
    
    await db.createCollection('publishedaudios');
    console.log('  ✓ Created collection: publishedaudios');
    
    // Create indexes
    const publishedAudioCollection = db.collection('publishedaudios');
    await publishedAudioCollection.createIndex({ createdAt: 1 });
    console.log('  ✓ Created indexes for publishedaudios');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('publishedaudios').drop();
      console.log('  ✓ Dropped collection: publishedaudios');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "publishedaudios" does not exist');
      } else {
        throw error;
      }
    }
  }
};
