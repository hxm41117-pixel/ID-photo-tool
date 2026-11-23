type RGB = [number, number, number];
const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];

function matchesBackdrop(pixels: Uint8ClampedArray, i: number, bg: RGB, tolerance: number) {
  return Math.max(
    Math.abs(pixels[i] - bg[0]),
    Math.abs(pixels[i + 1] - bg[1]),
    Math.abs(pixels[i + 2] - bg[2])
  ) < tolerance;
}

function hasUniformBackdrop(pixels: Uint8ClampedArray, w: number, h: number, bg: RGB) {
  let samples = 0;
  let matches = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = 4 * (y * w + x);
      if (pixels[i + 3] > 8) continue;
      samples++;
      if (matchesBackdrop(pixels, i, bg, 18)) matches++;
    }
  }
  return samples >= 24 && matches >= samples * 0.85;
}

// A tight crop can put a solid garment against the frame edge, where the
// network sometimes predicts background. Follow uninterrupted garment color
// outward from the body only when the inferred backdrop is demonstrably flat.
function restoreCroppedGarment(
  pixels: Uint8ClampedArray, w: number, h: number, bg: RGB, strength: number
) {
  const reach = Math.ceil(w * 0.19);
  for (let y = Math.floor(h / 2); y < h; y++) {
    for (const dir of [-1, 1]) {
      const edge = dir === -1 ? 0 : w - 1;
      const edgeIndex = 4 * (y * w + edge);
      // Background at the frame means this row has a visible outer silhouette.
      // Leave that silhouette to the regular soft-matte solver.
      if (Math.max(Math.abs(pixels[edgeIndex] - bg[0]), Math.abs(pixels[edgeIndex+1] - bg[1]),
        Math.abs(pixels[edgeIndex+2] - bg[2])) < 80) continue;
      let anchor = -1;
      for (let x = edge - dir * Math.min(reach, w - 1); x !== edge + dir; x += dir) {
        const i = 4 * (y * w + x);
        if (pixels[i + 3] >= 245) anchor = i;
        if (anchor < 0) continue;
        const diff = Math.max(Math.abs(pixels[i] - pixels[anchor]), Math.abs(pixels[i+1] - pixels[anchor+1]),
          Math.abs(pixels[i+2] - pixels[anchor+2]));
        const contrast = Math.max(Math.abs(pixels[i] - bg[0]), Math.abs(pixels[i+1] - bg[1]),
          Math.abs(pixels[i+2] - bg[2]));
        if (diff > 60 || contrast < 80) {
          anchor = -1;
          continue;
        }
        const weight = Math.min(1, strength / 0.8) * Math.min(1, (contrast - 80) / 60, (60 - diff) / 20);
        pixels[i + 3] += weight * (255 - pixels[i + 3]);
      }
    }
  }
}

const solidAlpha = 128;
const bottomSeedAlpha = 30;
const edgeBandWidth = 4;

// 0 denotes the enclosed foreground. Exterior pixels are labeled with their
// distance from it, capped at edgeBandWidth + 1 (outside the refinement band).
function floodExterior(
  pixels: Uint8ClampedArray, original: Uint8ClampedArray, width: number, height: number
): Uint8Array {
  const outsideBand = edgeBandWidth + 1;
  const distance = new Uint8Array(width * height);
  const queue = new Int32Array(distance.length);
  let head = 0;
  let tail = 0;

  function visit(pixel: number, limit = solidAlpha) {
    if (distance[pixel] === 0 && pixels[pixel * 4 + 3] < limit) {
      distance[pixel] = outsideBand;
      queue[tail++] = pixel;
    }
  }

  function seed(pixel: number, limit = solidAlpha) {
    if (original[pixel * 4 + 3] < limit) visit(pixel, limit);
  }

  const bottom = (height - 1) * width;
  for (let x = 0; x < width; x++) {
    seed(x);
    seed(bottom + x, bottomSeedAlpha);
  }
  for (let row = width; row < bottom; row += width) {
    seed(row);
    seed(row + width - 1);
  }

  // Use eight neighbors so even a diagonal opening can keep a gap transparent.
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const left = x > 0 ? -1 : 0;
    const right = x + 1 < width ? 1 : 0;
    const top = pixel >= width ? -width : 0;
    const bottom = pixel + width < distance.length ? width : 0;
    for (let row = top; row <= bottom; row += width) {
      for (let dx = left; dx <= right; dx++) visit(pixel + row + dx);
    }
  }

  return distance;
}

