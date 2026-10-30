/**
 * The colours of a profile picture ("colour rules v1") and its BlurHash, worked out once when it is uploaded and
 * sent with every `Image` (`palette`, `blurhash`). The app runs the same rules (Dart `material_color_utilities`)
 * only when it has no server palette, and both sides check themselves against the shared sample pictures in
 * test/fixtures/palette (expected.json). The server's answer is the one that counts.
 *
 * Input: the picture as the user sees it (for an upload, the crop with transparency flattened onto black), shrunk
 * with an area filter so its longest side is 64 px (64x43 for a banner), RGB only, alpha 255.
 *
 * 1. Pixels: every pixel as an ARGB int.
 * 2. Clusters: QuantizerCelebi with at most 128 colours, giving colour -> count. `total` is the sum of the counts;
 *    each cluster has `hct = Hct.fromInt(argb)` and `share = count / total`.
 * 3. Colourful families: only clusters with chroma >= 16 are colourful. hueShare[h] (h = 0..359) is the sum of the
 *    shares of the colourful clusters whose round(hue) % 360 is h. A colourful cluster's familyShare is the sum of
 *    hueShare over the hues within +/-15 degrees of its rounded hue (wrapping around 360). It is a candidate when
 *    familyShare >= 0.05, so a small spot (a logo, a sticker) never wins.
 * 4. Score, as Material's `Score`: familyShare * 100 * 0.7 + (chroma - 48) * (chroma < 48 ? 0.1 : 0.3). The seed
 *    is the candidate with the highest score; ties go to the larger familyShare, then the smaller ARGB value.
 * 5. Neutral: with no candidate, the picture is neutral and the seed is the share-weighted average of all the
 *    clusters' sRGB channels (each rounded). The accent keeps the seed's hue with a chroma of at most 6: a grey
 *    with a faint tint of the photo.
 * 6. Average colour: `avg`, the share-weighted average of all the clusters' sRGB channels, rounded (the seed of
 *    a neutral picture).
 * 7. Accent tone: at most `cap = Contrast.darker(100, 4.5)` (white text still reads at 4.5:1; 49 if the library
 *    says -1), and at least `floor = Contrast.lighter(backdropTone, 3.0)` (the accent stands out 3:1 from the page
 *    background: black at 80% over the blurred picture, so each channel of `avg` x 0.2, rounded; a floor of -1 or
 *    above the cap is the cap). Olive guard: the hue is the seed's, except that when the picture is not neutral,
 *    round(hue) is 90..111, round(chroma) > 16 and round(tone) < 65 (the clamped tone: the band Material's own
 *    DislikeAnalyzer calls muddy olive), it is 85, a deep gold; a yellow banner (#FFE600) would otherwise give
 *    #847700. accent = Hct.from(hue, chroma, clamped seed tone).
 * 8. Output: `{version: 1, seed: '#RRGGBB', accent: '#RRGGBB', neutral}`, hex in upper case.
 *
 * Blur preview: a BlurHash with 4x3 components of the same picture shrunk (area filter) to 32 px wide.
 *
 * `@material/material-color-utilities` is published as an ES module only, so this CommonJS code loads it with a
 * dynamic import(), once (see `material()`).
 */
const sharp = require('sharp');
const { encode } = require('blurhash');

/** The version of the colour rules above. Stored with every palette, so a later version can be recomputed. */
const PALETTE_VERSION = 1;

const PALETTE_SIZE = 64; // longest side of the picture the palette is worked out from
const MAX_COLOURS = 128; // clusters asked of the quantizer
const MIN_CHROMA = 16; // below this a cluster is not colourful
const FAMILY_DEGREES = 15; // a hue family: +/- this many degrees around a cluster's hue
const MIN_FAMILY_SHARE = 0.05; // the smallest share of the picture a colour family needs to win
const NEUTRAL_MAX_CHROMA = 6; // the most chroma a neutral picture's accent keeps
const WHITE_TEXT_CONTRAST = 4.5; // white text on the accent (WCAG AA)
const BACKDROP_CONTRAST = 3.0; // the accent against the page background
const BACKDROP_SHADE = 0.2; // the page background: black at 80% over the blurred picture
const FALLBACK_CAP = 49;
// Olive guard: Material's DislikeAnalyzer band (rounded hue 90 to 111, chroma over 16, tone under 65) and the hue
// such an accent takes instead.
const OLIVE_BAND = Object.freeze({ fromHue: 90, toHue: 111, minChroma: 16, maxTone: 65 });
const GOLD_HUE = 85;
const BLUR_WIDTH = 32;
const BLUR_COMPONENTS = Object.freeze({ x: 4, y: 3 });

