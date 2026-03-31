const mongoose = require('mongoose');

/**
 * Migration: Create MobileOtpSendLog collection with indexes
 */

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (collectionNames.includes('mobileotpsendlogs')) {
      console.log('  ⚠ Collection "mobileotpsendlogs" already exists');
      return;
    }
    
    await db.createCollection('mobileotpsendlogs');
    console.log('  ✓ Created collection: mobileotpsendlogs');
    
    // Create indexes
    const mobileOtpSendLogCollection = db.collection('mobileotpsendlogs');
    await mobileOtpSendLogCollection.createIndex({ phone: 1 });
    await mobileOtpSendLogCollection.createIndex({ sentAt: 1 });
    console.log('  ✓ Created indexes for mobileotpsendlogs');
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('mobileotpsendlogs').drop();
      console.log('  ✓ Dropped collection: mobileotpsendlogs');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "mobileotpsendlogs" does not exist');
      } else {
        throw error;
      }
    }
  }
};
