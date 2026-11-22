import { canvasToBlob } from './compression';

export interface AiProgressInfo {
  percent: number;
  stageLabel: string;
}

export interface ForegroundCutoutResult {
  /**
   * Unmodified raw transparent cutout ImageData.
   * Stored immutably so dragging the Defringe slider or switching background colors
   * always re-runs `cleanEdgeSpill` from a clean source without cumulative mutation.
   */
  rawCutoutImageData: ImageData;
  /** Final Transparent Foreground Canvas after `cleanEdgeSpill` */
  foregroundCanvas: HTMLCanvasElement;
  /** Sampled average background RGB from the original photo corners */
  sampledBgRgb: [number, number, number];
  blob: Blob;
}

/**
 * Helper to identify human skin tone pixels so global gap removal and 18px hair
 * spill decontamination never accidentally alter face, ears, neck, or lips.
 */
function isSkinTonePixel(r: number, g: number, b: number): boolean {
  return (
    r > 85 &&
    g > 38 &&
    b > 20 &&
    r > g &&
    g > b &&
    r - b > 15 &&
    r - g > 8
  );
}

/**
 * Automatically samples the four corners of the uploaded original image
 * to compute the average original background color `(bgR, bgG, bgB)`.
 */
export function sampleDominantBackgroundRgb(
  source: HTMLImageElement | HTMLCanvasElement | ImageData
): [number, number, number] {
  let data: Uint8ClampedArray;
  let sw: number;
  let sh: number;

  if (source instanceof ImageData) {
    data = source.data;
    sw = source.width;
    sh = source.height;
  } else {
    const w =
      source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
    const h =
      source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;
    const sampleCanvas = document.createElement('canvas');
    sw = Math.min(360, Math.max(32, w));
    sh = Math.min(360, Math.max(32, h));
    sampleCanvas.width = sw;
    sampleCanvas.height = sh;
    const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [67, 142, 219];
    ctx.clearRect(0, 0, sw, sh);
    ctx.drawImage(source, 0, 0, sw, sh);
    data = ctx.getImageData(0, 0, sw, sh).data;
  }

  const collectPatchMean = (startX: number, startY: number, patchSize: number) => {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let count = 0;
    for (let dy = 0; dy < patchSize; dy++) {
      const y = Math.max(0, Math.min(sh - 1, startY + dy));
      for (let dx = 0; dx < patchSize; dx++) {
        const x = Math.max(0, Math.min(sw - 1, startX + dx));
        const idx = (y * sw + x) * 4;
        if (data[idx + 3] >= 32) {
          rSum += data[idx];
          gSum += data[idx + 1];
          bSum += data[idx + 2];
          count++;
        }
      }
    }
    return count > 0
      ? ([rSum / count, gSum / count, bSum / count] as [number, number, number])
      : null;
  };

  const patch = Math.max(4, Math.min(14, Math.floor(Math.min(sw, sh) * 0.04)));
  const topLeft = collectPatchMean(2, 2, patch);
  const topRight = collectPatchMean(sw - patch - 2, 2, patch);
  const bottomLeft = collectPatchMean(2, sh - patch - 2, patch);
  const bottomRight = collectPatchMean(sw - patch - 2, sh - patch - 2, patch);

  const validPatches: Array<[number, number, number]> = [];
  if (topLeft) validPatches.push(topLeft);
  if (topRight) validPatches.push(topRight);

  const ref = topLeft || topRight;
  if (ref) {
    for (const bottom of [bottomLeft, bottomRight]) {
      if (bottom) {
        const dist = Math.hypot(
          bottom[0] - ref[0],
          bottom[1] - ref[1],
          bottom[2] - ref[2]
        );
        if (dist < 75) {
          validPatches.push(bottom);
        }
      }
    }
  } else {
    if (bottomLeft) validPatches.push(bottomLeft);
    if (bottomRight) validPatches.push(bottomRight);
  }

  if (validPatches.length > 0) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const p of validPatches) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    return [
      Math.round(r / validPatches.length),
      Math.round(g / validPatches.length),
      Math.round(b / validPatches.length),
    ];
  }

  // Fallback for cached transparent PNGs where corners have alpha = 0
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 16) {
    const a = data[i + 3];
    if (a > 5 && a < 120) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }
  }
  if (count > 0) {
    return [Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count)];
  }

  return [67, 142, 219];
}

