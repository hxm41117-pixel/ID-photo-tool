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
  // outside the four-pixel contour band and keep its original color.
  raw.set([202, 205, 215, 36], index(12, 12));
  const out = refinePortraitMatte(raw, size, size, white, 100);
  assert.equal(out[index(43, 39) + 3], 0);
  assert.deepEqual(out.subarray(index(12, 12), index(12, 12) + 4),
    raw.subarray(index(12, 12), index(12, 12) + 4));
});

test('only alpha below 30 starts a bottom-edge region', () => {
  const raw = portrait();
  const sleeve = index(40, size - 1);
  const gap = index(53, size - 1);
  raw.set([22, 25, 30, 30], sleeve);
  raw.set([...white, 29], gap);
  raw.set([...white, 90], gap - 4 * size);
  const out = refinePortraitMatte(raw, size, size, white, 0);
  assert.deepEqual([...out.subarray(sleeve, sleeve + 4)], [22, 25, 30, 255]);
  assert.equal(out[gap + 3], 29);
  assert.equal(out[gap - 4 * size + 3], 90);
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
  assert.equal(out[left + 3], 255);
  assert.equal(out[right + 3], 255);
  assert.equal(out[3], 0);
  for (let i = 0; i < 4 * 60 * w; i += 4) raw.set([90, 60, 110, 0], i);
  assert.equal(refinePortraitMatte(raw, w, h, white, 80)[left + 3], 0);
});

test('decontaminate a high-alpha white rim without changing the adjacent solid hair', () => {
  const raw = portrait();
  const fringe = index(32, 31);
  const dark = [35, 30, 26];
  for (let y = 0; y < size; y++) {
    for (let x = 33; x < size; x++) raw.set([...dark, 255], index(x, y));
    raw.set([195, 194, 193, 215], index(32, y));
  }
  const out = refinePortraitMatte(raw, size, size, white, 100);
  assert.ok(out[fringe + 3] < 128);
  assert.ok(out[fringe] < 55);
  assert.deepEqual([...out.subarray(fringe + 4, fringe + 8)], [...dark, 255]);
});