let library;
/** The Material colour library (ES module only), imported once and shared; a failed import is tried again. */
function material() {
  library ??= import('@material/material-color-utilities').catch((err) => {
    library = undefined;
    throw err;
  });
  return library;
}

/**
 * Shrink raw pixels with an area filter: every output pixel is the coverage-weighted mean of the source pixels
 * under it (each axis separately, horizontal first, rounded once at the end). Pure arithmetic, so the result does
 * not depend on the image library's resampling.
 * @param {{data: Uint8Array, width: number, height: number, channels?: number}} image only the first 3 channels
 *   (R, G, B) are used
 * @param {number} outWidth
 * @param {number} outHeight
 * @returns {{data: Buffer, width: number, height: number, channels: 3}}
 */
function resizeArea({ data, width, height, channels = 3 }, outWidth, outHeight) {
  const across = areaWeights(width, outWidth);
  const down = areaWeights(height, outHeight);
  const rows = new Float64Array(outWidth * height * 3);
  for (let y = 0; y < height; y++) {
    for (let ox = 0; ox < outWidth; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0, at = across.offset[ox]; k < across.count[ox]; k++, at++) {
        const weight = across.weights[at];
        const i = (y * width + across.first[ox] + k) * channels;
        r += data[i] * weight;
        g += data[i + 1] * weight;
        b += data[i + 2] * weight;
      }
      const o = (y * outWidth + ox) * 3;
      rows[o] = r;
      rows[o + 1] = g;
      rows[o + 2] = b;
    }
  }
  const out = Buffer.alloc(outWidth * outHeight * 3);
  for (let oy = 0; oy < outHeight; oy++) {
    for (let ox = 0; ox < outWidth; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0, at = down.offset[oy]; k < down.count[oy]; k++, at++) {
        const weight = down.weights[at];
        const i = ((down.first[oy] + k) * outWidth + ox) * 3;
        r += rows[i] * weight;
        g += rows[i + 1] * weight;
        b += rows[i + 2] * weight;
      }
      const o = (oy * outWidth + ox) * 3;
      out[o] = clampByte(r);
      out[o + 1] = clampByte(g);
      out[o + 2] = clampByte(b);
    }
  }
  return { data: out, width: outWidth, height: outHeight, channels: 3 };
}

/**
 * For each output position o along one side, the source positions it covers (`count[o]` of them, from
 * `first[o]`) and the fraction of o each one covers (`weights`, from `offset[o]`). Flat arrays, for speed.
 */
function areaWeights(size, outSize) {
  const first = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const offset = new Int32Array(outSize);
  const weights = [];
  for (let o = 0; o < outSize; o++) {
    const start = (o * size) / outSize;
    const end = ((o + 1) * size) / outSize;
    const span = end - start;
    first[o] = Math.floor(start);
    offset[o] = weights.length;
    // Every source position from floor(start) up to ceil(end) overlaps the span (they are contiguous).
    for (let i = first[o]; i < Math.min(Math.ceil(end), size); i++) {
      weights.push((Math.min(end, i + 1) - Math.max(start, i)) / span);
    }
    count[o] = weights.length - offset[o];
  }
  return { first, count, offset, weights: Float64Array.from(weights) };
}

const clampByte = (value) => Math.min(255, Math.max(0, Math.round(value)));

