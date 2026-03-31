const mongoose = require('mongoose');

/**
 * Migration: Create Genre collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('genres')) {
      console.log('  ⚠ Collection "genres" already exists');
      return;
    }
    
    await db.createCollection('genres');
    console.log('  ✓ Created collection: genres');
    
    // Create indexes
    const genresCollection = db.collection('genres');
    await genresCollection.createIndex({ name: 1 });
    await genresCollection.createIndex({ active: 1 });
    console.log('  ✓ Created indexes for genres');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('genres').drop();
      console.log('  ✓ Dropped collection: genres');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "genres" does not exist');
      } else {
        throw error;
      }
    }
  }
};
