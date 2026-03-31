const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

/**
 * Migration Runner for Bondfire MongoDB Collections
 * Tracks executed migrations in a 'migrations' collection
 */

const MIGRATIONS_COLLECTION = 'migrations';

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/bondfire';
  
  try {
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB');
    return mongoose.connection;
  } catch (error) {
    console.error('✗ Failed to connect to MongoDB:', error.message);
    process.exit(1);
  }
}

async function getMigrationsCollection(db) {
  try {
    const collection = db.collection(MIGRATIONS_COLLECTION);
    // Create indexes if they don't exist
    await collection.createIndex({ name: 1 }, { unique: true });
    return collection;
  } catch (error) {
    console.error('Error accessing migrations collection:', error);
    throw error;
  }
}

async function getExecutedMigrations(migrationsCollection) {
  try {
    const executed = await migrationsCollection.find({}).toArray();
    return executed.map(m => m.name);
  } catch (error) {
    console.error('Error retrieving executed migrations:', error);
    return [];
  }
}

async function runMigration(migrationFile, migrationsCollection) {
  try {
    const migration = require(path.join(__dirname, migrationFile));
    
    console.log(`\n→ Running migration: ${migrationFile}`);
    await migration.up();
    
    // Record migration as executed
    await migrationsCollection.insertOne({
      name: migrationFile,
      executedAt: new Date(),
    });
    
    console.log(`✓ Migration completed: ${migrationFile}`);
    return true;
  } catch (error) {
    console.error(`✗ Error running migration ${migrationFile}:`, error.message);
    return false;
  }
}

async function rollbackMigration(migrationFile, migrationsCollection) {
  try {
    const migration = require(path.join(__dirname, migrationFile));
    
    if (!migration.down) {
      console.log(`⚠ No rollback defined for: ${migrationFile}`);
      return false;
    }
    
    console.log(`\n→ Rolling back migration: ${migrationFile}`);
    await migration.down();
    
    // Remove migration record
    await migrationsCollection.deleteOne({ name: migrationFile });
    
    console.log(`✓ Rollback completed: ${migrationFile}`);
    return true;
  } catch (error) {
    console.error(`✗ Error rolling back migration ${migrationFile}:`, error.message);
    return false;
  }
}

async function runMigrations() {
  const db = await connectDB();
  const migrationsCollection = await getMigrationsCollection(db);
  const executedMigrations = await getExecutedMigrations(migrationsCollection);
  
  // Get all migration files
  const migrationFiles = fs.readdirSync(__dirname)
    .filter(file => file.startsWith('migrate_') && file.endsWith('.js'))
    .sort();
  
  console.log(`\n📦 Found ${migrationFiles.length} migration files`);
  console.log(`✓ Already executed: ${executedMigrations.length} migrations\n`);
  
  let executed = 0;
  let skipped = 0;
  
  for (const file of migrationFiles) {
    if (executedMigrations.includes(file)) {
      console.log(`⊘ Skipped (already executed): ${file}`);
      skipped++;
    } else {
      const success = await runMigration(file, migrationsCollection);
      if (success) executed++;
    }
  }
  
  console.log(`\n✓ Migration Summary:`);
  console.log(`  • Newly executed: ${executed}`);
  console.log(`  • Previously executed: ${skipped}`);
  console.log(`  • Total: ${migrationFiles.length}\n`);
  
  await mongoose.connection.close();
  console.log('✓ Connection closed\n');
}

async function rollbackLatest() {
  const db = await connectDB();
  const migrationsCollection = await getMigrationsCollection(db);
  const executedMigrations = await getExecutedMigrations(migrationsCollection);
  
  if (executedMigrations.length === 0) {
    console.log('No migrations to rollback');
    await mongoose.connection.close();
    return;
  }
  
  // Rollback in reverse order
  const lastMigration = executedMigrations[executedMigrations.length - 1];
  await rollbackMigration(lastMigration, migrationsCollection);
  
  await mongoose.connection.close();
}

// CLI handling
const command = process.argv[2];

if (command === 'rollback') {
  rollbackLatest().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} else {
  runMigrations().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
