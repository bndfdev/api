/**
 * Picks where profile images are stored, by config (`media.storage`). Only `local` exists for now; an object
 * storage driver (S3 or similar) would add `put`, `removePrefix` and `publicUrl` with the same meaning.
 */
const { config: defaultConfig } = require('../../config');
const { createLocalStorage } = require('./local');

/** @param {{config?: object}} [options] */
function createStorage({ config = defaultConfig } = {}) {
  switch (config.media.storage) {
    case 'local':
      return createLocalStorage({ dir: config.media.dir, publicUrl: config.media.publicUrl });
    default:
      throw new Error('Unknown media storage');
  }
}

module.exports = { createStorage, storage: createStorage() };
