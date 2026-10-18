/**
 * Profile image processing (PUT /me/avatar, PUT /me/banner), per the spec's `setAvatar` / `setBanner`:
 * - the file must be a JPEG, PNG, WebP or HEIC/HEIF image (checked from its content, not its name or type);
 * - at most 8000 px per side, after the EXIF orientation is applied;
 * - the crop is a rectangle in fractions (0-1) of the oriented image: square for an avatar, 393:264 for a banner,
 *   each within 2%; at least 200x200 (avatar) or 786x528 (banner) pixels;
 * - the output is JPEG at the spec's widths (never enlarged), on black where the original was transparent, with
 *   every piece of metadata removed (EXIF, GPS, camera): sharp writes none unless asked to.
 *
 * HEIC from iPhones is usually HEVC-coded, which the prebuilt sharp cannot decode; such a file is IMAGE_UNREADABLE.
 * The app sends JPEG.
 */
const sharp = require('sharp');
const { ApiError } = require('./problem');

const MAX_SIDE = 8000;
const RATIO_TOLERANCE = 0.02;
const FORMATS = Object.freeze(['jpeg', 'png', 'webp', 'heif']);

/** What each kind of image must be and the sizes it is made in. */
const KINDS = Object.freeze({
  avatar: Object.freeze({ ratio: 1, minWidth: 200, minHeight: 200, widths: Object.freeze([128, 256, 512, 1024]), defaultWidth: 512 }),
  banner: Object.freeze({ ratio: 393 / 264, minWidth: 786, minHeight: 528, widths: Object.freeze([786, 1179, 1572]), defaultWidth: 1179 }),
});

const problem = (status, code, title, detail) => new ApiError({ status, code, title, detail });
const unreadable = () => problem(422, 'IMAGE_UNREADABLE', 'Image unreadable', 'This file could not be read as an image. Try another photo.');
const unsupported = () => problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type', 'Send a JPEG, PNG, WebP or HEIC photo.');
const tooLarge = () => problem(422, 'IMAGE_DIMENSIONS_TOO_LARGE', 'Image too large', `Use a photo of at most ${MAX_SIDE} pixels per side.`);
const cropInvalid = (detail) => problem(422, 'CROP_INVALID', 'Crop invalid', detail);
const tooSmall = (kind) => problem(422, 'IMAGE_TOO_SMALL', 'Image too small',
  `After cropping, the photo must be at least ${KINDS[kind].minWidth}x${KINDS[kind].minHeight} pixels.`);

/**
 * Read the `crop` form field (JSON text of an `ImageCrop`).
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function parseCrop(text) {
  let crop;
  try {
    crop = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw cropInvalid('The crop must be JSON: {"x": 0, "y": 0, "width": 1, "height": 1}.');
  }
  const fields = ['x', 'y', 'width', 'height'];
  if (!crop || typeof crop !== 'object' || Array.isArray(crop) ||
      Object.keys(crop).some((k) => !fields.includes(k)) ||
      fields.some((k) => typeof crop[k] !== 'number' || !Number.isFinite(crop[k]))) {
    throw cropInvalid('The crop needs x, y, width and height, each a number from 0 to 1.');
  }
  const { x, y, width, height } = crop;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 + 1e-6 || y + height > 1 + 1e-6) {
    throw cropInvalid('The crop must lie inside the photo (fractions from 0 to 1).');
  }
  return { x, y, width, height };
}

/** The crop in pixels of the oriented image, adjusted to the exact ratio (it is already within 2%). */
function pixelCrop(crop, imageWidth, imageHeight, kind) {
  const { ratio, minWidth, minHeight } = KINDS[kind];
  let left = Math.round(crop.x * imageWidth);
  let top = Math.round(crop.y * imageHeight);
  let width = Math.min(Math.round(crop.width * imageWidth), imageWidth - left);
  let height = Math.min(Math.round(crop.height * imageHeight), imageHeight - top);
  if (width < 1 || height < 1) throw cropInvalid('The crop is empty.');
  if (Math.abs(width / height / ratio - 1) > RATIO_TOLERANCE) {
    throw cropInvalid(kind === 'avatar' ? 'An avatar crop must be square.' : 'A banner crop must be 393:264 (about 1.49:1).');
  }
  // Trim the longer side, keeping the centre, so the ratio is exact.
  if (width / height > ratio) {
    const exact = Math.round(height * ratio);
    left += Math.floor((width - exact) / 2);
    width = exact;
  } else {
    const exact = Math.round(width / ratio);
    top += Math.floor((height - exact) / 2);
    height = exact;
  }
  if (width < minWidth || height < minHeight) throw tooSmall(kind);
  return { left, top, width, height };
}

/**
 * Check and process an uploaded photo.
 * @param {Buffer} body the file
 * @param {string | object} cropText the `crop` field
 * @param {'avatar' | 'banner'} kind
 * @returns {Promise<{variants: Array<{width: number, height: number, body: Buffer}>, width: number, height: number}>}
 *   the files to store, smallest first, and the size of the default one
 */
async function processImage(body, cropText, kind) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown image kind: ${kind}`);
  const crop = parseCrop(cropText);
  if (!Buffer.isBuffer(body) || body.length === 0) throw unreadable();

  let meta;
  try {
    meta = await sharp(body).metadata();
  } catch {
    throw unreadable();
  }
  if (!FORMATS.includes(meta.format)) throw unsupported();
  // Orientations 5-8 turn the picture a quarter, so its width and height swap.
  const turned = meta.orientation >= 5;
  const imageWidth = turned ? meta.height : meta.width;
  const imageHeight = turned ? meta.width : meta.height;
  if (!imageWidth || !imageHeight) throw unreadable();
  if (imageWidth > MAX_SIDE || imageHeight > MAX_SIDE) throw tooLarge();

  const area = pixelCrop(crop, imageWidth, imageHeight, kind);
  const widths = spec.widths.filter((w) => w <= area.width);
  const largest = widths[widths.length - 1];

  // One decode: orient, crop and shrink to the largest size; the smaller sizes are made from that.
  let base;
  try {
    base = await sharp(body, { limitInputPixels: MAX_SIDE * MAX_SIDE, failOn: 'error' })
      .rotate()
      .extract(area)
      .resize({ width: largest, height: Math.round(largest / spec.ratio), fit: 'fill' })
      .flatten({ background: '#000000' })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw unreadable();
  }

  const variants = [];
  for (const width of widths) {
    const height = Math.round(width / spec.ratio);
    const out = await sharp(base.data, { raw: base.info })
      .resize({ width, height, fit: 'fill' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    variants.push({ width, height, body: out });
  }
  const chosen = variants.filter((v) => v.width <= spec.defaultWidth).pop() || variants[0];
  return { variants, width: chosen.width, height: chosen.height };
}

module.exports = { processImage, parseCrop, KINDS, MAX_SIDE };