/**
 * Wide-Band 18px Deep Hair Spill Removal + Outer Edge Micro-Contraction (`cleanEdgeSpill`).
 *
 * Always clones `rawCutoutImageData` without mutating the source, returning a brand-new
 * Transparent Foreground Canvas (`HTMLCanvasElement`).
 *
 * 1. Expands contour detection to `18px` from ANY transparent pixel (covering both the outer
 *    portrait silhouette and enclosed gaps between hair strands & shoulders).
 * 2. Detects dominant original background hue (e.g. blue `bgB > bgR + 20 && bgB > bgG + 20`,
 *    red `bgR > bgG + 20 && bgR > bgB + 20`).
 * 3. Outer micro-contraction smoothly eats away outermost 1px~1.8px fringe burrs.
 * 4. Inside the 18px protection band, for dark & non-skin pixels (`luma < 130` and not skin tone
 *    `r > g && g > b`), whenever background channel spill is detected (e.g. `b > max(r, g)`),
 *    force-clamps the excess blue channel down to `Math.min(r, g)` according to `strength` (default 80%),
 *    eliminating deep blue reflections inside hair near the shoulders and restoring natural dark hair.
 */
export function cleanEdgeSpill(
  rawCutoutImageData: ImageData,
  bgRgb: [number, number, number],
  strengthPercent = 80
): HTMLCanvasElement {
  const width = rawCutoutImageData.width;
  const height = rawCutoutImageData.height;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const ctx = outCanvas.getContext('2d');
  if (!ctx) return outCanvas;

  // Clone rawCutoutImageData so the original buffer is NEVER modified
  const clonedData = new Uint8ClampedArray(rawCutoutImageData.data);
  const outImageData = new ImageData(clonedData, width, height);

  const clampedPct = Math.max(0, Math.min(100, strengthPercent));
  if (clampedPct === 0) {
    ctx.putImageData(outImageData, 0, 0);
    return outCanvas;
  }

  const strength = clampedPct / 100; // 0.0 .. 1.0 (default 0.8)
  const [bgR, bgG, bgB] = bgRgb;

  // Detect dominant background hue
  const isBlueBg = bgB > bgR + 20 && bgB > bgG + 20;
  const isRedBg = bgR > bgG + 20 && bgR > bgB + 20;

  // Normalize pixel distance relative to a standard ID photo resolution (~460px height)
  // so the 18px hair protection band reaches deep into shoulder hair on both 400px & 1200px photos
  const resScale = Math.max(1, Math.max(width, height) / 460);

  const totalPixels = width * height;
  const INF = 1e6;
  const distMap = new Float32Array(totalPixels);

  // Seed EVERY transparent pixel (alpha <= 8) — covers outer contour AND internal hair gaps
  for (let p = 0; p < totalPixels; p++) {
    distMap[p] = clonedData[p * 4 + 3] <= 8 ? 0 : INF;
  }

  const stepOrtho = 1 / resScale;
  const stepDiag = 1.4142 / resScale;

  // Pass 1: top-left -> bottom-right Chamfer Distance Transform
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      let d = distMap[p];
      if (d === 0) continue;

      if (x > 0) {
        const cand = distMap[p - 1] + stepOrtho;
        if (cand < d) d = cand;
      }
      if (y > 0) {
        const cand = distMap[p - width] + stepOrtho;
        if (cand < d) d = cand;
        if (x > 0) {
          const candDiag = distMap[p - width - 1] + stepDiag;
          if (candDiag < d) d = candDiag;
        }
        if (x + 1 < width) {
          const candDiag = distMap[p - width + 1] + stepDiag;
          if (candDiag < d) d = candDiag;
        }
      }
      distMap[p] = d;
    }
  }

  // Pass 2: bottom-right -> top-left Chamfer Distance Transform
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const p = row + x;
      let d = distMap[p];
      if (d === 0) continue;

      if (x + 1 < width) {
        const cand = distMap[p + 1] + stepOrtho;
        if (cand < d) d = cand;
      }
      if (y + 1 < height) {
        const cand = distMap[p + width] + stepOrtho;
        if (cand < d) d = cand;
        if (x + 1 < width) {
          const candDiag = distMap[p + width + 1] + stepDiag;
          if (candDiag < d) d = candDiag;
        }
        if (x > 0) {
          const candDiag = distMap[p + width - 1] + stepDiag;
          if (candDiag < d) d = candDiag;
        }
      }
      distMap[p] = d;
    }
  }

  // Wide 18px protection band covering outer contour + deep shoulder hair reflections
  const MAX_BAND_DIST = 18.0;

  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    const origAlpha = clonedData[i + 3];
    if (origAlpha === 0) continue;

    const dist = distMap[p];
    if (dist > MAX_BAND_DIST) continue;

    let r = clonedData[i];
    let g = clonedData[i + 1];
    let b = clonedData[i + 2];

    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const isSkin = isSkinTonePixel(r, g, b);

    const colorDistToBg = Math.hypot(r - bgR, g - bgG, b - bgB);
    const bgSimilarity = Math.max(0, Math.min(1, 1 - colorDistToBg / 180));

    let hasDominantChannelSpill = false;
    if (isBlueBg && b > Math.max(r, g)) {
      hasDominantChannelSpill = true;
    } else if (isRedBg && r > Math.max(g, b)) {
      hasDominantChannelSpill = true;
    } else if (bgSimilarity > 0.35) {
      hasDominantChannelSpill = true;
    }

    // -------------------------------------------------------------------------
    // 1. Outer Edge Micro-Contraction (eats outermost 1px~1.8px fringe burrs)
    // -------------------------------------------------------------------------
    const baseContractLimit = 1.6 * strength;
    const spillExtraContract =
      hasDominantChannelSpill && !isSkin ? 0.9 * strength * bgSimilarity : 0;
    const effectiveContractDist = baseContractLimit + spillExtraContract;

    let newAlpha = origAlpha;
    if (dist <= effectiveContractDist) {
      const hardEatDist = effectiveContractDist * 0.55;
      if (dist <= hardEatDist) {
        newAlpha = 0;
      } else {
        const ramp = (dist - hardEatDist) / Math.max(0.05, effectiveContractDist - hardEatDist);
        newAlpha = Math.round(origAlpha * Math.max(0, Math.min(1, ramp)));
      }
    } else if (dist <= 2.2 && origAlpha < 220) {
      newAlpha = Math.round(origAlpha * (1 - strength * 0.4 * (1 - (dist - 1) / 1.5)));
    }

    if (newAlpha < 10) {
      clonedData[i + 3] = 0;
      continue;
    }
    clonedData[i + 3] = newAlpha;

    // -------------------------------------------------------------------------
    // 2. Wide-Band 18px Deep Hair & Edge Spill Decontamination
    // -------------------------------------------------------------------------
    // Never touch skin-tone pixels inside the portrait
    if (isSkin) continue;

    // Full strength from 0..10px, smooth gradual taper from 10..18px
    const bandFalloff =
      dist <= 10.0
        ? 1.0
        : Math.max(0, Math.min(1, (MAX_BAND_DIST - dist) / (MAX_BAND_DIST - 10.0)));

    // Dark hair/clothes pixels (luma < 130) get deep 18px decontamination;
    // brighter outer fringe pixels (luma < 195) are also cleaned within outer 5px
    const isEligibleDarkHair = luma < 130;
    const isEligibleOuterFringe = dist <= 5.0 && luma < 195;

    if (!isEligibleDarkHair && !isEligibleOuterFringe) continue;

    const decontamStrength = Math.min(1, strength * 1.15) * bandFalloff;

    if (isBlueBg) {
      // Blue background spill: clamp B down to Math.min(r, g) and neutralize sky-blue G excess
      if (b > Math.max(r, g) || (isEligibleDarkHair && b > Math.min(r, g) + 6)) {
        const minRG = Math.min(r, g);
        // Force-clamp excess blue channel down to min(r, g)
        b = Math.round(b - (b - minRG) * decontamStrength);

        // If sky-blue background also lifted green above red (preventing cyan hair tint),
        // pull green down toward red as well
        if (bgG > bgR + 15 && g > r) {
          g = Math.round(g - (g - r) * decontamStrength * 0.88);
        }

        // Fuse slightly toward natural dark hair grayscale so blue reflections become natural dark gray/black hair
        const darkHairGray = Math.round(0.55 * r + 0.35 * g + 0.1 * b);
        const grayMix = Math.min(0.85, decontamStrength * (isEligibleDarkHair ? 0.72 : 0.55));
        r = Math.round(r * (1 - grayMix) + darkHairGray * grayMix);
        g = Math.round(g * (1 - grayMix) + darkHairGray * grayMix);
        b = Math.round(b * (1 - grayMix) + darkHairGray * grayMix);
      }
    } else if (isRedBg) {
      // Red background spill: clamp R down to Math.min(g, b)
      if (r > Math.max(g, b) || (isEligibleDarkHair && r > Math.min(g, b) + 6)) {
        const minGB = Math.min(g, b);
        r = Math.round(r - (r - minGB) * decontamStrength);

        const darkHairGray = Math.round(0.1 * r + 0.45 * g + 0.45 * b);
        const grayMix = Math.min(0.85, decontamStrength * (isEligibleDarkHair ? 0.72 : 0.55));
        r = Math.round(r * (1 - grayMix) + darkHairGray * grayMix);
        g = Math.round(g * (1 - grayMix) + darkHairGray * grayMix);
        b = Math.round(b * (1 - grayMix) + darkHairGray * grayMix);
      }
    } else if (bgSimilarity > 0.25 && dist <= 6.0) {
      // General background color unmixing on outer 6px
      const effAlpha = Math.max(0.25, Math.min(0.85, 1 - bgSimilarity * 0.65));
      const unmixR = Math.max(0, Math.min(255, (r - (1 - effAlpha) * bgR) / effAlpha));
      const unmixG = Math.max(0, Math.min(255, (g - (1 - effAlpha) * bgG) / effAlpha));
      const unmixB = Math.max(0, Math.min(255, (b - (1 - effAlpha) * bgB) / effAlpha));
      const w = decontamStrength * bgSimilarity;
      r = Math.round(r * (1 - w) + unmixR * w);
      g = Math.round(g * (1 - w) + unmixG * w);
      b = Math.round(b * (1 - w) + unmixB * w);
    }

    clonedData[i] = Math.max(0, Math.min(255, r));
    clonedData[i + 1] = Math.max(0, Math.min(255, g));
    clonedData[i + 2] = Math.max(0, Math.min(255, b));
  }

  ctx.putImageData(outImageData, 0, 0);
  return outCanvas;
}

