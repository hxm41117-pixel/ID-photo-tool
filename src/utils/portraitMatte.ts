type RGB = [number, number, number];

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
  source: Uint8ClampedArray, out: Uint8ClampedArray, w: number, h: number, bg: RGB, strength: number
) {
  const reach = Math.ceil(w * 0.19);
  for (let y = Math.floor(h / 2); y < h; y++) {
    for (const dir of [-1, 1]) {
      const edge = dir === -1 ? 0 : w - 1;
      const edgeIndex = 4 * (y * w + edge);
      // Background at the frame means this row has a visible outer silhouette.
      // Leave that silhouette to the regular soft-matte solver.
      if (Math.max(Math.abs(source[edgeIndex] - bg[0]), Math.abs(source[edgeIndex+1] - bg[1]),
        Math.abs(source[edgeIndex+2] - bg[2])) < 80) continue;
      let anchor = -1;
      for (let x = edge - dir * Math.min(reach, w - 1); x !== edge + dir; x += dir) {
        const i = 4 * (y * w + x);
        if (source[i + 3] >= 245) anchor = i;
        if (anchor < 0) continue;
        const diff = Math.max(Math.abs(source[i] - source[anchor]), Math.abs(source[i+1] - source[anchor+1]),
          Math.abs(source[i+2] - source[anchor+2]));
        const contrast = Math.max(Math.abs(source[i] - bg[0]), Math.abs(source[i+1] - bg[1]),
          Math.abs(source[i+2] - bg[2]));
        if (diff > 60 || contrast < 80) {
          anchor = -1;
          continue;
        }
        const weight = Math.min(1, strength / 0.8) * Math.min(1, (contrast - 80) / 60, (60 - diff) / 20);
        // Recover only missing pixels. Leave real soft coverage to the matte.
        if (source[i + 3] <= 6 && out[i + 3] < solidAlpha) {
          out[i + 3] = Math.round(weight * 254);
        }
      }
    }
  }
}

const solidAlpha = 245;
const donorAlpha = 250;
const minimumDonorDepth = 3;
const transparentAlpha = 6;

// Return the exterior reachable through all non-solid pixels on any edge.
function floodExterior(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const exterior = new Uint8Array(width * height);
  const queue = new Int32Array(exterior.length);
  let head = 0;
  let tail = 0;

  function visit(pixel: number) {
    if (!exterior[pixel] && pixels[pixel * 4 + 3] < solidAlpha) {
      exterior[pixel] = 1;
      queue[tail++] = pixel;
    }
  }

  const bottom = (height - 1) * width;
  for (let x = 0; x < width; x++) {
    visit(x);
    visit(bottom + x);
  }
  for (let row = width; row < bottom; row += width) {
    visit(row);
    visit(row + width - 1);
  }

  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const left = x > 0 ? -1 : 0;
    const right = x + 1 < width ? 1 : 0;
    const top = pixel >= width ? -width : 0;
    const bottom = pixel + width < exterior.length ? width : 0;
    for (let row = top; row <= bottom; row += width) {
      for (let dx = left; dx <= right; dx++) visit(pixel + row + dx);
    }
  }
  return exterior;
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

// Search from the boundary toward the nearest opaque donor. Square rings
// bound the search, while the squared distance selects the closest donor.
function nearestForeground(
  source: Uint8ClampedArray, depth: Uint8Array, x: number, y: number,
  width: number, height: number, firstRing: number, maxRadius: number
): number {
  let nearest = -1;
  let best = maxRadius * maxRadius + 1;

  function consider(px: number, py: number) {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const candidate = py * width + px;
    if (depth[candidate] < minimumDonorDepth || source[candidate * 4 + 3] < donorAlpha) return;
    const squared = (px - x) ** 2 + (py - y) ** 2;
    if (squared < best) {
      best = squared;
      nearest = candidate;
    }
  }

  for (let ring = firstRing; ring <= maxRadius && ring * ring < best; ring++) {
    for (let offset = -ring; offset <= ring; offset++) {
      consider(x + offset, y - ring);
      consider(x + offset, y + ring);
    }
    for (let offset = 1 - ring; offset < ring; offset++) {
      consider(x - ring, y + offset);
      consider(x + ring, y + offset);
    }
  }
  return nearest;
}