/** `#RRGGBB`, upper case. */
const hexOf = (argb) => `#${(argb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;

/** Step 4: a candidate's score, as Material's `Score` weighs proportion and chroma. */
function scoreOf(familyShare, chroma) {
  return familyShare * 100 * 0.7 + (chroma - 48) * (chroma < 48 ? 0.1 : 0.3);
}

/**
 * Step 7, the olive guard: the accent's hue. A colour picture's accent whose hue, chroma and (clamped) tone fall in
 * the band Material's DislikeAnalyzer calls muddy olive (dark yellow) takes the gold hue instead.
 */
function accentHue(hue, chroma, tone, neutral) {
  const rounded = Math.round(hue);
  const olive = !neutral && rounded >= OLIVE_BAND.fromHue && rounded <= OLIVE_BAND.toHue &&
    Math.round(chroma) > OLIVE_BAND.minChroma && Math.round(tone) < OLIVE_BAND.maxTone;
  return olive ? GOLD_HUE : hue;
}

/** Step 4: the candidate with the highest score; ties go to the larger familyShare, then the smaller ARGB value. */
function pickSeed(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!best || candidate.score > best.score ||
        (candidate.score === best.score && (candidate.familyShare > best.familyShare ||
          (candidate.familyShare === best.familyShare && candidate.argb < best.argb)))) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Step 2: QuantizerCelebi, which is Wu's quantizer and then k-means (QuantizerWsmeans) started from Wu's colours.
 * The JavaScript k-means puts each distinct colour in a cluster chosen with Math.random before its first pass, and
 * only moves it when another cluster is clearly nearer, so the same picture could give slightly different clusters
 * from one run to the next. The two steps are called here directly, and for the k-means call (synchronous, so
 * nothing else runs meanwhile) Math.random gives a fixed sequence instead: distinct colour i starts in cluster
 * i mod n, the start the Dart library uses. The same picture then always gives the same palette.
 * @returns {Map<number, number>} colour (ARGB) -> count
 */
function quantize(m, pixels) {
  const starts = new m.QuantizerWu().quantize(pixels, MAX_COLOURS);
  const clusterCount = Math.min(MAX_COLOURS, new Set(pixels).size, starts.length);
  const random = Math.random;
  let call = 0;
  Math.random = () => ((call++ % clusterCount) + 0.5) / clusterCount;
  try {
    return m.QuantizerWsmeans.quantize(pixels, starts, MAX_COLOURS);
  } finally {
    Math.random = random;
  }
}

/**
 * Colour rules v1, steps 1 to 8, on a picture already shrunk as the rules say (see `analyseImage`).
 * @param {{data: Uint8Array, width: number, height: number, channels?: number}} image raw pixels, R, G, B first
 * @returns {Promise<{version: number, seed: string, accent: string, neutral: boolean}>}
 */
async function computePalette({ data, width, height, channels = 3 }) {
  const count = width * height;
  if (!Number.isInteger(count) || count < 1 || !data || data.length < count * channels) {
    throw new Error('computePalette needs raw pixels');
  }
  const m = await material();

  // 1. Pixels.
  const pixels = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * channels;
    pixels[i] = m.argbFromRgb(data[o], data[o + 1], data[o + 2]);
  }

  // 2. Clusters.
  const quantized = quantize(m, pixels);
  let total = 0;
  for (const population of quantized.values()) total += population;
  const clusters = [...quantized].map(([argb, population]) => ({ argb, hct: m.Hct.fromInt(argb), share: population / total }));

  // 3. Colourful families and candidates.
  const colourful = clusters.filter((c) => c.hct.chroma >= MIN_CHROMA);
  const hueShare = new Array(360).fill(0);
  for (const c of colourful) {
    c.hue = Math.round(c.hct.hue) % 360;
    hueShare[c.hue] += c.share;
  }
  const candidates = [];
  for (const c of colourful) {
    let familyShare = 0;
    for (let d = -FAMILY_DEGREES; d <= FAMILY_DEGREES; d++) familyShare += hueShare[(c.hue + d + 360) % 360];
    if (familyShare >= MIN_FAMILY_SHARE) {
      // 4. Score.
      candidates.push({ argb: c.argb, hct: c.hct, familyShare, score: scoreOf(familyShare, c.hct.chroma) });
    }
  }

  // 6. Average colour.
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const c of clusters) {
    red += m.redFromArgb(c.argb) * c.share;
    green += m.greenFromArgb(c.argb) * c.share;
    blue += m.blueFromArgb(c.argb) * c.share;
  }
  const avg = [clampByte(red), clampByte(green), clampByte(blue)];

  // 4 and 5. Seed, or neutral.
  const best = pickSeed(candidates);
  const neutral = best === null;
  const seed = neutral ? m.argbFromRgb(...avg) : best.argb;
  const seedHct = m.Hct.fromInt(seed);
  const chroma = neutral ? Math.min(seedHct.chroma, NEUTRAL_MAX_CHROMA) : seedHct.chroma;

  // 7. Accent tone.
  let cap = m.Contrast.darker(100, WHITE_TEXT_CONTRAST);
  if (cap === -1) cap = FALLBACK_CAP;
  const backdrop = m.argbFromRgb(...avg.map((channel) => Math.round(channel * BACKDROP_SHADE)));
  const backdropTone = m.Hct.fromInt(backdrop).tone;
  let floor = m.Contrast.lighter(backdropTone, BACKDROP_CONTRAST);
  if (floor === -1 || floor > cap) floor = cap;
  const tone = Math.min(Math.max(seedHct.tone, floor), cap);
  const accent = m.Hct.from(accentHue(seedHct.hue, chroma, tone, neutral), chroma, tone).toInt();

  // 8. Output.
  return { version: PALETTE_VERSION, seed: hexOf(seed), accent: hexOf(accent), neutral };
}

/**
 * The BlurHash (4x3 components) of a picture already shrunk to 32 px wide.
 * @param {{data: Uint8Array, width: number, height: number, channels?: number}} image raw pixels, R, G, B first
 * @returns {string}
 */
function computeBlurhash({ data, width, height, channels = 3 }) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = data[i * channels];
    rgba[i * 4 + 1] = data[i * channels + 1];
    rgba[i * 4 + 2] = data[i * channels + 2];
    rgba[i * 4 + 3] = 255;
  }
  return encode(rgba, width, height, BLUR_COMPONENTS.x, BLUR_COMPONENTS.y);
}

/** The sizes the rules shrink a `width` x `height` picture to: the palette's (longest side 64) and the blur's. */
function analysisSizes(width, height) {
  const longest = Math.max(width, height);
  return {
    palette: {
      width: Math.max(1, Math.round((width * PALETTE_SIZE) / longest)),
      height: Math.max(1, Math.round((height * PALETTE_SIZE) / longest)),
    },
    blur: { width: BLUR_WIDTH, height: Math.max(1, Math.round((height * BLUR_WIDTH) / width)) },
  };
}

/**
 * The palette and BlurHash of a picture: decoded once (EXIF orientation applied, transparency flattened onto
 * black, sRGB), then shrunk once for each rule.
 * @param {Buffer} input an image file, or raw pixels described by `raw`
 * @param {{raw?: {width: number, height: number, channels: number}}} [options] for raw pixels (sharp's `raw`)
 * @returns {Promise<{palette: object, blurhash: string}>}
 */
async function analyseImage(input, { raw } = {}) {
  const { data, info } = await sharp(input, raw ? { raw } : { failOn: 'error' })
    .rotate()
    .flatten({ background: '#000000' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = { data, width: info.width, height: info.height, channels: info.channels };
  const sizes = analysisSizes(info.width, info.height);
  const palette = await computePalette(resizeArea(image, sizes.palette.width, sizes.palette.height));
  const blurhash = computeBlurhash(resizeArea(image, sizes.blur.width, sizes.blur.height));
  return { palette, blurhash };
}

module.exports = {
  PALETTE_VERSION,
  computePalette,
  computeBlurhash,
  analyseImage,
  analysisSizes,
  resizeArea,
  scoreOf,
  pickSeed,
  material,
};
