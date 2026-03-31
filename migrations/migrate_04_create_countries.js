const mongoose = require('mongoose');

/**
 * Migration: Create Country collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('countries')) {
      console.log('  ⚠ Collection "countries" already exists');
      return;
    }
    
    await db.createCollection('countries');
    console.log('  ✓ Created collection: countries');
    
    // Create indexes
    const countriesCollection = db.collection('countries');
    await countriesCollection.createIndex({ name: 1 }, { unique: true });
    await countriesCollection.createIndex({ code: 1 }, { unique: true });
    await countriesCollection.createIndex({ enabled: 1 });
    console.log('  ✓ Created indexes for countries');
  },
  
  async down() {
    const db = mongoose.connection.db;
    try {
      await db.collection('countries').drop();
      console.log('  ✓ Dropped collection: countries');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "countries" does not exist');
      } else {
        throw error;
      }
    }
  }
};
