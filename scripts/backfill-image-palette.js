/**
 * Fills in the palette (colour rules v1, src/lib/palette.js) and BlurHash of avatars and banners stored before they
 * were worked out at upload. Run by hand only, and against a shared database only with the database owner's OK
 * (docs/DB_CHANGES.md, 2026-10-29):
 *
 *   node scripts/backfill-image-palette.js [--dry-run] [--limit N]
 *
 * - Uses MONGODB_URI and the media settings (MEDIA_STORAGE, MEDIA_DIR) the way the server does.
 * - For every account whose avatar or banner has no palette of the current version, it reads the stored default
 *   size through the storage driver, works out both values, and saves them only if that image is still the same
 *   upload (`<kind>.path` unchanged), so a photo replaced in the meantime keeps its own.
 * - It can be stopped and run again: images already done are skipped, so a second run changes nothing. An image
 *   that cannot be read is logged and left for the next run.
 * - `--dry-run` works everything out and writes nothing. `--limit N` stops once N images are filled (or would be).
 * - It ends with the counts: images checked, filled (or would be), skipped (changed meanwhile) and failed.
 */
const { analyseImage, PALETTE_VERSION } = require('../src/lib/palette');
const defaultUsers = require('../src/modules/users/repo');

const KINDS = Object.freeze(['avatar', 'banner']);
const PAGE_SIZE = 100;

/**
 * The command-line options.
 * @param {string[]} argv
 * @returns {{dryRun: boolean, limit: number}} `limit` is Infinity when not given
 */
function parseArgs(argv) {
  const options = { dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const value = arg === '--limit' ? argv[++i] : arg.slice('--limit='.length);
      if (!/^[1-9][0-9]*$/.test(value || '')) throw new Error('--limit needs a whole number above 0');
      options.limit = Number(value);
    } else {
      throw new Error(`Unknown option: ${arg} (use --dry-run and --limit N)`);
    }
  }
  return options;
}

/** Whether a stored image still needs its palette: it exists and has none of the current version. */
const needsPalette = (image) => Boolean(image) && typeof image.path === 'string' &&
  !(image.palette && image.palette.version === PALETTE_VERSION);

/**
 * Fill in the missing palettes and BlurHashes.
 * @param {{storage: {get: (key: string) => Promise<Buffer>}, users?: object, dryRun?: boolean, limit?: number,
 *   log?: (line: string) => void, pageSize?: number}} options
 * @returns {Promise<{checked: number, filled: number, skipped: number, failed: number}>}
 */
async function backfill({ storage, users = defaultUsers, dryRun = false, limit = Infinity, log = console.log, pageSize = PAGE_SIZE }) {
  const counts = { checked: 0, filled: 0, skipped: 0, failed: 0 };
  log(`Image palettes (colour rules v${PALETTE_VERSION})${dryRun ? ', dry run: nothing is written' : ''}${Number.isFinite(limit) ? `, at most ${limit}` : ''}`);
  let after = null;
  let done = false;
  while (!done) {
    const page = await users.findImagesWithoutPalette(PALETTE_VERSION, { after, limit: pageSize });
    if (page.length === 0) break;
    for (const user of page) {
      for (const kind of KINDS) {
        if (counts.filled >= limit) {
          done = true;
          break;
        }
        const image = user[kind];
        if (!needsPalette(image)) continue;
        counts.checked += 1;
        let look;
        try {
          if (!Number.isInteger(image.width)) throw new Error('no default size stored');
          look = await analyseImage(await storage.get(`${image.path}/${image.width}.jpg`));
        } catch (err) {
          counts.failed += 1;
          log(`could not read the ${kind} of user ${user._id}: ${err.message}`);
          continue;
        }
        if (dryRun) {
          counts.filled += 1;
        } else if (await users.setImageLook(user._id, kind, image.path, look)) {
          counts.filled += 1;
        } else {
          // Replaced or removed since it was read: the new photo has its own palette.
          counts.skipped += 1;
        }
      }
      if (done) break;
      after = user._id;
    }
  }
  log(`checked ${counts.checked}, ${dryRun ? 'would fill' : 'filled'} ${counts.filled}, skipped ${counts.skipped} (changed meanwhile), failed ${counts.failed}`);
  return counts;
}

/** Connect with the server's settings, run, disconnect. */
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const mongoose = require('mongoose');
  const { config } = require('../src/config');
  const { createStorage } = require('../src/providers/storage');
  if (!config.mongodbUri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(config.mongodbUri);
  try {
    console.log(`Connected to ${mongoose.connection.host}, database ${mongoose.connection.name}`);
    await backfill({ ...options, storage: createStorage({ config }) });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { backfill, parseArgs, main, needsPalette };