// Two raster passes compute the distance to the silhouette in pixel units.
function measureDistances(distance: Uint8Array, width: number) {
  for (let pixel = 0; pixel < distance.length; pixel++) {
    if (distance[pixel] === 0) continue;
    const x = pixel % width;
    if (x > 0) distance[pixel] = Math.min(distance[pixel], distance[pixel - 1] + 1);
    if (pixel < width) continue;
    const above = pixel - width;
    distance[pixel] = Math.min(distance[pixel], distance[above] + 1);
    if (x > 0) distance[pixel] = Math.min(distance[pixel], distance[above - 1] + 1);
    if (x + 1 < width) distance[pixel] = Math.min(distance[pixel], distance[above + 1] + 1);
  }
  for (let pixel = distance.length - 1; pixel >= 0; pixel--) {
    if (distance[pixel] === 0) continue;
    const x = pixel % width;
    if (x + 1 < width) distance[pixel] = Math.min(distance[pixel], distance[pixel + 1] + 1);
    const below = pixel + width;
    if (below >= distance.length) continue;
    distance[pixel] = Math.min(distance[pixel], distance[below] + 1);
    if (x > 0) distance[pixel] = Math.min(distance[pixel], distance[below - 1] + 1);
    if (x + 1 < width) distance[pixel] = Math.min(distance[pixel], distance[below + 1] + 1);
  }
}

// The surrounding opaque portrait and old background must support the same
// color mixture before replacing a pixel's coverage or RGB.
function estimateBoundary(
  source: Uint8ClampedArray, exterior: Uint8Array, pixel: number, width: number, height: number,
  fallbackBg: RGB, hasSourceRgb: boolean, sampleDistances: number[]
) {
  const i = pixel * 4;
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  const r = source[i], g = source[i + 1], b = source[i + 2];
  let best = 0;
  let coverage = 0;
  let donor = -1;
  let outwardStep = 0;
  let outwardStepLength = 1;
  let bgR = 0, bgG = 0, bgB = 0;

  for (const sampleDistance of sampleDistances) {
    for (const [dx, dy] of directions) {
      const sx = dx * sampleDistance;
      const sy = dy * sampleDistance;
      if (x - sx < 0 || x + sx >= width || y - Math.abs(sy) < 0 || y + Math.abs(sy) >= height) continue;
      const step = dx + dy * width;
      const offset = step * sampleDistance;
      const reverse = exterior[pixel + offset] !== 0;
      const f = pixel + (reverse ? -offset : offset);
      const k = pixel + (reverse ? offset : -offset);
      if (exterior[f] !== 0 || source[f * 4 + 3] < 249) continue;
      if (exterior[k] === 0 || source[k * 4 + 3] > 8) continue;

      const br = hasSourceRgb ? source[k * 4] : fallbackBg[0];
      const bg = hasSourceRgb ? source[k * 4 + 1] : fallbackBg[1];
      const bb = hasSourceRgb ? source[k * 4 + 2] : fallbackBg[2];
      const dr = source[f * 4] - br;
      const dg = source[f * 4 + 1] - bg;
      const db = source[f * 4 + 2] - bb;
      const contrast = dr * dr + dg * dg + db * db;
      if (contrast < 900) continue;
      // Solve C = alpha F + (1-alpha) B along the local color line.
      const t = Math.max(0, Math.min(1, ((r - br) * dr + (g - bg) * dg + (b - bb) * db) / contrast));
      const error = (r - br - t * dr) ** 2 + (g - bg - t * dg) ** 2 + (b - bb - t * db) ** 2;
      const confidence = Math.max(0, 1 - error / 576) * Math.min(1, contrast / 3600);
      if (confidence <= best) continue;
      best = confidence;
      coverage = t;
      donor = f * 4;
      outwardStep = reverse ? step : -step;
      outwardStepLength = dy === 0 || dx === 0 ? 1 : Math.SQRT2;
      bgR = br;
      bgG = bg;
      bgB = bb;
    }
  }
  if (donor < 0) return null;
  return { best, coverage, donor, bgR, bgG, bgB, outwardStep, outwardStepLength };
}

