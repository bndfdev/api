process.env.NODE_ENV = 'test';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const {
  PALETTE_VERSION, computePalette, computeBlurhash, analyseImage, analysisSizes, resizeArea, scoreOf, pickSeed, material,
} = require('../src/lib/palette');
const { pictures, FILES, DIR } = require('./fixtures/palette/generate');

const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const read = (file) => fs.readFileSync(path.join(DIR, file));

let m;
before(async () => {
  m = await material();
});

// WCAG 2 contrast, worked out here without the colour library.
const channel = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
const hctOf = (hex) => m.Hct.fromInt(m.argbFromHex(hex));
const hexOf = (argb) => `#${(argb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
/** The page background the floor is measured against: each channel of the average colour x 0.2. */
const backdropOf = (avgHex) => `#${[1, 3, 5].map((i) => Math.round(parseInt(avgHex.slice(i, i + 2), 16) * 0.2).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** Raw RGB pixels in one row: `[hex, count]` runs, in order. */
function strip(...runs) {
  const width = runs.reduce((n, [, count]) => n + count, 0);
  const data = Buffer.alloc(width * 3);
  let at = 0;
  for (const [hex, count] of runs) {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let i = 0; i < count; i++, at += 3) data.set(rgb, at);
  }
  return { data, width, height: 1 };
}

/** A colour (as hex) whose own HCT, after rounding to 8-bit sRGB, passes `ok`; searched near hue/chroma/tone. */
function colourNear(hue, chroma, tone, ok) {
  for (let dh = 0; dh <= 3; dh += 0.05) {
    for (const sign of [1, -1]) {
      for (let dc = -1; dc <= 1; dc += 0.1) {
        const hex = hexOf(m.Hct.from(hue + sign * dh, chroma + dc, tone).toInt());
        if (ok(hctOf(hex))) return hex;
      }
    }
  }
  throw new Error(`no colour near ${hue}/${chroma}/${tone}`);
}

// ---------------------------------------------------------------------------
// The shared sample pictures (test/fixtures/palette)

test('the sample pictures are exactly what the generator draws', async () => {
  for (const { file, image } of pictures()) {
    const { data, info } = await sharp(read(file)).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height, info.channels], [image.width, image.height, image.channels], file);
    assert.ok(data.equals(image.data), `${file} differs from its generator: run node test/fixtures/palette/generate.js`);
  }
  assert.deepEqual(Object.keys(expected.files), FILES.map((f) => f.file));
});

