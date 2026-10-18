/**
 * Local storage: image files in a folder on this server (`media.dir`), served at /media (see src/app.js) and
 * reached by the app at `media.publicUrl`. Fine for development and a single server; files do not move with the
 * server and are not shared between servers, so production needs object storage behind the same interface.
 *
 * Keys are relative paths with `/` separators (for example `avatars/<user>/<id>/512.jpg`). Every key is checked
 * to stay inside the folder.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const SAFE_KEY = /^[a-z0-9]+(?:\/[a-z0-9]+)*(?:\.[a-z0-9]+)?$/;

/**
 * @param {{dir: string, publicUrl: string}} options
 */
function createLocalStorage({ dir, publicUrl }) {
  const root = path.resolve(dir);

  /** The file path for a key, or throws for a key that could leave the folder. */
  function fileFor(key) {
    if (typeof key !== 'string' || !SAFE_KEY.test(key)) throw new Error(`Unsafe storage key: ${key}`);
    const file = path.resolve(root, ...key.split('/'));
    if (!file.startsWith(root + path.sep)) throw new Error(`Unsafe storage key: ${key}`);
    return file;
  }

  return {
    name: 'local',
    /** Save `body` under `key`, replacing any file already there. */
    async put(key, body) {
      const file = fileFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Written next to its place and renamed, so a reader never sees half a file.
      const partial = `${file}.${process.pid}.part`;
      await fs.writeFile(partial, body);
      await fs.rename(partial, file);
    },
    /** Delete every file under the folder `prefix`. Missing files are fine (idempotent). */
    async removePrefix(prefix) {
      await fs.rm(fileFor(prefix), { recursive: true, force: true });
    },
    /** The address the app loads `key` from. */
    publicUrl(key) {
      fileFor(key);
      return `${publicUrl}/${key}`;
    },
    /** The folder to serve at /media. */
    root,
  };
}

module.exports = { createLocalStorage };