/**
 * Converts a Blob (such as an AI cutout PNG) into raw unmodified ImageData.
 */
export function blobToRawImageData(blob: Blob): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        reject(new Error('无法创建透明前景画布'));
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('解码透明人像层失败'));
    };
    img.src = url;
  });
}

/**
 * Fast Channel: Combines 4-corner border BFS Flood Fill + Global Color Distance Scan
 * (clears enclosed background pockets trapped between hair strands and neck/shoulders
 * without touching human skin tones), then runs `cleanEdgeSpill` (18px depth).
 */
export async function fastSolidBackgroundCutout(
  img: HTMLImageElement | HTMLCanvasElement,
  tolerance = 40,
  defringeStrength = 80
): Promise<ForegroundCutoutResult> {
  const maxDim = 1200;
  let width = img instanceof HTMLImageElement ? img.naturalWidth || img.width : img.width;
  let height = img instanceof HTMLImageElement ? img.naturalHeight || img.height : img.height;
  if (Math.max(width, height) > maxDim) {
    const ratio = maxDim / Math.max(width, height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = width;
  rawCanvas.height = height;
  const ctx = rawCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法初始化透明前景 Canvas 上下文');

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const rawImageData = ctx.getImageData(0, 0, width, height);
  const data = rawImageData.data;

  // Check if image borders are already transparent
  const sampleCoords: Array<[number, number]> = [
    [2, 2],
    [width - 3, 2],
    [Math.floor(width * 0.25), 2],
    [Math.floor(width * 0.75), 2],
    [2, Math.floor(height * 0.2)],
    [width - 3, Math.floor(height * 0.2)],
  ];

  let transparentBorderCount = 0;
  for (const [sx, sy] of sampleCoords) {
    const x = Math.max(0, Math.min(width - 1, sx));
    const y = Math.max(0, Math.min(height - 1, sy));
    const idx = (y * width + x) * 4;
    if (data[idx + 3] < 32) {
      transparentBorderCount++;
    }
  }

  const sampledBgRgb = sampleDominantBackgroundRgb(img);

  if (transparentBorderCount >= Math.ceil(sampleCoords.length / 2)) {
    const immutableRaw = new ImageData(new Uint8ClampedArray(data), width, height);
    const foregroundCanvas = cleanEdgeSpill(immutableRaw, sampledBgRgb, defringeStrength);
    const blob = await canvasToBlob(foregroundCanvas, 'image/png');
    return {
      rawCutoutImageData: immutableRaw,
      foregroundCanvas,
      sampledBgRgb,
      blob,
    };
  }

  const [bgR, bgG, bgB] = sampledBgRgb;
  const isBlueBg = bgB > bgR + 20 && bgB > bgG + 20;
  const isRedBg = bgR > bgG + 20 && bgR > bgB + 20;

  const hardThreshold = tolerance * 2.65;
  const softThreshold = hardThreshold * 1.45;

  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const bgMask = new Uint8Array(totalPixels); // 2 = full background, 1 = soft transition edge, 0 = foreground

  const queue = new Int32Array(totalPixels);
  let head = 0;
  let tail = 0;

  const colorDist = (pixelIdx: number): number => {
    const i = pixelIdx * 4;
    const dr = data[i] - bgR;
    const dg = data[i + 1] - bgG;
    const db = data[i + 2] - bgB;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  const trySeed = (x: number, y: number) => {
    const p = y * width + x;
    if (visited[p]) return;
    if (colorDist(p) <= softThreshold) {
      visited[p] = 1;
      queue[tail++] = p;
    }
  };

  // Seed along all 4 edges (top, left, right, bottom corners)
  for (let x = 0; x < width; x++) {
    trySeed(x, 0);
    if (height > 1) trySeed(x, 1);
  }
  for (let y = 0; y < height; y++) {
    trySeed(0, y);
    if (width > 1) trySeed(1, y);
    trySeed(width - 1, y);
    if (width > 1) trySeed(width - 2, y);
  }

  const dirs: Array<[number, number]> = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];

  // Phase 1: 8-connected BFS flood-fill from image borders
  while (head < tail) {
    const p = queue[head++];
    const dist = colorDist(p);

    if (dist <= hardThreshold) {
      bgMask[p] = 2;
      const x = p % width;
      const y = (p - x) / width;

      for (let d = 0; d < dirs.length; d++) {
        const nx = x + dirs[d][0];
        const ny = y + dirs[d][1];
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const np = ny * width + nx;
          if (!visited[np]) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
      }
    } else if (dist <= softThreshold) {
      bgMask[p] = 1;
    }
  }

  // Phase 2: Global Color Distance Scan for enclosed internal background gaps
  // (e.g., isolated blue/red background pockets trapped between hair strands and neck/shoulders)
  const globalHardThreshold = hardThreshold * 0.92;
  const globalSoftThreshold = softThreshold * 0.92;

  for (let p = 0; p < totalPixels; p++) {
    if (bgMask[p] === 2) continue;
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Never clear human skin tone pixels
    if (isSkinTonePixel(r, g, b)) continue;

    // For strongly colored backgrounds (blue or red), require the pixel to match the background's
    // dominant hue so dark clothing/eyes are never mistakenly punched out
    if (isBlueBg && !(b > r + 15 && b > g + 8)) continue;
    if (isRedBg && !(r > g + 15 && r > b + 15)) continue;

    const dist = colorDist(p);
    if (dist <= globalHardThreshold) {
      bgMask[p] = 2;
    } else if (dist <= globalSoftThreshold && bgMask[p] === 0) {
      bgMask[p] = 1;
    }
  }

  // Apply computed background alpha mask
  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    if (bgMask[p] === 2) {
      data[i + 3] = 0;
    } else if (bgMask[p] === 1) {
      const dist = colorDist(p);
      const alphaRatio = Math.max(
        0,
        Math.min(1, (dist - hardThreshold) / Math.max(1, softThreshold - hardThreshold))
      );
      data[i + 3] = Math.round(data[i + 3] * alphaRatio);
    }
  }

  // Save an immutable copy of the raw cutout ImageData BEFORE running cleanEdgeSpill
  const immutableRaw = new ImageData(new Uint8ClampedArray(data), width, height);
  const foregroundCanvas = cleanEdgeSpill(immutableRaw, sampledBgRgb, defringeStrength);
  const blob = await canvasToBlob(foregroundCanvas, 'image/png');

  return {
    rawCutoutImageData: immutableRaw,
    foregroundCanvas,
    sampledBgRgb,
    blob,
  };
}

/**
 * Smart Channel: 100% Free Local Offline AI Portrait Cutout powered by @imgly/background-removal.
 *
 * 1. Primary path: `${window.location.origin}/imgly-assets/` (local public/imgly-assets/).
 * 2. Automatic fallback: if local resources fail to load, seamlessly falls back to
 *    `https://staticimgly.com/@imgly/background-removal-data/1.4.5/dist/` and jsDelivr mirror.
 * 3. Runs the 18px `cleanEdgeSpill` post-processing pipeline on the resulting raw ImageData.
 */
export async function aiPortraitCutout(
  imageSource: Blob,
  originalImgForSampling: HTMLImageElement | HTMLCanvasElement | null,
  defringeStrength = 80,
  onProgress?: (info: AiProgressInfo) => void
): Promise<ForegroundCutoutResult> {
  onProgress?.({ percent: 4, stageLabel: '正在初始化本地 AI 抠图引擎…' });

  const { removeBackground } = await import('@imgly/background-removal');

  const localPublicPath = `${window.location.origin}/imgly-assets/`;
  const fallbackPaths = [
    localPublicPath,
    'https://staticimgly.com/@imgly/background-removal-data/1.4.5/dist/',
    'https://cdn.jsdelivr.net/npm/@imgly/background-removal-data@1.4.5/dist/',
  ];

  // Quick pre-flight check to pick the first reachable resources.json without hanging
  let selectedPath = localPublicPath;
  let pathSourceLabel = '本地离线模型';

  for (let idx = 0; idx < fallbackPaths.length; idx++) {
    const candidate = fallbackPaths[idx];
    try {
      const checkRes = await fetch(`${candidate}resources.json`, { method: 'GET' });
      if (checkRes.ok) {
        selectedPath = candidate;
        pathSourceLabel =
          idx === 0 ? '本地离线轻量模型' : idx === 1 ? '官方备用镜像' : 'jsDelivr 备用镜像';
        break;
      }
    } catch {
      // Try next fallback channel
    }
  }

  const runWithPath = async (publicPath: string, sourceLabel: string): Promise<Blob> => {
    const progressMap = new Map<string, { current: number; total: number }>();

    return removeBackground(imageSource, {
      publicPath,
      model: 'small',
      output: {
        format: 'image/png',
        quality: 1,
      },
      progress: (key: string, current: number, total: number) => {
        if (total > 0) {
          progressMap.set(key, { current, total });
        }
        let sumCurrent = 0;
        let sumTotal = 0;
        for (const item of progressMap.values()) {
          sumCurrent += item.current;
          sumTotal += item.total;
        }

        if (key.includes('compute')) {
          onProgress?.({ percent: 90, stageLabel: '正在执行 AI 发丝抠图与 18px 去溢色…' });
          return;
        }

        if (sumTotal > 0) {
          const rawPct = Math.round((sumCurrent / sumTotal) * 82) + 6;
          const clamped = Math.max(8, Math.min(88, rawPct));
          const stageLabel = key.includes('wasm')
            ? `正在加载 WASM 推理内核（${sourceLabel}）…`
            : `正在加载人像分割模型（${sourceLabel}）…`;
          onProgress?.({ percent: clamped, stageLabel });
        }
      },
    });
  };

  let rawResultBlob: Blob | null = null;
  let lastError: unknown = null;

  // Attempt selected path first; if it throws during chunk/WASM load, try remaining fallbacks
  const orderedAttempts: Array<{ path: string; label: string }> = [
    { path: selectedPath, label: pathSourceLabel },
    ...fallbackPaths
      .filter((p) => p !== selectedPath)
      .map((p) => ({
        path: p,
        label: p.includes('jsdelivr') ? 'jsDelivr 备用镜像' : '官方备用镜像',
      })),
  ];

  for (const attempt of orderedAttempts) {
    try {
      rawResultBlob = await runWithPath(attempt.path, attempt.label);
      break;
    } catch (err) {
      lastError = err;
      onProgress?.({
        percent: 10,
        stageLabel: '当前模型通道异常，正在切换备用通道重试…',
      });
    }
  }

  if (!rawResultBlob) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError || '未知错误');
    throw new Error(`AI 抠图模型加载或推理失败：${detail}`);
  }

  const rawCutoutImageData = await blobToRawImageData(rawResultBlob);
  const sampledBgRgb = originalImgForSampling
    ? sampleDominantBackgroundRgb(originalImgForSampling)
    : sampleDominantBackgroundRgb(rawCutoutImageData);

  const foregroundCanvas = cleanEdgeSpill(rawCutoutImageData, sampledBgRgb, defringeStrength);

  onProgress?.({ percent: 100, stageLabel: '高精度 AI 抠图与边缘净化完成' });
  return {
    rawCutoutImageData,
    foregroundCanvas,
    sampledBgRgb,
    blob: rawResultBlob,
  };
}
