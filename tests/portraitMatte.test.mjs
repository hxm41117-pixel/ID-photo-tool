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

test('repair a hole inside skin and preserve a gap showing the old background', () => {
  const raw = portrait();
  raw.set([...skin, 0], index(44, 28));
  raw.set([...white, 0], index(44, 42));
  const out = refinePortraitMatte(raw, size, size, white, 80);
  assert.equal(out[index(44, 28) + 3], 255);
  assert.equal(out[index(44, 42) + 3], 0);
  assert.equal(raw[index(44, 28) + 3], 0);
});

test('recover a mixed boundary on white, blue and red without eroding it', () => {
  for (const bg of [white, [49, 83, 147], [186, 43, 61]]) {
    const raw = portrait(bg);
    for (let y = 0; y < size; y++) {
      raw.set([...skin.map((v, i) => 0.3 * v + 0.7 * bg[i]), 105], index(32, y));
    }
    const out = refinePortraitMatte(raw, size, size, bg, 100);
    const pixel = out.subarray(index(32, 31), index(32, 31) + 4);
    assert.ok(Math.abs(pixel[3] - 76.5) < 3);
    skin.forEach((v, i) => assert.ok(Math.abs(pixel[i] - v) < 4));
  }
});

test('zero strength preserves the mask and legacy transparent pixels stay transparent', () => {
  const raw = portrait();
  raw.set([0, 0, 0, 0], index(40, 40));
  assert.deepEqual(refinePortraitMatte(raw, size, size, white, 0), raw);
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
