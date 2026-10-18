/**
 * Profile photos (docs/api/paths/me.yaml: setAvatar, removeAvatar, setBanner, removeBanner). The rules only:
 * no HTTP. Images go through src/lib/images.js, the files to `storage`, and the record to the users repo.
 *
 * - Only the direct upload is offered (`multipart/form-data` with `file` and `crop`). The two-step upload
 *   (POST /me/media/uploads, then `uploadId`) needs object storage and is not built yet, so an `uploadId` is
 *   always UPLOAD_NOT_FOUND.
 * - Processing finishes before the answer, so the image is `ready` at once. No moderation yet.
 * - Each upload gets its own folder, so its addresses never change and can be cached forever. The photo it
 *   replaces is deleted after the new one is saved; if that deletion fails, the old files are left behind (logged),
 *   never the account without a photo.
 */
const crypto = require('node:crypto');
const { ApiError } = require('../../lib/problem');
const { processImage } = require('../../lib/images');
const { logger: defaultLogger } = require('../../lib/logger');
const { storage: defaultStorage } = require('../../providers/storage');
const { toImage } = require('../users/service');
const defaultUsers = require('../users/repo');

const KINDS = Object.freeze(['avatar', 'banner']);

const uploadNotFound = () => new ApiError({
  status: 404, code: 'UPLOAD_NOT_FOUND', title: 'Upload not found',
  detail: 'Send the photo itself as multipart/form-data with "file" and "crop".',
});
const accountGone = () => new ApiError({
  status: 401, code: 'SESSION_REVOKED', title: 'Session revoked', detail: 'Sign in again.',
  headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
});

/**
 * @param {{users?: object, storage?: object, now?: () => number, logger?: object, newId?: () => string}} [deps]
 */
function createMediaService({
  users = defaultUsers,
  storage = defaultStorage,
  now = Date.now,
  logger = defaultLogger,
  newId = () => crypto.randomBytes(12).toString('hex'),
} = {}) {
  const urlFor = (key) => storage.publicUrl(key);

  /** Delete an image's files; a failure is logged, never thrown (the account is already right). */
  async function discard(image, userId) {
    if (!image || typeof image.path !== 'string') return;
    try {
      await storage.removePrefix(image.path);
    } catch (err) {
      logger.warn({ err, userId: String(userId) }, 'could not delete old profile image files');
    }
  }

  /**
   * Set the avatar or banner from an uploaded file.
   * @param {{userId: string, kind: 'avatar' | 'banner', file?: {buffer: Buffer}, crop?: string, uploadId?: string}} input
   * @returns {Promise<object>} the new `Image`
   */
  async function setImage({ userId, kind, file, crop, uploadId }) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown image kind: ${kind}`);
    if (!file) {
      if (uploadId !== undefined) throw uploadNotFound();
      throw new Error('setImage needs a file');
    }
    const processed = await processImage(file.buffer, crop, kind);
    const path = `${kind}s/${String(userId).toLowerCase()}/${newId()}`;
    try {
      for (const variant of processed.variants) {
        await storage.put(`${path}/${variant.width}.jpg`, variant.body);
      }
    } catch (err) {
      await discard({ path }, userId);
      throw err;
    }

    const image = {
      path,
      width: processed.width,
      height: processed.height,
      variants: processed.variants.map(({ width, height }) => ({ width, height })),
      updatedAt: new Date(now()),
    };
    let saved;
    try {
      saved = await users.setImage(userId, kind, image, now());
    } catch (err) {
      await discard(image, userId);
      throw err;
    }
    if (!saved.found) {
      await discard(image, userId);
      throw accountGone();
    }
    await discard(saved.previous, userId);
    return toImage(image, urlFor);
  }

  /**
   * Remove the avatar or banner. Idempotent.
   * @param {{userId: string, kind: 'avatar' | 'banner'}} input
   */
  async function removeImage({ userId, kind }) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown image kind: ${kind}`);
    const previous = await users.removeImage(userId, kind, now());
    await discard(previous, userId);
  }

  return { setImage, removeImage };
}

module.exports = { createMediaService, KINDS, ...createMediaService() };
