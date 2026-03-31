# Migration Setup Guide

## Quick Start

### 1. Install Dependencies (if not already done)
```bash
cd api
npm install
```

### 2. Configure MongoDB Connection

Ensure your `.env` file in the `api/` directory contains:
```env
MONGODB_URI=mongodb://localhost:27017/bondfire
PORT=3000
```

If you're using MongoDB Atlas or a remote server:
```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/bondfire
PORT=3000
```

### 3. Run Migrations

Before starting the API, run the migrations to create all collections:

```bash
npm run migrate
```

You should see output like:
```
✓ Connected to MongoDB
📦 Found 15 migration files
✓ Already executed: 0 migrations

→ Running migration: migrate_01_create_users.js
  ✓ Created collection: users
  ✓ Created indexes for users
✓ Migration completed: migrate_01_create_users.js

→ Running migration: migrate_02_create_genres.js
...
✓ Migration Summary:
  • Newly executed: 15
  • Previously executed: 0
  • Total: 15

✓ Connection closed
```

### 4. Start the API

```bash
npm start      # Production
npm run dev    # Development with nodemon
```

Or use the combined setup command:
```bash
npm run setup
```

## What Gets Created

Running the migrations creates the following collections with proper indexes:

| Collection | Purpose |
|-----------|---------|
| users | User accounts with email and phone |
| genres | Music genres and categories |
| artists | Artist profiles |
| countries | Supported countries |
| userpreferences | User's preferred genres, artists, and locations |
| guestusers | Guest user sessions |
| recordings | User-recorded audio files |
| otps | Email verification OTPs |
| verificationtokens | Email verification tokens |
| publishedaudios | Published music content |
| pendingemails | Pending email registrations |
| passwordresettokens | Password reset tokens |
| mobileotps | Mobile phone verification OTPs |
| mobileotpsendlogs | Log of mobile OTP sends |
| otpsendlogs | Log of email OTP sends |

## Common Issues

### MongoDB Connection Failed
**Problem**: `failed to connect to MongoDB: connect ECONNREFUSED 127.0.0.1:27017`

**Solution**:
- Start MongoDB service: `brew services start mongodb-community` (macOS) or `sudo systemctl start mongod` (Linux)
- Or use a cloud service like MongoDB Atlas

### Collection Already Exists
**Problem**: `⚠ Collection "users" already exists`

**Solution**: This is normal! Migrations are idempotent and won't recreate existing collections. You can safely re-run migrations.

### Port Already in Use
**Error**: `Error: listen EADDRINUSE: address already in use :::3000`

**Solution**:
```bash
# Find process using port 3000
lsof -i :3000
# Kill it
kill -9 <PID>
```

## Reverting Changes

If you need to remove collections for a fresh start:

```bash
# Rollback the last migration
npm run migrate:rollback

# Or rollback multiple times
npm run migrate:rollback
npm run migrate:rollback
npm run migrate:rollback
```

To completely reset:
1. Delete the collections manually in MongoDB Compass or mongosh
2. Delete the `migrations` collection
3. Run migrations again: `npm run migrate`

## Advanced Usage

### Running Migrations from Another Directory

```bash
cd /path/to/bondfire/api
npm run migrate
```

### Checking Migration History

Connect to MongoDB and query the migrations collection:
```javascript
db.migrations.find().pretty()
```

### Creating a New Migration

See [migrations/README.md](./README.md) for details on creating custom migrations.

## In CI/CD Pipeline

Add migration to your deployment pipeline:

```bash
#!/bin/bash
cd api
npm install
npm run migrate  # Run before starting API
npm start
```

Or in Docker:
```dockerfile
FROM node:18
WORKDIR /app/api
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run migrate
CMD ["npm", "start"]
```

## Production Safety

- **Backup your database before running migrations on production**
- Test migrations on a staging environment first
- Use these commands only when you need to reset:
  ```bash
  # Never use in production without backup!
  npm run migrate:rollback
  ```

## Support

For issues with migrations:
1. Check `api/migrations/README.md` for detailed documentation
2. Verify MongoDB is running and accessible
3. Check your `.env` file has correct `MONGODB_URI`
4. Review migration files in `api/migrations/` for schema details
