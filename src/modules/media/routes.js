const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { sha256 } = require('../../lib/secrets');
const { rateLimit, byUser } = require('../../middleware/rateLimit');
const defaultAuth = require('../../middleware/requireAuth');
const { accountOnly } = require('../../middleware/requireAuth');
const { idempotency: defaultIdempotency } = require('../../middleware/idempotency');
const { createMediaService, KINDS } = require('./service');

// Processing a photo is the most expensive request we serve, so it is limited per account like the spec's
// upload-intent limit (30 an hour, createUploadIntent's `x-rate-limit`).
const LIMITS = Object.freeze({
  perAccount: { name: 'profile-image:account', points: 30, durationSeconds: 60 * 60, key: byUser },
});

/**
 * The uploaded file, from the spec validator's multipart parsing (multer, in memory, at most 10 MB and one file:
 * src/middleware/validate.js). Its place in the body is a fingerprint of its bytes, so the idempotency check sees
 * a different photo as a different request.
 */
function takeFile(req, res, next) {
  const file = (req.files || []).find((f) => f.fieldname === 'file');
  if (file) {
    req.uploadedFile = file;
    req.body.file = sha256(file.buffer);
  }
  next();
}

/**
 * Profile photos (`docs/api/paths/me.yaml`: meAvatar, meBanner). Account-only: guests get 403 GUEST_NOT_ALLOWED.
 * @param {{service?: object, auth?: {requireAuth: Function}, idempotency?: Function}} [deps]
 *   Without `service`, the real one is built when the first request arrives.
 */
function createMediaRouter({ service, auth = defaultAuth, idempotency = defaultIdempotency } = {}) {
  const { requireAuth } = auth;
  let built = service;
  const svc = () => (built ??= createMediaService());
  const router = express.Router();
  const privateCache = 'private, no-cache';

  for (const kind of KINDS) {
    // PUT /me/avatar, PUT /me/banner: 200 with the new `Image`.
    router.put(
      `/me/${kind}`,
      requireAuth,
      accountOnly,
      rateLimit(LIMITS.perAccount),
      takeFile,
      idempotency,
      asyncHandler(async (req, res) => {
        const image = await svc().setImage({
          userId: req.auth.userId,
          kind,
          file: req.uploadedFile,
          crop: req.body.crop,
          uploadId: req.body.uploadId,
        });
        res.set('Cache-Control', privateCache).json(image);
      }),
    );

    // DELETE /me/avatar, DELETE /me/banner: idempotent.
    router.delete(
      `/me/${kind}`,
      requireAuth,
      accountOnly,
      asyncHandler(async (req, res) => {
        await svc().removeImage({ userId: req.auth.userId, kind });
        res.status(204).end();
      }),
    );
  }

  return router;
}

module.exports = { createMediaRouter, router: createMediaRouter(), LIMITS };
