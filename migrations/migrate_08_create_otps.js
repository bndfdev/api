const mongoose = require('mongoose');

/**
 * Migration: Create Otp collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('otps')) {
      console.log('  ⚠ Collection "otps" already exists');
      return;
    }
    
    await db.createCollection('otps');
    console.log('  ✓ Created collection: otps');
    
    // Create indexes
    const otpCollection = db.collection('otps');
    await otpCollection.createIndex({ email: 1 }, { unique: true });
    await otpCollection.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    console.log('  ✓ Created indexes for otps');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('otps').drop();
      console.log('  ✓ Dropped collection: otps');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "otps" does not exist');
      } else {
        throw error;
      }
    }
  }
};
