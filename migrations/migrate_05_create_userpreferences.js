const mongoose = require('mongoose');

/**
 * Migration: Create UserPreference collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('userpreferences')) {
      console.log('  ⚠ Collection "userpreferences" already exists');
      return;
    }
    
    await db.createCollection('userpreferences');
    console.log('  ✓ Created collection: userpreferences');
    
    // Create indexes
    const userpreferenceCollection = db.collection('userpreferences');
    await userpreferenceCollection.createIndex({ user: 1 }, { unique: true });
    console.log('  ✓ Created indexes for userpreferences');
  },
  
  async down() {
    const db = mongoose.connection.db;
    try {
      await db.collection('userpreferences').drop();
      console.log('  ✓ Dropped collection: userpreferences');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "userpreferences" does not exist');
      } else {
        throw error;
      }
    }
  }
};