test('every sample picture gives the palette and blurhash in expected.json', async () => {
  assert.equal(expected.rules, `colour rules v${PALETTE_VERSION}`);
  for (const { file } of FILES) {
    const result = await analyseImage(read(file));
    assert.deepEqual(result.palette, expected.files[file].palette, file);
    assert.equal(result.blurhash, expected.files[file].blurhash, file);
    assert.equal(result.blurhash.length, 28, `${file}: 4x3 components make 28 characters`);
    assert.match(result.palette.seed, /^#[0-9A-F]{6}$/);
    assert.match(result.palette.accent, /^#[0-9A-F]{6}$/);
  }
});

test('white, black and the grey photo are neutral, with a grey accent', () => {
  for (const file of ['white.png', 'black.png', 'grey_photo.png']) {
    const { palette } = expected.files[file];
    assert.equal(palette.neutral, true, file);
    assert.ok(hctOf(palette.accent).chroma <= 6.5, `${file}: accent ${palette.accent} is grey`);
  }
  assert.equal(expected.files['white.png'].palette.seed, '#FFFFFF');
  assert.equal(expected.files['black.png'].palette.seed, '#000000');
});

test('a red logo on 2% of a grey picture does not win: the picture is neutral (#6)', () => {
  const { palette } = expected.files['logo_on_grey.png'];
  assert.equal(palette.neutral, true);
  assert.ok(hctOf(palette.accent).chroma <= 6.5);
});

test('red on 60% and blue on 40% gives the red (#7), and so does the Figma test banner', () => {
  assert.equal(expected.files['red_blue.png'].palette.seed, '#D02020');
  assert.equal(expected.files['red_blue.png'].palette.neutral, false);
  const red = hctOf('#D02020').hue;
  for (const file of ['red_blue.png', 'figma_banner.jpg']) {
    const { seed, accent } = expected.files[file].palette;
    for (const hex of [seed, accent]) assert.ok(Math.abs(hctOf(hex).hue - red) < 5, `${file}: ${hex} is red`);
  }
});

test('yellow comes out a deep gold, not olive, and still reads with white text (#4)', () => {
  const { seed, accent, neutral } = expected.files['yellow.png'].palette;
  assert.equal(seed, '#FFE600');
  assert.equal(neutral, false);
  const hue = Math.round(hctOf(accent).hue);
  assert.ok(hue < 90 || hue > 111, `${accent} (hue ${hue}) is outside the olive band 90..111`);
  assert.equal(m.DislikeAnalyzer.isDisliked(hctOf(accent)), false, `${accent} is olive`);
  assert.ok(Math.abs(hctOf(accent).hue - 85) < 1.5, `${accent} takes the gold hue 85`);
  assert.ok(hctOf(accent).chroma >= 30, `${accent} is still a strong colour`);
  assert.ok(contrast('#FFFFFF', accent) >= 4.5, `white on ${accent}: ${contrast('#FFFFFF', accent)}`);
});

test('the olive guard moves accents with a rounded hue of 90 to 111 to hue 85, and no others', async () => {
  // Bright single-colour pictures, so the accent tone is the cap (about 49.5): inside the band's tone limit.
  for (const [hue, expectedHue] of [[89, 89], [90, 85], [111, 85], [112, 112]]) {
    const colour = colourNear(hue, 40, 80, (h) => Math.round(h.hue) === hue && h.chroma > 30);
    const { accent, neutral } = await computePalette(strip([colour, 1000]));
    assert.equal(neutral, false);
    assert.ok(Math.abs(hctOf(accent).hue - expectedHue) < 1.5, `${colour} (hue ${hue}): accent ${accent} hue ${hctOf(accent).hue}`);
  }
  // A neutral picture in that hue range keeps its own (faint) hue.
  const tinted = colourNear(100, 12, 80, (h) => Math.round(h.hue) === 100 && h.chroma > 11 && h.chroma < 13);
  const result = await computePalette(strip([tinted, 1000]));
  assert.equal(result.neutral, true);
  assert.ok(Math.abs(hctOf(result.accent).hue - hctOf(tinted).hue) < 5);
});

test('navy is brightened to at least the floor, so it stands out 3:1 from the page background (#5)', () => {
  const { seed, accent } = expected.files['navy.png'].palette;
  const backdrop = backdropOf(seed); // neutral or not, a plain picture's average is its own colour
  const floor = m.Contrast.lighter(hctOf(backdrop).tone, 3.0);
  assert.ok(hctOf(accent).tone > hctOf(seed).tone + 20, `${accent} is brighter than ${seed}`);
  assert.ok(hctOf(accent).tone >= floor - 0.5, `${accent} tone ${hctOf(accent).tone} under the floor ${floor}`);
  assert.ok(contrast(accent, backdrop) >= 3.0, `${accent} on ${backdrop}: ${contrast(accent, backdrop)}`);
  assert.ok(Math.abs(hctOf(accent).hue - hctOf(seed).hue) < 2, 'the hue is kept');
});

test('white text reads on every accent at 4.5:1 or more (#15)', () => {
  for (const { file } of FILES) {
    const { accent } = expected.files[file].palette;
    const ratio = contrast('#FFFFFF', accent);
    assert.ok(ratio >= 4.5, `${file}: white on ${accent} is ${ratio.toFixed(2)}:1`);
  }
});

test('a transparent PNG is read as flattened onto black (#9)', async () => {
  const transparent = pictures().find((p) => p.file === 'transparent.png').image;
  const onBlack = Buffer.alloc(transparent.width * transparent.height * 3);
  for (let i = 0; i < transparent.width * transparent.height; i++) {
    const alpha = transparent.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) onBlack[i * 3 + c] = Math.round(transparent.data[i * 4 + c] * alpha);
  }
  const opaque = await sharp(onBlack, { raw: { width: transparent.width, height: transparent.height, channels: 3 } }).png().toBuffer();
  const fromPng = await analyseImage(read('transparent.png'));
  assert.deepEqual(fromPng, await analyseImage(opaque));
  assert.equal(fromPng.palette.seed, '#20C040');
});

test('the same picture always gives the same palette, and Math.random is left as it was', async () => {
  const random = Math.random;
  for (const file of ['figma_banner.jpg', 'grey_photo.png', 'logo_on_grey.png']) {
    const results = new Set();
    for (let run = 0; run < 8; run++) results.add(JSON.stringify(await analyseImage(read(file))));
    assert.equal(results.size, 1, file);
  }
  assert.equal(Math.random, random);
});

// ---------------------------------------------------------------------------
// Each rule on its own (raw pixels straight into computePalette, so each colour is its own cluster)

test('a colour family needs 5% of the picture: 50 of 1000 pixels is a candidate, 49 is not', async () => {
  const at5 = await computePalette(strip(['#808080', 950], ['#D02020', 50]));
  assert.equal(at5.neutral, false);
  assert.equal(at5.seed, '#D02020');
  const under5 = await computePalette(strip(['#808080', 951], ['#D02020', 49]));
  assert.equal(under5.neutral, true);
});

test('only clusters with chroma 16 or more are colourful', async () => {
  const above = colourNear(30, 16.5, 50, (h) => h.chroma >= 16.3 && h.chroma <= 16.7);
  const below = colourNear(30, 15.5, 50, (h) => h.chroma >= 15.3 && h.chroma <= 15.7);
  const vivid = await computePalette(strip(['#777777', 700], [above, 300]));
  assert.equal(vivid.neutral, false, `${above} (chroma ${hctOf(above).chroma}) is colourful`);
  assert.equal(vivid.seed, above);
  const dull = await computePalette(strip(['#777777', 700], [below, 300]));
  assert.equal(dull.neutral, true, `${below} (chroma ${hctOf(below).chroma}) is not`);
});

test('a family is the hues within 15 degrees either side, wrapping around 360', async () => {
  const at = (hue) => colourNear(hue, 40, 55, (h) => Math.round(h.hue) % 360 === hue && h.chroma >= 30);
  // Two colours on 3% each: one family of 6% when their rounded hues are 15 apart, two families of 3% at 16.
  const together = await computePalette(strip(['#808080', 940], [at(200), 30], [at(215), 30]));
  assert.equal(together.neutral, false);
  const apart = await computePalette(strip(['#808080', 940], [at(200), 30], [at(216), 30]));
  assert.equal(apart.neutral, true);
  const acrossZero = await computePalette(strip(['#808080', 940], [at(352), 30], [at(7), 30]));
  assert.equal(acrossZero.neutral, false);
});

test('the score weighs share and chroma as Material does', async () => {
  assert.ok(Math.abs(scoreOf(0.3, 20) - 18.2) < 1e-9);
  assert.ok(Math.abs(scoreOf(0.1, 90) - 19.6) < 1e-9);
  assert.ok(Math.abs(scoreOf(0.5, 48) - 35) < 1e-9);
  // A big muted colour beats a small vivid one, and a vivid one beats a slightly bigger muted one.
  const muted = colourNear(150, 20, 50, (h) => Math.abs(h.chroma - 20) < 0.5);
  const big = await computePalette(strip(['#808080', 300], [muted, 600], ['#FF0000', 100]));
  assert.equal(big.seed, muted);
  const small = await computePalette(strip(['#808080', 750], [muted, 150], ['#FF0000', 100]));
  assert.equal(small.seed, '#FF0000');
});

test('the score uses the family share: two shades of one hue together beat a bigger single colour', async () => {
  const blueA = colourNear(200, 40, 55, (h) => Math.round(h.hue) === 200 && Math.abs(h.chroma - 40) < 1);
  const blueB = colourNear(210, 40, 55, (h) => Math.round(h.hue) === 210 && Math.abs(h.chroma - 40) < 1);
  const orange = colourNear(30, 40, 55, (h) => Math.round(h.hue) === 30 && Math.abs(h.chroma - 40) < 1);
  // Blues: 20% + 20%, one family of 40% (score about 27); orange: 30% on its own (about 20).
  const result = await computePalette(strip(['#808080', 300], [blueA, 200], [blueB, 200], [orange, 300]));
  assert.ok([blueA, blueB].includes(result.seed), `${result.seed} should be one of the blues`);
});

test('the palette does not depend on Math.random (the k-means start is fixed)', async () => {
  // A colourful gradient with some noise, on which the library's own random start changes the seed.
  let state = 2;
  const next = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const [width, height] = [64, 43];
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / width;
      const rgb = [t, t - 0.33, t - 0.66].map((p) => 128 + 100 * Math.cos(6.283 * p) + (next() - 0.5) * 30);
      data.set(rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * width + x) * 3);
    }
  }
  const random = Math.random;
  const results = new Set();
  for (const value of [0, 0.5, 0.9999]) {
    Math.random = () => value;
    try {
      results.add(JSON.stringify(await computePalette({ data, width, height })));
    } finally {
      Math.random = random;
    }
  }
  assert.equal(results.size, 1, [...results].join(' / '));
});

