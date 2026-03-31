const mongoose = require('mongoose');

/**
 * Migration: Create MobileOtp collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('mobileotps')) {
      console.log('  ⚠ Collection "mobileotps" already exists');
      return;
    }
    
    await db.createCollection('mobileotps');
    console.log('  ✓ Created collection: mobileotps');
    
    // Create indexes
    const mobileOtpCollection = db.collection('mobileotps');
    await mobileOtpCollection.createIndex({ phone: 1 }, { unique: true });
    await mobileOtpCollection.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    console.log('  ✓ Created indexes for mobileotps');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('mobileotps').drop();
      console.log('  ✓ Dropped collection: mobileotps');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "mobileotps" does not exist');
      } else {
        throw error;
      }
    }
  }
};
