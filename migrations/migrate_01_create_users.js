const mongoose = require('mongoose');

/**
 * Migration: Create User collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('users')) {
      console.log('  ⚠ Collection "users" already exists');
      return;
    }
    
    await db.createCollection('users');
    console.log('  ✓ Created collection: users');
    
    // Create indexes
    const usersCollection = db.collection('users');
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await usersCollection.createIndex({ phone: 1 }, { sparse: true, unique: true });
    await usersCollection.createIndex({ createdAt: 1 });
    await usersCollection.createIndex({ deviceId: 1 });
    console.log('  ✓ Created indexes for users');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('users').drop();
      console.log('  ✓ Dropped collection: users');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "users" does not exist');
      } else {
        throw error;
      }
    }
  }
};