test('ties go to the larger family share, then to the smaller ARGB value', () => {
  const a = { argb: 0xff102030, familyShare: 0.2, score: 30 };
  const b = { argb: 0xff000001, familyShare: 0.1, score: 30 };
  const c = { argb: 0xff000002, familyShare: 0.2, score: 30 };
  const d = { argb: 0xff000003, familyShare: 0.9, score: 29 };
  assert.equal(pickSeed([b, a]), a);
  assert.equal(pickSeed([a, b]), a);
  assert.equal(pickSeed([a, c]), c);
  assert.equal(pickSeed([c, a]), c);
  assert.equal(pickSeed([d, b, a, c]), c);
  assert.equal(pickSeed([]), null);
});

test('a neutral picture: the seed is the average colour and the accent a grey with at most chroma 6 of its hue', async () => {
  const halves = await computePalette(strip(['#404040', 500], ['#C0C0C0', 500]));
  assert.equal(halves.neutral, true);
  assert.equal(halves.seed, '#808080');
  const tinted = colourNear(250, 12, 60, (h) => h.chroma > 11 && h.chroma < 13);
  const result = await computePalette(strip([tinted, 1000]));
  assert.equal(result.neutral, true);
  assert.equal(result.seed, tinted);
  const accent = hctOf(result.accent);
  assert.ok(accent.chroma > 5 && accent.chroma < 7, `accent chroma ${accent.chroma}`);
  assert.ok(Math.abs(accent.hue - hctOf(tinted).hue) < 5);
});

