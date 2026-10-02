const mongoose = require('mongoose');
const { loadConfig } = require('./config');
const { logger } = require('./lib/logger');
const { createApp } = require('./app');

/** Validate config, connect to MongoDB, start listening and wire graceful shutdown. */
async function start() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  if (config.jwt.ephemeral) {
    logger.warn("ephemeral signing keys; tokens won't survive a restart");
  }
  if (config.tokenEncKeyEphemeral) {
    logger.warn("ephemeral TOKEN_ENC_KEY; refresh grace data won't survive a restart");
  }

  if (config.codes.hmacKeyEphemeral) {
    logger.warn("ephemeral CODE_HMAC_KEY; codes that were sent won't work after a restart");
  }
  if (config.codes.testMode) {
    logger.warn(
      { recipients: config.codes.testRecipients.length },
      'CODE_TEST_MODE is on: listed test recipients get a fixed code and no message is sent. Never enable this in production',
    );
  }

  mongoose.connection.on('error', (err) => logger.error({ err: err.message }, 'MongoDB connection error'));
  mongoose.connection.once('open', () => logger.info('Connected to MongoDB'));
  mongoose.connect(config.mongodbUri).catch((err) => {
    logger.error({ err: err.message }, 'MongoDB initial connection failed');
    process.exit(1);
  });

  const server = createApp().listen(config.port, () => {
    logger.info({ port: config.port }, 'Bondfire API listening');
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      try {
        await mongoose.connection.close();
        process.exit(0);
      } catch (err) {
        logger.error({ err: err.message }, 'Error during shutdown');
        process.exit(1);
      }
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) start();

module.exports = { start };