// Sample the original backdrop in the direction opposite the foreground donor.
// For a studio backdrop the verified corner estimate is sufficient.
function sampleBackdrop(
  source: Uint8ClampedArray, exterior: Uint8Array, x: number, y: number,
  dx: number, dy: number, width: number, height: number, maxRadius: number
): RGB | null {
  for (let step = 1; step <= maxRadius; step++) {
    const px = Math.round(x + dx * step);
    const py = Math.round(y + dy * step);
    if (px < 0 || px >= width || py < 0 || py >= height) break;
    const p = py * width + px;
    const i = 4 * p;
    if (exterior[p] && source[i + 3] <= transparentAlpha) {
      return [source[i], source[i + 1], source[i + 2]];
    }
  }
  return null;
}

export function refinePortraitMatte(
  source: Uint8ClampedArray, width: number, height: number,
  fallbackBg: RGB, percent: number, hasSourceRgb = true
): Uint8ClampedArray {
  const out = source.slice();
  const strength = Math.max(0, Math.min(1, percent / 100));
  const exterior = floodExterior(source, width, height);

  for (let p = 0; p < exterior.length; p++) {
    const alphaIndex = p * 4 + 3;
    // A legacy cached cutout has no source color for zero-alpha pixels.
    if (!exterior[p] && (hasSourceRgb || source[alphaIndex] > 0)) out[alphaIndex] = 255;
  }
  if (!strength) return out;

  // Include the full soft contour on the outside and only the first solid
  // pixel on the inside. Look farther inward for uncontaminated RGB.
  const maxRadius = Math.max(8, Math.min(24, Math.ceil(Math.max(width, height) / 52)));
  const depth = exterior.map(value => value ? 0 : minimumDonorDepth);
  const distance = exterior.map(value => value ? maxRadius : 0);
  measureDistances(depth, width);
  measureDistances(distance, width);

  const flatBackdrop = hasSourceRgb && hasUniformBackdrop(source, width, height, fallbackBg);
  for (let p = 0; p < exterior.length; p++) {
    const i = p * 4;
    const alpha = source[i + 3];
    const isExterior = exterior[p] !== 0;
    if (isExterior && alpha <= transparentAlpha) {
      out[i + 3] = 0;
      continue;
    }
    if (isExterior ? distance[p] >= maxRadius : depth[p] !== 1) continue;

    const x = p % width;
    const y = Math.floor(p / width);
    const firstRing = isExterior ? distance[p] + minimumDonorDepth - 1 : minimumDonorDepth - 1;
    const donor = nearestForeground(source, depth, x, y, width, height, firstRing, maxRadius);
    if (donor < 0) continue;
    const dx = x - donor % width;
    const dy = y - Math.floor(donor / width);
    const length = Math.hypot(dx, dy);
    const outwardX = dx / length;
    const outwardY = dy / length;
    const bg = flatBackdrop || !hasSourceRgb ? fallbackBg
      : sampleBackdrop(source, exterior, x, y, outwardX, outwardY, width, height, maxRadius);
    if (!bg) continue;

    const f = donor * 4;
    const dr = source[f] - bg[0], dg = source[f + 1] - bg[1], db = source[f + 2] - bg[2];
    const contrast = dr * dr + dg * dg + db * db;
    if (contrast < 900) continue;
    const r = source[i] - bg[0], g = source[i + 1] - bg[1], b = source[i + 2] - bg[2];
    const coverage = Math.max(0, Math.min(1, (r * dr + g * dg + b * db) / contrast));
    const error = (r - coverage * dr) ** 2 + (g - coverage * dg) ** 2 + (b - coverage * db) ** 2;
    const colorConfidence = Math.max(0, 1 - error / 1600);
    const weight = Math.min(1, strength * 1.25) * colorConfidence;
    const colorWeight = weight * Math.min(1, (1 - coverage) / 0.15);
    for (let c = 0; c < 3; c++) {
      out[i + c] += colorWeight * (source[f + c] - source[i + c]);
    }

    if (isExterior) {
      // Pull the soft coverage inward by at most the outward one-pixel
      // gradient. The cap keeps fine, low-alpha hair from disappearing.
      const px = Math.min(width - 1, Math.max(0, Math.round(x + outwardX)));
      const py = Math.min(height - 1, Math.max(0, Math.round(y + outwardY)));
      const falloff = Math.max(0, alpha - source[4 * (py * width + px) + 3]);
      const modeledAlpha = Math.min(alpha, coverage * 255);
      const tighten = Math.min(falloff, modeledAlpha * 0.15);
      const refined = alpha + weight * (modeledAlpha - tighten - alpha);
      out[i + 3] = refined <= transparentAlpha ? 0 : refined;
    }
  }

  if (flatBackdrop) restoreCroppedGarment(source, out, width, height, fallbackBg, strength);
  return out;
}