test('the accent tone is capped where white text reads, and raised to the floor on a dark picture', async () => {
  const cap = m.Contrast.darker(100, 4.5);
  const light = await computePalette(strip(['#FF8A80', 1000]));
  assert.ok(Math.abs(hctOf(light.accent).tone - cap) < 0.6, `${light.accent} at the cap ${cap}`);
  assert.ok(contrast('#FFFFFF', light.accent) >= 4.5);
  const dark = await computePalette(strip(['#3A0A0A', 1000]));
  const floor = m.Contrast.lighter(hctOf(backdropOf('#3A0A0A')).tone, 3.0);
  assert.ok(Math.abs(hctOf(dark.accent).tone - floor) < 0.6, `${dark.accent} at the floor ${floor}`);
  const middle = await computePalette(strip(['#D02020', 1000]));
  assert.equal(middle.accent, '#D02020', 'a tone between the floor and the cap is kept');
});

// ---------------------------------------------------------------------------
// Sizes and the blur preview

test('the area filter averages exactly what each output pixel covers', () => {
  const row = { data: Buffer.from([0, 0, 0, 100, 100, 100, 200, 200, 200, 255, 255, 255]), width: 4, height: 1 };
  assert.deepEqual([...resizeArea(row, 2, 1).data], [50, 50, 50, 228, 228, 228]);
  const three = { data: Buffer.from([0, 0, 0, 90, 90, 90, 255, 255, 255]), width: 3, height: 1 };
  // Two outputs of 1.5 source pixels each: (0 + 0.5 * 90) / 1.5 and (0.5 * 90 + 255) / 1.5.
  assert.deepEqual([...resizeArea(three, 2, 1).data], [30, 30, 30, 200, 200, 200]);
  const column = { data: Buffer.from([10, 20, 30, 1, 2, 3, 30, 40, 50, 4, 5, 6]), width: 1, height: 2, channels: 6 };
  assert.deepEqual([...resizeArea(column, 1, 1).data], [20, 30, 40]);
});

test('the palette is worked out at 64 px on the longest side and the blur at 32 px wide', () => {
  assert.deepEqual(analysisSizes(786, 528), { palette: { width: 64, height: 43 }, blur: { width: 32, height: 21 } });
  assert.deepEqual(analysisSizes(1179, 792), { palette: { width: 64, height: 43 }, blur: { width: 32, height: 21 } });
  assert.deepEqual(analysisSizes(512, 512), { palette: { width: 64, height: 64 }, blur: { width: 32, height: 32 } });
});

test('the BlurHash has 4x3 components', () => {
  const hash = computeBlurhash(strip(['#D02020', 32]));
  assert.equal(hash.length, 28);
  // The first character encodes the components: (x - 1) + (y - 1) * 9.
  assert.equal('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.indexOf(hash[0]), 3 + 2 * 9);
});

test('computePalette refuses an empty picture', async () => {
  await assert.rejects(() => computePalette({ data: Buffer.alloc(0), width: 0, height: 0 }), /raw pixels/);
});