// Refine the model's soft mask against the full-resolution source. The RGB
// channels contain the photographed composite, not straight foreground RGB.
export function refinePortraitMatte(
  source: Uint8ClampedArray, width: number, height: number,
  fallbackBg: RGB, percent: number, hasSourceRgb = true
): Uint8ClampedArray {
  const out = source.slice();
  const strength = Math.max(0, Math.min(1, percent / 100));
  // Repair cropped sleeves before classifying the exterior so these pixels
  // participate in the contour and can't be made transparent again.
  if (strength > 0) {
    const uniformBackdrop = hasSourceRgb && hasUniformBackdrop(source, width, height, fallbackBg);
    if (uniformBackdrop) restoreCroppedGarment(out, width, height, fallbackBg, strength);
    for (let i = 0; i < out.length; i += 4) {
      const alpha = out[i + 3];
      // Remove weak background noise before the fill. RGB is kept in case the
      // flood finds that the pixel actually belongs to an enclosed hole.
      if (alpha <= 6 || (uniformBackdrop && alpha < solidAlpha && matchesBackdrop(source, i, fallbackBg, 12))) {
        out[i + 3] = 0;
      }
    }
  }
  const radius = Math.max(3, Math.min(16, Math.round(Math.max(width, height) / 160)));
  const sampleDistances = [radius, radius * 3];
  let distance = floodExterior(out, source, width, height);

  if (hasSourceRgb && strength > 0) {
    // A confidently predicted halo can sit just inside the raw silhouette.
    // Reclassify only the thin rim where the old backdrop accounts for a
    // substantial part of the pixel color, then flood again before locking.
    const inward = distance.map(value => value === 0 ? edgeBandWidth + 1 : 0);
    measureDistances(inward, width);
    let rimChanged = false;
    for (let pixel = 0; pixel < inward.length; pixel++) {
      const i = 4 * pixel + 3;
      if (inward[pixel] === 0 || inward[pixel] > edgeBandWidth || out[i] < solidAlpha) continue;
      const match = estimateBoundary(source, distance, pixel, width, height, fallbackBg, true, sampleDistances);
      if (match && match.best >= 0.75 && match.coverage < 0.72) {
        out[i] = Math.min(solidAlpha - 1, Math.round(match.coverage * 255));
        rimChanged = true;
      }
    }
    if (rimChanged) distance = floodExterior(out, source, width, height);
  }

  if (strength > 0) measureDistances(distance, width);
  for (let pixel = 0; pixel < distance.length; pixel++) {
    const i = pixel * 4;
    const alpha = source[i + 3];
    if (distance[pixel] === 0) {
      // Legacy transparent PNGs have lost the RGB of fully transparent pixels.
      if (hasSourceRgb || alpha > 0) out[i + 3] = 255;
      continue;
    }
    if (!strength) continue;
    if (distance[pixel] > edgeBandWidth || (!hasSourceRgb && alpha === 0)) continue;

    const match = estimateBoundary(source, distance, pixel, width, height, fallbackBg, hasSourceRgb, sampleDistances);
    if (!match) continue;
    const { best, coverage, donor, bgR, bgG, bgB, outwardStep, outwardStepLength } = match;
    const weight = best * strength;
    // Shift the soft edge inward by up to 1.25 px along the local gradient.
    // Bound the alpha loss to retain faint strands, even on a steep edge.
    const falloff = Math.max(0, alpha - source[(pixel + outwardStep) * 4 + 3]) / 255;
    const erosion = Math.min(coverage * 0.2, 1.25 * falloff / outwardStepLength) * (1 - coverage);
    out[i + 3] += weight * (255 * (coverage - erosion) - out[i + 3]);

    const rgbWeight = Math.min(1, weight * 1.2);
    const denom = Math.max(0.12, coverage);
    for (let c = 0; c < 3; c++) {
      const bg = c === 0 ? bgR : c === 1 ? bgG : bgB;
      const fg = (source[i + c] - (1 - coverage) * bg + (denom - coverage) * source[donor + c]) / denom;
      out[i + c] += rgbWeight * (Math.max(0, Math.min(255, fg)) - source[i + c]);
    }
  }
  return out;
}
