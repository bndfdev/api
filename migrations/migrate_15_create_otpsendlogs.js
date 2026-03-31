const mongoose = require('mongoose');

/**
 * Migration: Create OtpSendLog collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('otpsendlogs')) {
      console.log('  ⚠ Collection "otpsendlogs" already exists');
      return;
    }
    
    await db.createCollection('otpsendlogs');
    console.log('  ✓ Created collection: otpsendlogs');
    
    // Create indexes
    const otpSendLogCollection = db.collection('otpsendlogs');
    await otpSendLogCollection.createIndex({ email: 1 });
    await otpSendLogCollection.createIndex({ sentAt: 1 });
    console.log('  ✓ Created indexes for otpsendlogs');
  },
  
  async down() {
    const db = mongoose.connection.db;
    try {
      await db.collection('otpsendlogs').drop();
      console.log('  ✓ Dropped collection: otpsendlogs');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "otpsendlogs" does not exist');
      } else {
        throw error;
      }
    }
  }
};
