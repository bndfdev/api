# MongoDB Migrations for Bondfire API

This directory contains database migration files for creating and managing MongoDB collections used in the Bondfire Music App API.

## Overview

The migration system tracks which migrations have been executed using a `migrations` collection in MongoDB. This prevents accidental re-execution of migrations and maintains a history of schema changes.

## What's Included

The following collections are created by the migrations:

1. **users** - User accounts with authentication
2. **genres** - Music genres
3. **artists** - Artist information
4. **countries** - Country data for user locations
5. **userpreferences** - User's genre and artist preferences
6. **guestusers** - Guest user sessions
7. **recordings** - User-created audio recordings
8. **otps** - One-time passwords for email verification
9. **verificationtokens** - Email verification tokens
10. **publishedaudios** - Published audio content
11. **pendingemails** - Pending email registrations
12. **passwordresettokens** - Password reset tokens
13. **mobileotps** - OTPs for phone verification
14. **mobileotpsendlogs** - Log of mobile OTP sends
15. **otpsendlogs** - Log of email OTP sends

Each migration also creates appropriate indexes for optimal query performance.

## Usage

### Run All Pending Migrations

```bash
npm run migrate
```

This will execute all migration files that haven't been run yet. The system tracks executed migrations in the `migrations` collection.

### Rollback Latest Migration

```bash
npm run migrate:rollback
```

This will undo the most recently executed migration (if it has a `down()` function defined).

### Manual Execution

If needed, you can run the migration script directly:

```bash
node migrations/runner.js          # Run pending migrations
node migrations/runner.js rollback # Rollback last migration
```

## Migration Files

Each migration file follows the naming convention: `migrate_XX_description.js`

### Structure of a Migration File

```javascript
module.exports = {
  async up() {
    // Create collection and indexes
    // This runs when applying the migration
  },
  
  async down() {
    // Drop collection (optional)
    // This runs when rolling back
  }
};
```

### Key Features

- **Idempotent**: Migrations check if collections/indexes already exist before creating them
- **Tracked**: All executed migrations are recorded in the database
- **Rollbackable**: Most migrations include a `down()` function to undo changes
- **Clear Logging**: Console output shows progress with ✓ and ✗ symbols

## Environment Variables

The migration system uses the same MongoDB connection as the main API:

```bash
MONGODB_URI=mongodb://localhost:27017/bondfire
```

If not set, it defaults to `mongodb://localhost:27017/bondfire`

## Creating New Migrations

To create a new migration:

1. Create a new file: `migrate_XX_description.js` (where XX is the next sequential number)
2. Implement the `up()` function
3. Optionally implement the `down()` function
4. Place it in the `migrations/` directory
5. Run `npm run migrate`

Example:

```javascript
const mongoose = require('mongoose');

module.exports = {
  async up() {
    const db = mongoose.connection;
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    if (!collectionNames.includes('mycollection')) {
      await db.createCollection('mycollection');
      console.log('  ✓ Created collection: mycollection');
      
      const myCollection = db.collection('mycollection');
      await myCollection.createIndex({ email: 1 }, { unique: true });
      console.log('  ✓ Created indexes for mycollection');
    }
  },
  
  async down() {
    const db = mongoose.connection;
    try {
      await db.collection('mycollection').drop();
      console.log('  ✓ Dropped collection: mycollection');
    } catch (error) {
      if (error.message.includes('ns not found')) {
        console.log('  ⚠ Collection "mycollection" does not exist');
      } else {
        throw error;
      }
    }
  }
};
```

## Important Notes

- Migrations are executed in alphabetical order (01, 02, 03, etc.)
- The `migrations` collection must exist - it's created automatically by the runner
- If a migration fails, it won't be marked as executed, allowing you to retry
- Rollback only works for the most recent migration
- The `createdAt` field in collections uses `Date.now`

## Troubleshooting

### "Failed to connect to MongoDB"
- Ensure MongoDB is running
- Check your `MONGODB_URI` environment variable
- Verify the database name in the connection string

### "Migration already executed"
- The system prevents re-running migrations that have already been executed
- If you need to re-run a migration, rollback first or manually delete it from the `migrations` collection

### "NativeError: ns not found"
- This is harmless - it means the collection didn't exist during rollback
- The migration system handles this gracefully

## Integration with API

The migrations are typically run as part of deployment or setup. Add to your startup process:

```bash
npm run migrate && npm start
```

Or include in your CI/CD pipeline to ensure collections are created before the API starts.
