import assert from 'node:assert/strict';
import test from 'node:test';
import { refinePortraitMatte } from '../src/utils/portraitMatte.ts';

const size = 64;
const white = [250, 250, 250];
const skin = [185, 143, 117];
const index = (x, y) => 4 * (y * size + x);
function portrait(bg = white) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      pixels.set(x < 32 ? [...bg, 0] : [...skin, 255], index(x, y));
    }
  }
  return pixels;
}

test('fill enclosed shirt and sweater holes without changing their RGB', () => {
  const raw = portrait();
  const collar = index(37, 29);
  const sweater = index(46, 42);
  raw.set([...white, 0], collar);
  raw.set([22, 25, 30, 91], sweater);
  const out = refinePortraitMatte(raw, size, size, white, 100);
  assert.deepEqual([...out.subarray(collar, collar + 4)], [...white, 255]);
  assert.deepEqual([...out.subarray(sweater, sweater + 4)], [22, 25, 30, 255]);
  assert.equal(raw[collar + 3], 0);
});

test('keep a gap connected to the left border open, including a diagonal opening', () => {
  const raw = portrait();
  for (let n = 0; n < 12; n++) raw.set([...white, 0], index(32 + n, 28 + n));
  // Detail surrounded by weak pixels in a background region must stay
  // outside the contour band and keep its original color.
  raw.set([202, 205, 215, 36], index(12, 12));
  const out = refinePortraitMatte(raw, size, size, white, 100);
  assert.equal(out[index(43, 39) + 3], 0);
  assert.deepEqual(out.subarray(index(12, 12), index(12, 12) + 4),
    raw.subarray(index(12, 12), index(12, 12) + 4));
});

test('all four borders seed at alpha below 245 and preserve the exterior gradient', () => {
  const raw = new Uint8ClampedArray(size * size * 4).fill(255);
  const edgePaths = [
    [[30, 0], [30, 1], [31, 2]],
    [[0, 20], [1, 20], [2, 21]],
    [[63, 20], [62, 20], [61, 21]],
    [[40, 63], [40, 62], [41, 61]],
  ];
  for (const path of edgePaths) {
    path.forEach(([x, y], n) => { raw[index(x, y) + 3] = [244, 210, 128][n]; });
  }
  const sealed = index(38, 62);
  raw[sealed + 3] = 90;
  raw[index(38, 63) + 3] = 245;
  const out = refinePortraitMatte(raw, size, size, white, 0);
  for (const path of edgePaths) {
    for (const [x, y] of path) assert.equal(out[index(x, y) + 3], raw[index(x, y) + 3]);
  }
  assert.equal(out[sealed + 3], 255);
  assert.equal(out[index(38, 63) + 3], 255);
});

test('recover a mixed boundary on white, blue and red with bounded erosion', () => {
  for (const bg of [white, [49, 83, 147], [186, 43, 61]]) {
    const raw = portrait(bg);
    for (let y = 0; y < size; y++) {
      raw.set([...skin.map((v, i) => 0.3 * v + 0.7 * bg[i]), 105], index(32, y));
    }
    const out = refinePortraitMatte(raw, size, size, bg, 100);
    const pixel = out.subarray(index(32, 31), index(32, 31) + 4);
    assert.ok(pixel[3] >= 63 && pixel[3] < 76);
    skin.forEach((v, i) => assert.ok(Math.abs(pixel[i] - v) < 4));
  }
});

test('zero strength still fills holes and legacy transparent pixels stay transparent', () => {
  const raw = portrait();
  raw.set([0, 0, 0, 0], index(40, 40));
  assert.equal(refinePortraitMatte(raw, size, size, white, 0)[index(40, 40) + 3], 255);
  assert.equal(refinePortraitMatte(raw, size, size, white, 100, false)[index(40, 40) + 3], 0);
});

test('recover cropped dark sleeves at both frame edges only with a uniform backdrop', () => {
  const w = 128, h = 128;
  const raw = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      raw.set(y < 80 ? [...white, 0] : [28, 29, 35, x >= 12 && x < 116 ? 255 : 0], i);
    }
  }
  const left = 4 * (100 * w), right = left + 4 * (w - 1);
  const out = refinePortraitMatte(raw, w, h, white, 80);
  assert.equal(out[left + 3], 254);
  assert.equal(out[right + 3], 254);
  assert.equal(out[3], 0);
  for (let i = 0; i < 4 * 60 * w; i += 4) raw.set([90, 60, 110, 0], i);
  assert.equal(refinePortraitMatte(raw, w, h, white, 80)[left + 3], 0);
});

test('bleed the nearest clean foreground onto the soft rim and the first solid pixel', () => {
  const raw = portrait();
  const dark = [35, 30, 26];
  for (let y = 0; y < size; y++) {
    raw.set([243, 243, 243, 5], index(30, y));
    raw.set([217, 216, 215, 150], index(31, y));
    raw.set([195, 194, 193, 244], index(32, y));
    raw.set([100, 97, 93, 249], index(33, y));
    raw.set([70, 68, 66, 253], index(34, y));
    raw.set([...dark, 250], index(35, y));
    for (let x = 36; x < size; x++) raw.set([75, 67, 62, 255], index(x, y));
  }
  const out = refinePortraitMatte(raw, size, size, white, 100);
  const alpha = [30, 31, 32, 33].map(x => out[index(x, 31) + 3]);
  assert.equal(alpha[0], 0);
  assert.ok(0 < alpha[1] && alpha[1] < alpha[2] && alpha[2] < 244);
  assert.equal(alpha[3], 255);
  for (const x of [31, 32, 33]) {
    const i = index(x, 31);
    dark.forEach((value, c) => assert.ok(Math.abs(out[i + c] - value) < 3));
  }
  assert.deepEqual([...out.subarray(index(34, 31), index(34, 31) + 4)], [70, 68, 66, 255]);
});
