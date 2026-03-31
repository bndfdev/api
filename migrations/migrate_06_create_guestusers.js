const mongoose = require('mongoose');

/**
 * Migration: Create GuestUser collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('guestusers')) {
      console.log('  ⚠ Collection "guestusers" already exists');
      return;
    }
    
    await db.createCollection('guestusers');
    console.log('  ✓ Created collection: guestusers');
    
    // Create indexes
    const guestUserCollection = db.collection('guestusers');
    await guestUserCollection.createIndex({ deviceId: 1 }, { unique: true });
    await guestUserCollection.createIndex({ createdAt: 1 });
    console.log('  ✓ Created indexes for guestusers');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('guestusers').drop();
      console.log('  ✓ Dropped collection: guestusers');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "guestusers" does not exist');
      } else {
        throw error;
      }
    }
  }
};
