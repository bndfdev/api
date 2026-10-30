/**
 * The shared sample pictures for colour rules v1 (src/lib/palette.js) and their expected palettes.
 *
 *   node test/fixtures/palette/generate.js             writes the pictures (the same pixels every time)
 *   node test/fixtures/palette/generate.js --expected  also rewrites expected.json from the current rules
 *
 * The pictures are drawn pixel by pixel here (no fonts, no SVG renderer), so they never depend on a library
 * version; test/palette.test.js checks that the committed files still decode to exactly these pixels. They are
 * banner-sized (786x528, the smallest banner the API accepts, 393:264). `figma_banner.jpg` is not generated: it is
 * the Figma red and blue test banner, copied in once.
 *
 * The app copies this folder and checks its own engine against expected.json. The server is the source of truth.
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const DIR = __dirname;
const WIDTH = 786;
const HEIGHT = 528;

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));

/** A picture of WIDTH x HEIGHT whose pixel (x, y) is `paint(x, y)`: [r, g, b] or [r, g, b, a]. */
function draw(channels, paint) {
  const data = Buffer.alloc(WIDTH * HEIGHT * channels);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) data.set(paint(x, y), (y * WIDTH + x) * channels);
  }
  return { width: WIDTH, height: HEIGHT, channels, data };
}

const plain = (colour) => draw(3, () => hex(colour));

/** #808080 with a centred red square covering 2% of the picture (91x91 px, 1.995%). */
function logoOnGrey() {
  const side = Math.round(Math.sqrt(WIDTH * HEIGHT * 0.02));
  const left = Math.floor((WIDTH - side) / 2);
  const top = Math.floor((HEIGHT - side) / 2);
  const inside = (x, y) => x >= left && x < left + side && y >= top && y < top + side;
  return draw(3, (x, y) => (inside(x, y) ? hex('#D02020') : hex('#808080')));
}

/** A centred #20C040 circle (radius 35% of the height) on a fully transparent background, edges anti-aliased. */
function transparentCircle() {
  const radius = HEIGHT * 0.35;
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const green = hex('#20C040');
  return draw(4, (x, y) => {
    // Coverage from 4x4 samples inside the pixel.
    let covered = 0;
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const dx = x + (sx + 0.5) / 4 - cx;
        const dy = y + (sy + 0.5) / 4 - cy;
        if (dx * dx + dy * dy <= radius * radius) covered += 1;
      }
    }
    return covered === 0 ? [0, 0, 0, 0] : [...green, Math.round((covered * 255) / 16)];
  });
}

/** Every generated picture: file name, what it shows, and its pixels. */
function pictures() {
  return [
    { file: 'white.png', picture: 'Plain #FFFFFF', image: plain('#FFFFFF') },
    { file: 'black.png', picture: 'Plain #000000', image: plain('#000000') },
    {
      file: 'grey_photo.png',
      picture: 'A left-to-right grey gradient, #000000 to #FFFFFF',
      image: draw(3, (x) => { const v = Math.round((x * 255) / (WIDTH - 1)); return [v, v, v]; }),
    },
    { file: 'yellow.png', picture: 'Plain #FFE600', image: plain('#FFE600') },
    { file: 'navy.png', picture: 'Plain #0B1A4A', image: plain('#0B1A4A') },
    { file: 'logo_on_grey.png', picture: '#808080 with a centred #D02020 square covering 2% of the picture', image: logoOnGrey() },
    {
      file: 'red_blue.png',
      picture: '#D02020 on the left 60% (472 px), #2040D0 on the right 40%',
      image: draw(3, (x) => (x < Math.round(WIDTH * 0.6) ? hex('#D02020') : hex('#2040D0'))),
    },
    {
      file: 'transparent.png',
      picture: 'A centred #20C040 circle on a transparent background (flattened onto black first)',
      image: transparentCircle(),
    },
  ];
}

/** Every sample picture, generated or copied, with what it shows. */
const FILES = Object.freeze([
  ...pictures().map(({ file, picture }) => ({ file, picture })),
  { file: 'figma_banner.jpg', picture: 'The Figma red and blue test banner (1572x1056 JPEG)' },
]);

async function writePictures() {
  for (const { file, image } of pictures()) {
    const { width, height, channels, data } = image;
    const png = await sharp(data, { raw: { width, height, channels } }).png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(path.join(DIR, file), png);
  }
}

async function writeExpected() {
  // Loaded here so that writing the pictures alone does not need the colour library.
  const { analyseImage, PALETTE_VERSION } = require('../../../src/lib/palette');
  const files = {};
  for (const { file, picture } of FILES) {
    const { palette, blurhash } = await analyseImage(fs.readFileSync(path.join(DIR, file)));
    files[file] = { picture, palette, blurhash };
  }
  const expected = {
    rules: `colour rules v${PALETTE_VERSION}`,
    generatedBy: 'test/fixtures/palette/generate.js --expected (the API, src/lib/palette.js)',
    files,
  };
  fs.writeFileSync(path.join(DIR, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
}

if (require.main === module) {
  (async () => {
    await writePictures();
    if (process.argv.includes('--expected')) await writeExpected();
  })().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}

module.exports = { pictures, FILES, DIR };
