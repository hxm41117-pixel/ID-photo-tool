type RGB = [number, number, number];
const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];

// A tight crop can put a solid garment against the frame edge, where the
// network sometimes predicts background. Follow uninterrupted garment color
// outward from the body only when the inferred backdrop is demonstrably flat.
function restoreCroppedGarment(
  src: Uint8ClampedArray, out: Uint8ClampedArray, w: number, h: number,
  bg: RGB, strength: number
) {
  let samples = 0, matches = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = 4 * (y * w + x);
      if (src[i + 3] > 8) continue;
      samples++;
      if (Math.max(Math.abs(src[i] - bg[0]), Math.abs(src[i+1] - bg[1]),
        Math.abs(src[i+2] - bg[2])) < 18) matches++;
    }
  }
  if (samples < 24 || matches < samples * 0.85) return;

  const reach = Math.ceil(w * 0.19);
  for (let y = Math.floor(h / 2); y < h; y++) {
    for (const dir of [-1, 1]) {
      const edge = dir === -1 ? 0 : w - 1;
      const edgeIndex = 4 * (y * w + edge);
      // Background at the frame means this row has a visible outer silhouette.
      // Leave that silhouette to the regular soft-matte solver.
      if (Math.max(Math.abs(src[edgeIndex] - bg[0]), Math.abs(src[edgeIndex+1] - bg[1]),
        Math.abs(src[edgeIndex+2] - bg[2])) < 80) continue;
      let anchor = -1;
      for (let x = edge - dir * Math.min(reach, w - 1); x !== edge + dir; x += dir) {
        const i = 4 * (y * w + x);
        if (src[i + 3] >= 245) anchor = i;
        if (anchor < 0) continue;
        const diff = Math.max(Math.abs(src[i] - src[anchor]), Math.abs(src[i+1] - src[anchor+1]),
          Math.abs(src[i+2] - src[anchor+2]));
        const contrast = Math.max(Math.abs(src[i] - bg[0]), Math.abs(src[i+1] - bg[1]),
          Math.abs(src[i+2] - bg[2]));
        if (diff > 60 || contrast < 80) {
          anchor = -1;
          continue;
        }
        const weight = Math.min(1, strength / 0.8) * Math.min(1, (contrast - 80) / 60, (60 - diff) / 20);
        for (let c = 0; c < 3; c++) out[i+c] += weight * (src[i+c] - out[i+c]);
        out[i+3] += weight * (255 - out[i+3]);
      }
    }
  }
}

// Refine the model's soft mask against the full-resolution source. The RGB
// channels contain the photographed composite, not straight foreground RGB.
export function refinePortraitMatte(
  source: Uint8ClampedArray, width: number, height: number,
  fallbackBg: RGB, percent: number, hasSourceRgb = true
): Uint8ClampedArray {
  const out = source.slice();
  const strength = Math.max(0, Math.min(1, percent / 100));
  if (!strength) return out;

  const radius = Math.max(3, Math.min(16, Math.round(Math.max(width, height) / 160)));
  const search = radius * 3;
  const distances = [radius, search];
  const tile = 32;
  for (let top = 0; top < height; top += tile) {
    for (let left = 0; left < width; left += tile) {
      const right = Math.min(width, left + tile), bottom = Math.min(height, top + tile);
      let low = 255, high = 0;
      for (let y = Math.max(0, top - search); y < Math.min(height, bottom + search); y++) {
        const end = (y * width + Math.min(width, right + search)) * 4;
        for (let i = (y * width + Math.max(0, left - search)) * 4 + 3; i < end; i += 4) {
          low = Math.min(low, source[i]);
          high = Math.max(high, source[i]);
        }
      }
      if (low >= 249 || high <= 6) {
        const endpoint = low >= 249 ? 255 : 0;
        for (let y = top; y < bottom; y++) {
          for (let i = (y * width + left) * 4 + 3; i < (y * width + right) * 4; i += 4) {
            out[i] += (endpoint - out[i]) * strength;
          }
        }
        continue;
      }
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const i = (y * width + x) * 4;
          const a = source[i + 3] / 255;
          if (!hasSourceRgb && !a) continue;
          const r = source[i], g = source[i + 1], b = source[i + 2];
          let best = 0, coverage = a, donor = -1;
          let bgR = 0, bgG = 0, bgB = 0;
          let matchingInterior = 0;

          for (const distance of distances) {
            for (const [dx, dy] of directions) {
              const sx = dx * distance, sy = dy * distance;
              if (x - sx < 0 || x + sx >= width || y - Math.abs(sy) < 0 || y + Math.abs(sy) >= height) continue;
              const offset = (sx + sy * width) * 4;
              let f = i + offset, k = i - offset;
              if (source[f + 3] < source[k + 3]) [f, k] = [k, f];
              if (source[f + 3] < 249) continue;
              if (source[k + 3] > 248) {
                // A small interior mask hole is safe to fill only when the
                // photographed color agrees with opaque pixels on both sides.
                if (Math.max(
                  Math.abs(r - source[f]), Math.abs(g - source[f + 1]), Math.abs(b - source[f + 2]),
                  Math.abs(r - source[k]), Math.abs(g - source[k + 1]), Math.abs(b - source[k + 2])
                ) < 24 && distance === radius) matchingInterior++;
                continue;
              }
              if (source[k + 3] > 8) continue;
              const br = hasSourceRgb ? source[k] : fallbackBg[0];
              const bg = hasSourceRgb ? source[k + 1] : fallbackBg[1];
              const bb = hasSourceRgb ? source[k + 2] : fallbackBg[2];
              const dr = source[f] - br, dg = source[f + 1] - bg, db = source[f + 2] - bb;
              const contrast = dr * dr + dg * dg + db * db;
              if (contrast < 900) continue;
              // Solve C = alpha F + (1-alpha) B along the local color line.
              const t = Math.max(0, Math.min(1, ((r - br) * dr + (g - bg) * dg + (b - bb) * db) / contrast));
              const error = (r - br - t * dr) ** 2 + (g - bg - t * dg) ** 2 + (b - bb - t * db) ** 2;
              const confidence = Math.max(0, 1 - error / 576) * Math.min(1, contrast / 3600);
              if (confidence > best) {
                best = confidence;
                coverage = t;
                donor = f;
                bgR = br;
                bgG = bg;
                bgB = bb;
              }
            }
          }
          if (matchingInterior >= 3 && donor < 0) {
            out[i + 3] += (255 - out[i + 3]) * Math.min(1, strength / 0.8);
          } else if (donor >= 0) {
            const weight = best * strength;
            const alpha = a + weight * (coverage - a);
            out[i + 3] = Math.round(255 * alpha);
            // Recover straight RGB before Canvas composites onto the new
            // backdrop. Regularize faint strands with the local foreground.
            const denom = Math.max(0.12, coverage);
            for (let c = 0; c < 3; c++) {
              const bg = c === 0 ? bgR : c === 1 ? bgG : bgB;
              const fg = (source[i + c] - (1 - coverage) * bg + (denom - coverage) * source[donor + c]) / denom;
              out[i + c] += weight * (Math.max(0, Math.min(255, fg)) - source[i + c]);
            }
          }
        }
      }
    }
  }
  if (hasSourceRgb) restoreCroppedGarment(source, out, width, height, fallbackBg, strength);
  return out;
}
