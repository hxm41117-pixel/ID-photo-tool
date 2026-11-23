import { removeBackground, preload as preloadImgly } from '@imgly/background-removal';
import { canvasToBlob } from './compression';

export interface AiProgressInfo {
  percent: number;
  stageLabel: string;
}

export interface ForegroundCutoutResult {
  /**
   * Unmodified raw transparent cutout ImageData (high-res RGB + upscaled raw AI alpha mask).
   * Stored immutably so dragging the Defringe slider or switching background colors
   * always re-runs `cleanEdgeSpill` from a clean source without cumulative mutation.
   */
  rawCutoutImageData: ImageData;
  /** Final Transparent Foreground Canvas after 4-stage matting refinement (`cleanEdgeSpill`) */
  foregroundCanvas: HTMLCanvasElement;
  /** Sampled average background RGB from the original photo corners */
  sampledBgRgb: [number, number, number];
  blob: Blob;
}

/**
 * Helper to identify human skin tone pixels so edge color decontamination
 * never accidentally alters face, ears, neck, or lips.
 */
function isSkinTonePixel(r: number, g: number, b: number): boolean {
  return (
    r > 90 &&
    g > 42 &&
    b > 22 &&
    r > g &&
    g > b &&
    r - b > 18 &&
    r - g > 10
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
    if (!ctx) return [245, 245, 245];
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

  return [245, 245, 245];
}

/**
 * Keeps ONLY the single main human portrait connected component in the alpha mask.
 * Completely eliminates any floating white islands/debris in the top-right or corners
 * (even if the AI model gave those noise blobs high alpha like 0.4 ~ 0.9).
 */
function keepLargestPortraitConnectedComponent(
  alphaMask: Uint8Array,
  width: number,
  height: number,
  minSeedAlpha = 48
): void {
  const total = width * height;
  const labels = new Int32Array(total);
  const queue = new Int32Array(total);
  let currentLabel = 0;
  let bestLabel = -1;
  let bestScore = -1;

  const centerX = width * 0.5;
  const centerY = height * 0.55;

  for (let p = 0; p < total; p++) {
    if (alphaMask[p] < minSeedAlpha || labels[p] !== 0) continue;

    currentLabel++;
    let head = 0;
    let tail = 0;
    queue[tail++] = p;
    labels[p] = currentLabel;

    let sumX = 0;
    let sumY = 0;

    while (head < tail) {
      const curr = queue[head++];
      const cx = curr % width;
      const cy = (curr - cx) / width;
      sumX += cx;
      sumY += cy;

      // 4-connected neighbors
      if (cx > 0) {
        const n = curr - 1;
        if (labels[n] === 0 && alphaMask[n] >= minSeedAlpha) {
          labels[n] = currentLabel;
          queue[tail++] = n;
        }
      }
      if (cx + 1 < width) {
        const n = curr + 1;
        if (labels[n] === 0 && alphaMask[n] >= minSeedAlpha) {
          labels[n] = currentLabel;
          queue[tail++] = n;
        }
      }
      if (cy > 0) {
        const n = curr - width;
        if (labels[n] === 0 && alphaMask[n] >= minSeedAlpha) {
          labels[n] = currentLabel;
          queue[tail++] = n;
        }
      }
      if (cy + 1 < height) {
        const n = curr + width;
        if (labels[n] === 0 && alphaMask[n] >= minSeedAlpha) {
          labels[n] = currentLabel;
          queue[tail++] = n;
        }
      }
    }

    const area = tail;
    const meanX = sumX / area;
    const meanY = sumY / area;
    const distFromCenter = Math.hypot((meanX - centerX) / width, (meanY - centerY) / height);
    const centralityBonus = Math.max(0.2, 1.2 - distFromCenter);
    const score = area * centralityBonus;

    if (score > bestScore) {
      bestScore = score;
      bestLabel = currentLabel;
    }
  }

  if (bestLabel === -1) return;

  // Dilate the winning portrait mask by 2px so fine sub-threshold edge hairs attached to the portrait
  // are preserved, while detached background islands anywhere else are wiped to 0.
  const keepRegion = new Uint8Array(total);
  for (let p = 0; p < total; p++) {
    if (labels[p] === bestLabel) {
      keepRegion[p] = 1;
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    const bit = pass + 1;
    const nextBit = pass + 2;
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const p = row + x;
        if (keepRegion[p] !== 0) continue;
        if (
          keepRegion[p - 1] === bit ||
          keepRegion[p + 1] === bit ||
          keepRegion[p - width] === bit ||
          keepRegion[p + width] === bit
        ) {
          keepRegion[p] = nextBit;
        }
      }
    }
  }

  for (let p = 0; p < total; p++) {
    if (keepRegion[p] === 0) {
      alphaMask[p] = 0;
    }
  }
}

/**
 * 4-Stage High-Precision Portrait Alpha Matting & Hair Decontamination Pipeline (`cleanEdgeSpill`):
 *
 * Stage 1: Largest Connected Component Portrait Isolation + Low-Confidence Cutoff
 *   - Eliminates ALL detached background islands/white spots (e.g. top-right corner debris)
 *     by keeping only the primary portrait connected component.
 *
 * Stage 2: Background-Aware Alpha Contrast Curve & Inward Edge Contraction (1~2.5px)
 *   - ISNet (`isnet_quint8`) outputs a soft 4~6px halo around hair where alpha is 60~190
 *     and RGB is pure white/gray background.
 *   - Applies an adaptive S-curve contrast stretch `[lowCut, highCut] -> [0, 255]` combined
 *     with background-color-similarity erosion: outer pixels whose RGB matches the original
 *     white/colored background are aggressively contracted inward, shaving off the white halo.
 *
 * Stage 3: Soft Edge Feathering (3×3 Gaussian Filter)
 *   - Smooths the eroded alpha boundary so hair and shoulder edges look natural without jagged stair-stepping.
 *
 * Stage 4: Deep Inward Hair/Clothing Color Decontamination (10px+ Deep Interior Seed Propagation)
 *   - Seeds ONLY from deep interior pixels (`distToBg >= 4.5px` and `alpha >= 240` and not bright background glare)
 *     so edge white pixels never sample another contaminated edge pixel.
 *   - Replaces/unmixes all white/bright background contamination on outer hair & shoulder edges
 *     with the true interior dark hair or clothing color.
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

  const totalPixels = width * height;
  const clampedPct = Math.max(0, Math.min(100, strengthPercent));
  const strength = clampedPct / 100; // 0.0 .. 1.0 (default 0.8)

  const [bgR, bgG, bgB] = bgRgb;
  const isBlueBg = bgB > bgR + 20 && bgB > bgG + 20;
  const isRedBg = bgR > bgG + 20 && bgR > bgB + 20;

  // =========================================================================
  // STAGE 1: 杂点与孤立连通域清理 (Connected-Component Isolation & Noise Cutoff)
  // =========================================================================
  // Dynamic low cutoff: at 0% strength -> 38 (0.15), at 80% strength -> 64 (0.25)
  const baseLowAlphaCutoff = Math.round(38 + strength * 34);
  const alpha0 = new Uint8Array(totalPixels);

  for (let p = 0; p < totalPixels; p++) {
    const a = clonedData[p * 4 + 3];
    alpha0[p] = a < 38 ? 0 : a;
  }

  // Keep ONLY the main human portrait connected component — wipes out top-right floating white islands!
  keepLargestPortraitConnectedComponent(alpha0, width, height, Math.max(45, baseLowAlphaCutoff));

  if (clampedPct === 0) {
    for (let p = 0; p < totalPixels; p++) {
      clonedData[p * 4 + 3] = alpha0[p];
    }
    ctx.putImageData(outImageData, 0, 0);
    return outCanvas;
  }

  // =========================================================================
  // STAGE 2: 背景感知 Alpha 对比度拉伸与 1~2px 形态学向内腐蚀 (Erode)
  // =========================================================================
  // First pass: suppress outer halo pixels where alpha is semi-transparent AND RGB is bright white
  // or very close to the original background color.
  const contrastAlpha = new Uint8Array(totalPixels);
  const lowCut = 38 + strength * 46; // at 80% -> ~75
  const highCut = 242;

  for (let p = 0; p < totalPixels; p++) {
    const a = alpha0[p];
    if (a <= lowCut) {
      contrastAlpha[p] = 0;
      continue;
    }

    const i = p * 4;
    const r = clonedData[i];
    const g = clonedData[i + 1];
    const b = clonedData[i + 2];

    // Check similarity to pure white (255,255,255) AND sampled original background (bgR,bgG,bgB)
    const distToWhite = Math.hypot(255 - r, 255 - g, 255 - b);
    const distToSampledBg = Math.hypot(bgR - r, bgG - g, bgB - b);
    const minBgDist = Math.min(distToWhite, distToSampledBg);

    // If a semi-transparent pixel (a < 225) has RGB very close to white/background,
    // it is part of the outer background halo around hair — raise its effective cutoff
    let effectiveLowCut = lowCut;
    if (a < 225 && !isSkinTonePixel(r, g, b)) {
      const whiteHaloSimilarity = Math.max(0, 1 - minBgDist / 115);
      effectiveLowCut += whiteHaloSimilarity * strength * 95;
    }

    if (a <= effectiveLowCut) {
      contrastAlpha[p] = 0;
    } else if (a >= highCut) {
      contrastAlpha[p] = 255;
    } else {
      const norm = (a - effectiveLowCut) / Math.max(1, highCut - effectiveLowCut);
      // Slight gamma > 1 on the lower tail pushes faint white fringes cleanly to 0
      const curved = Math.pow(norm, 1 + strength * 0.35);
      contrastAlpha[p] = Math.round(curved * 255);
    }
  }

  // Re-run connected component cleanup after contrast thresholding so any newly detached halo specks vanish
  keepLargestPortraitConnectedComponent(contrastAlpha, width, height, 42);

  // Compute Chamfer distance to transparent background (distToBg)
  const resScale = Math.max(1, Math.max(width, height) / 600);
  const stepOrtho = 1 / resScale;
  const stepDiag = 1.4142 / resScale;
  const INF = 1e6;

  const distToBg = new Float32Array(totalPixels);
  for (let p = 0; p < totalPixels; p++) {
    distToBg[p] = contrastAlpha[p] === 0 ? 0 : INF;
  }

  // Forward Chamfer pass for distToBg
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      let d = distToBg[p];
      if (d === 0) continue;
      if (x > 0 && distToBg[p - 1] + stepOrtho < d) d = distToBg[p - 1] + stepOrtho;
      if (y > 0) {
        const up = p - width;
        if (distToBg[up] + stepOrtho < d) d = distToBg[up] + stepOrtho;
        if (x > 0 && distToBg[up - 1] + stepDiag < d) d = distToBg[up - 1] + stepDiag;
        if (x + 1 < width && distToBg[up + 1] + stepDiag < d) d = distToBg[up + 1] + stepDiag;
      }
      distToBg[p] = d;
    }
  }

  // Backward Chamfer pass for distToBg
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const p = row + x;
      let d = distToBg[p];
      if (d === 0) continue;
      if (x + 1 < width && distToBg[p + 1] + stepOrtho < d) d = distToBg[p + 1] + stepOrtho;
      if (y + 1 < height) {
        const down = p + width;
        if (distToBg[down] + stepOrtho < d) d = distToBg[down] + stepOrtho;
        if (x + 1 < width && distToBg[down + 1] + stepDiag < d) d = distToBg[down + 1] + stepDiag;
        if (x > 0 && distToBg[down - 1] + stepDiag < d) d = distToBg[down - 1] + stepDiag;
      }
      distToBg[p] = d;
    }
  }

  // Morphological 1~2px Erode + Distance Micro-Contraction
  const erodedAlpha = new Uint8Array(totalPixels);
  const erodeBlend = Math.min(1, strength * 1.15);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const origA = contrastAlpha[p];
      if (origA === 0) continue;

      const d = distToBg[p];
      if (d > 4.5) {
        erodedAlpha[p] = origA;
        continue;
      }

      let min4 = origA;
      if (x > 0 && contrastAlpha[p - 1] < min4) min4 = contrastAlpha[p - 1];
      if (x + 1 < width && contrastAlpha[p + 1] < min4) min4 = contrastAlpha[p + 1];
      if (y > 0 && contrastAlpha[p - width] < min4) min4 = contrastAlpha[p - width];
      if (y + 1 < height && contrastAlpha[p + width] < min4) min4 = contrastAlpha[p + width];

      let min8 = min4;
      if (y > 0 && x > 0 && contrastAlpha[p - width - 1] < min8) min8 = contrastAlpha[p - width - 1];
      if (y > 0 && x + 1 < width && contrastAlpha[p - width + 1] < min8) min8 = contrastAlpha[p - width + 1];
      if (y + 1 < height && x > 0 && contrastAlpha[p + width - 1] < min8) min8 = contrastAlpha[p + width - 1];
      if (y + 1 < height && x + 1 < width && contrastAlpha[p + width + 1] < min8) min8 = contrastAlpha[p + width + 1];

      const targetEroded = strength >= 0.6 ? Math.round(min4 * 0.35 + min8 * 0.65) : min4;
      let nextA = Math.round(origA * (1 - erodeBlend) + targetEroded * erodeBlend);

      const erodeRadiusPx = 1.65 * strength;
      if (d <= erodeRadiusPx) {
        const hardCut = erodeRadiusPx * 0.55;
        if (d <= hardCut) {
          nextA = 0;
        } else {
          const ramp = (d - hardCut) / Math.max(0.05, erodeRadiusPx - hardCut);
          nextA = Math.min(nextA, Math.round(origA * Math.max(0, Math.min(1, ramp))));
        }
      }

      erodedAlpha[p] = nextA < 28 ? 0 : nextA;
    }
  }

  // =========================================================================
  // STAGE 3: 边缘微弱羽化 (3×3 Gaussian Edge Feathering)
  // =========================================================================
  const featheredAlpha = new Uint8Array(totalPixels);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const d = distToBg[p];
      const centerA = erodedAlpha[p];

      if (d > 4.0 || x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        featheredAlpha[p] = centerA;
        continue;
      }

      const sum =
        erodedAlpha[p - width - 1] +
        2 * erodedAlpha[p - width] +
        erodedAlpha[p - width + 1] +
        2 * erodedAlpha[p - 1] +
        4 * centerA +
        2 * erodedAlpha[p + 1] +
        erodedAlpha[p + width - 1] +
        2 * erodedAlpha[p + width] +
        erodedAlpha[p + width + 1];

      const blurred = sum >> 4;
      if (centerA === 0) {
        featheredAlpha[p] = 0;
      } else {
        const finalA = Math.round(centerA * 0.3 + blurred * 0.7);
        featheredAlpha[p] = finalA < 24 ? 0 : finalA;
      }
    }
  }

  // =========================================================================
  // STAGE 4: 深层向内采样发丝/衣物颜色去污 (Deep Inward Color Decontamination)
  // =========================================================================
  // Crucial fix: ONLY seed interior color donors from pixels that are BOTH:
  //   1. At least 4.5px deep inside the portrait (`distToBg[p] >= 4.5`)
  //   2. Fully opaque (`featheredAlpha[p] >= 242`)
  //   3. Not bright white background glare (`luma < 215`)
  // This guarantees outer hair strands sample genuine dark hair color 5~12px inside the head,
  // NEVER an adjacent white-contaminated edge pixel!
  const distToInterior = new Float32Array(totalPixels);
  const nearestInterior = new Int32Array(totalPixels);

  for (let p = 0; p < totalPixels; p++) {
    const a = featheredAlpha[p];
    const dBg = distToBg[p];
    const i = p * 4;
    const r = clonedData[i];
    const g = clonedData[i + 1];
    const b = clonedData[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    if (a >= 242 && dBg >= 4.5 && luma < 215) {
      distToInterior[p] = 0;
      nearestInterior[p] = p;
    } else {
      distToInterior[p] = INF;
      nearestInterior[p] = -1;
    }
  }

  // Forward Chamfer propagation of nearest deep interior pixel
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      let dIn = distToInterior[p];
      let nearIn = nearestInterior[p];
      if (dIn === 0) continue;

      if (x > 0 && distToInterior[p - 1] + stepOrtho < dIn) {
        dIn = distToInterior[p - 1] + stepOrtho;
        nearIn = nearestInterior[p - 1];
      }
      if (y > 0) {
        const up = p - width;
        if (distToInterior[up] + stepOrtho < dIn) {
          dIn = distToInterior[up] + stepOrtho;
          nearIn = nearestInterior[up];
        }
        if (x > 0 && distToInterior[up - 1] + stepDiag < dIn) {
          dIn = distToInterior[up - 1] + stepDiag;
          nearIn = nearestInterior[up - 1];
        }
        if (x + 1 < width && distToInterior[up + 1] + stepDiag < dIn) {
          dIn = distToInterior[up + 1] + stepDiag;
          nearIn = nearestInterior[up + 1];
        }
      }
      distToInterior[p] = dIn;
      nearestInterior[p] = nearIn;
    }
  }

  // Backward Chamfer propagation of nearest deep interior pixel
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const p = row + x;
      let dIn = distToInterior[p];
      let nearIn = nearestInterior[p];
      if (dIn === 0) continue;

      if (x + 1 < width && distToInterior[p + 1] + stepOrtho < dIn) {
        dIn = distToInterior[p + 1] + stepOrtho;
        nearIn = nearestInterior[p + 1];
      }
      if (y + 1 < height) {
        const down = p + width;
        if (distToInterior[down] + stepOrtho < dIn) {
          dIn = distToInterior[down] + stepOrtho;
          nearIn = nearestInterior[down];
        }
        if (x + 1 < width && distToInterior[down + 1] + stepDiag < dIn) {
          dIn = distToInterior[down + 1] + stepDiag;
          nearIn = nearestInterior[down + 1];
        }
        if (x > 0 && distToInterior[down - 1] + stepDiag < dIn) {
          dIn = distToInterior[down - 1] + stepDiag;
          nearIn = nearestInterior[down - 1];
        }
      }
      distToInterior[p] = dIn;
      nearestInterior[p] = nearIn;
    }
  }

  const MAX_BAND_DIST = 18.0;

  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    let finalAlpha = featheredAlpha[p];
    if (finalAlpha === 0) {
      clonedData[i + 3] = 0;
      continue;
    }

    const dist = distToBg[p];
    if (dist > MAX_BAND_DIST) {
      clonedData[i + 3] = finalAlpha;
      continue;
    }

    let r = clonedData[i];
    let g = clonedData[i + 1];
    let b = clonedData[i + 2];

    if (isSkinTonePixel(r, g, b)) {
      clonedData[i + 3] = finalAlpha;
      continue;
    }

    const nearIdx = nearestInterior[p];
    // For outer 10px edge band or any semi-transparent pixel, decontaminate white/background halo
    if (nearIdx >= 0 && (dist <= 10.0 || finalAlpha < 250)) {
      const ni = nearIdx * 4;
      const inR = clonedData[ni];
      const inG = clonedData[ni + 1];
      const inB = clonedData[ni + 2];

      const edgeLuma = 0.299 * r + 0.587 * g + 0.114 * b;
      const inLuma = 0.299 * inR + 0.587 * inG + 0.114 * inB;

      // Whenever an outer edge pixel is brighter than its interior donor (e.g. white/gray halo on dark hair or sweater),
      // replace its contaminated brightness with the interior donor color!
      if (edgeLuma > inLuma + 6 || finalAlpha < 245) {
        const lumaDiffRatio = Math.max(0, Math.min(1, (edgeLuma - inLuma) / 70));
        const translucencyRatio = 1 - finalAlpha / 255;
        const proximityRatio = Math.max(0, Math.min(1, 1 - dist / 9.0));

        const replaceWeight = Math.min(
          0.98,
          Math.max(
            translucencyRatio * 0.98,
            lumaDiffRatio * proximityRatio * Math.min(1, strength * 1.25),
            dist <= 3.5 ? strength * 0.92 : 0
          )
        );

        r = Math.round(r * (1 - replaceWeight) + inR * replaceWeight);
        g = Math.round(g * (1 - replaceWeight) + inG * replaceWeight);
        b = Math.round(b * (1 - replaceWeight) + inB * replaceWeight);

        // If the original pixel was strongly contaminated by white background in the outermost 3px,
        // also attenuate its alpha slightly so the hair silhouette looks crisp and natural
        if (lumaDiffRatio > 0.45 && dist <= 3.0) {
          finalAlpha = Math.round(finalAlpha * (1 - lumaDiffRatio * strength * 0.45));
        }
      }
    }

    // Deep 18px Blue / Red Backdrop Spill Neutralization for Dark Hair
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const isEligibleDarkHair = luma < 135;
    const isEligibleOuterFringe = dist <= 5.0 && luma < 200;

    if (isEligibleDarkHair || isEligibleOuterFringe) {
      const bandFalloff =
        dist <= 10.0
          ? 1.0
          : Math.max(0, Math.min(1, (MAX_BAND_DIST - dist) / (MAX_BAND_DIST - 10.0)));
      const decontamStrength = Math.min(1, strength * 1.15) * bandFalloff;

      if (isBlueBg) {
        if (b > Math.max(r, g) || (isEligibleDarkHair && b > Math.min(r, g) + 6)) {
          const minRG = Math.min(r, g);
          b = Math.round(b - (b - minRG) * decontamStrength);
          if (bgG > bgR + 15 && g > r) {
            g = Math.round(g - (g - r) * decontamStrength * 0.88);
          }
          const darkHairGray = Math.round(0.55 * r + 0.35 * g + 0.1 * b);
          const grayMix = Math.min(0.85, decontamStrength * (isEligibleDarkHair ? 0.72 : 0.55));
          r = Math.round(r * (1 - grayMix) + darkHairGray * grayMix);
          g = Math.round(g * (1 - grayMix) + darkHairGray * grayMix);
          b = Math.round(b * (1 - grayMix) + darkHairGray * grayMix);
        }
      } else if (isRedBg) {
        if (r > Math.max(g, b) || (isEligibleDarkHair && r > Math.min(g, b) + 6)) {
          const minGB = Math.min(g, b);
          r = Math.round(r - (r - minGB) * decontamStrength);
          const darkHairGray = Math.round(0.1 * r + 0.45 * g + 0.45 * b);
          const grayMix = Math.min(0.85, decontamStrength * (isEligibleDarkHair ? 0.72 : 0.55));
          r = Math.round(r * (1 - grayMix) + darkHairGray * grayMix);
          g = Math.round(g * (1 - grayMix) + darkHairGray * grayMix);
          b = Math.round(b * (1 - grayMix) + darkHairGray * grayMix);
        }
      }
    }

    clonedData[i] = Math.max(0, Math.min(255, r));
    clonedData[i + 1] = Math.max(0, Math.min(255, g));
    clonedData[i + 2] = Math.max(0, Math.min(255, b));
    clonedData[i + 3] = finalAlpha < 20 ? 0 : finalAlpha;
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

// ============================================================================
// Local Model & WASM Persistent Cache (Cache API + IndexedDB Fallback)
// ============================================================================

const MODEL_CACHE_NAME = 'id-photo-ai-model-assets-v1';
const MODEL_IDB_NAME = 'id_photo_ai_assets_db_v1';
const MODEL_IDB_STORE = 'chunks';

let isFetchInterceptorInstalled = false;
let hasCachedAllModelAssets = false;
let preloadPromise: Promise<void> | null = null;

function openModelAssetIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(MODEL_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MODEL_IDB_STORE)) {
        db.createObjectStore(MODEL_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getIdbCachedBlob(urlKey: string): Promise<Blob | null> {
  try {
    const db = await openModelAssetIdb();
    return await new Promise<Blob | null>((resolve) => {
      const tx = db.transaction(MODEL_IDB_STORE, 'readonly');
      const req = tx.objectStore(MODEL_IDB_STORE).get(urlKey);
      req.onsuccess = () => resolve((req.result as Blob) || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putIdbCachedBlob(urlKey: string, blob: Blob): Promise<void> {
  try {
    const db = await openModelAssetIdb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MODEL_IDB_STORE, 'readwrite');
      tx.objectStore(MODEL_IDB_STORE).put(blob, urlKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore quota or private browsing errors
  }
}

/**
 * Installs a transparent `window.fetch` wrapper for `/imgly-assets/` requests
 * so all ONNX `small` (`isnet_quint8`) model chunks and WASM binaries are persisted
 * in Browser Cache Storage API (with IndexedDB fallback) after the first visit.
 */
function ensureLocalModelPersistentCacheInterceptor(): void {
  if (isFetchInterceptorInstalled || typeof window === 'undefined') return;
  isFetchInterceptorInstalled = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (!urlStr.includes('/imgly-assets/')) {
      return nativeFetch(input, init);
    }

    const isResourcesJson = urlStr.endsWith('resources.json');

    // 1. Try Cache Storage API first
    if (typeof caches !== 'undefined') {
      try {
        const cache = await caches.open(MODEL_CACHE_NAME);
        const cachedRes = await cache.match(urlStr);
        if (cachedRes && cachedRes.ok) {
          if (!isResourcesJson) {
            hasCachedAllModelAssets = true;
          }
          return cachedRes.clone();
        }
        const netRes = await nativeFetch(input, init);
        if (netRes.ok) {
          cache.put(urlStr, netRes.clone()).catch(() => {});
        }
        return netRes;
      } catch {
        // Fall through to IndexedDB fallback
      }
    }

    // 2. Fallback to IndexedDB for WebViews where Cache API is restricted
    if (!isResourcesJson) {
      const cachedBlob = await getIdbCachedBlob(urlStr);
      if (cachedBlob && cachedBlob.size > 0) {
        hasCachedAllModelAssets = true;
        return new Response(cachedBlob, {
          status: 200,
          headers: { 'Content-Type': cachedBlob.type || 'application/octet-stream' },
        });
      }
    }

    const netRes = await nativeFetch(input, init);
    if (netRes.ok && !isResourcesJson) {
      const cloned = netRes.clone();
      cloned
        .blob()
        .then((b) => {
          if (b.size > 0) return putIdbCachedBlob(urlStr, b);
        })
        .catch(() => {});
    }
    return netRes;
  };
}

/**
 * Quietly pre-warms the local AI model & WASM chunks in the background as soon as the app mounts,
 * so by the time the user picks a photo from their album, the model is already cached or loaded.
 */
export function warmupLocalAiModelInBackground(): void {
  if (typeof window === 'undefined' || preloadPromise) return;
  ensureLocalModelPersistentCacheInterceptor();
  const localPublicPath = `${window.location.origin}/imgly-assets/`;

  preloadPromise = (async () => {
    try {
      await preloadImgly({
        publicPath: localPublicPath,
        model: 'small',
      });
      hasCachedAllModelAssets = true;
    } catch {
      // Silent background warmup; actual invocation handles errors explicitly
    }
  })();
}

/**
 * Checks whether the local AI model chunks are already cached in Cache API or IndexedDB.
 */
async function checkIsModelCachedLocally(localPublicPath: string): Promise<boolean> {
  if (hasCachedAllModelAssets) return true;
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(MODEL_CACHE_NAME);
      const keys = await cache.keys();
      if (keys.length >= 10) {
        hasCachedAllModelAssets = true;
        return true;
      }
    }
    const res = await fetch(`${localPublicPath}resources.json`);
    if (res.ok) {
      const map = await res.json();
      const firstChunkHash = map?.['/models/small']?.chunks?.[0]?.hash;
      if (firstChunkHash) {
        const blob = await getIdbCachedBlob(`${localPublicPath}${firstChunkHash}`);
        if (blob && blob.size > 0) {
          hasCachedAllModelAssets = true;
          return true;
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Downscales the source image to an offscreen canvas whose longest edge does not exceed
 * `maxInferenceEdge` (default 768px; 640px on mobile devices) before sending to AI inference.
 */
function createDownscaledInferenceBlob(
  sourceImg: HTMLImageElement | HTMLCanvasElement,
  maxInferenceEdge: number
): Promise<{ blob: Blob; inferWidth: number; inferHeight: number }> {
  const origW =
    sourceImg instanceof HTMLImageElement
      ? sourceImg.naturalWidth || sourceImg.width
      : sourceImg.width;
  const origH =
    sourceImg instanceof HTMLImageElement
      ? sourceImg.naturalHeight || sourceImg.height
      : sourceImg.height;

  const scale = Math.min(1, maxInferenceEdge / Math.max(1, origW, origH));
  const inferWidth = Math.max(1, Math.round(origW * scale));
  const inferHeight = Math.max(1, Math.round(origH * scale));

  const offscreen = document.createElement('canvas');
  offscreen.width = inferWidth;
  offscreen.height = inferHeight;
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建离屏缩放推理画布');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, inferWidth, inferHeight);
  ctx.drawImage(sourceImg, 0, 0, inferWidth, inferHeight);

  return new Promise((resolve, reject) => {
    offscreen.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('缩放推理图像编码失败'));
          return;
        }
        resolve({ blob, inferWidth, inferHeight });
      },
      'image/png',
      1
    );
  });
}

/**
 * Smoothly upscales the low-resolution AI cutout's Alpha Mask back to the original
 * high-resolution photo dimensions (`origW × origH`) and composites it onto the original
 * high-definition RGB pixels.
 */
async function compositeUpscaledMaskWithOriginalHd(
  lowResCutoutBlob: Blob,
  originalImg: HTMLImageElement | HTMLCanvasElement
): Promise<ImageData> {
  const origW =
    originalImg instanceof HTMLImageElement
      ? originalImg.naturalWidth || originalImg.width
      : originalImg.width;
  const origH =
    originalImg instanceof HTMLImageElement
      ? originalImg.naturalHeight || originalImg.height
      : originalImg.height;

  const maskUrl = URL.createObjectURL(lowResCutoutBlob);
  const lowResMaskImg = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(maskUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(maskUrl);
      reject(new Error('解码 AI 人像遮罩失败'));
    };
    img.src = maskUrl;
  });

  const hdCanvas = document.createElement('canvas');
  hdCanvas.width = origW;
  hdCanvas.height = origH;
  const hdCtx = hdCanvas.getContext('2d', { willReadFrequently: true });
  if (!hdCtx) throw new Error('无法创建高清合成画布');

  hdCtx.imageSmoothingEnabled = true;
  hdCtx.imageSmoothingQuality = 'high';
  hdCtx.clearRect(0, 0, origW, origH);
  hdCtx.drawImage(originalImg, 0, 0, origW, origH);
  const hdImageData = hdCtx.getImageData(0, 0, origW, origH);
  const hdPixels = hdImageData.data;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = origW;
  maskCanvas.height = origH;
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!maskCtx) throw new Error('无法创建高清遮罩放大画布');

  maskCtx.imageSmoothingEnabled = true;
  maskCtx.imageSmoothingQuality = 'high';
  maskCtx.clearRect(0, 0, origW, origH);
  maskCtx.drawImage(lowResMaskImg, 0, 0, origW, origH);
  const upscaledMaskData = maskCtx.getImageData(0, 0, origW, origH).data;

  const totalBytes = hdPixels.length;
  for (let i = 3; i < totalBytes; i += 4) {
    hdPixels[i] = upscaledMaskData[i];
  }

  return hdImageData;
}

/**
 * Unified AI Portrait Cutout Pipeline
 */
export async function aiPortraitCutout(
  imageSource: Blob,
  originalImgForSampling: HTMLImageElement | HTMLCanvasElement | null,
  defringeStrength = 80,
  onProgress?: (info: AiProgressInfo) => void
): Promise<ForegroundCutoutResult> {
  ensureLocalModelPersistentCacheInterceptor();

  const localPublicPath = `${window.location.origin}/imgly-assets/`;
  const isCached = await checkIsModelCachedLocally(localPublicPath);

  onProgress?.({
    percent: 6,
    stageLabel: isCached
      ? '已命中本机缓存，正在启动 AI 人像抠图…'
      : '首次加载本地 AI 模型（完成后永久缓存）…',
  });

  let sourceElement: HTMLImageElement | HTMLCanvasElement | null = originalImgForSampling;
  if (!sourceElement) {
    const tempUrl = URL.createObjectURL(imageSource);
    sourceElement = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(tempUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(tempUrl);
        reject(new Error('无法解码待抠图图片'));
      };
      img.src = tempUrl;
    });
  }

  const isMobileViewport =
    typeof window !== 'undefined' && (window.innerWidth < 768 || navigator.maxTouchPoints > 1);
  const maxInferenceEdge = isMobileViewport ? 640 : 768;

  const { blob: downscaledBlob } = await createDownscaledInferenceBlob(
    sourceElement,
    maxInferenceEdge
  );

  const progressMap = new Map<string, { current: number; total: number }>();

  let lowResResultBlob: Blob;
  try {
    lowResResultBlob = await removeBackground(downscaledBlob, {
      publicPath: localPublicPath,
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
          onProgress?.({
            percent: 86,
            stageLabel: '正在精准分离发丝与人像边缘…',
          });
          return;
        }

        if (sumTotal > 0) {
          const downloadPct = Math.min(100, Math.round((sumCurrent / sumTotal) * 100));
          const mappedPct = Math.max(12, Math.min(82, Math.round((sumCurrent / sumTotal) * 70) + 12));
          const mbLoaded = (sumCurrent / 1024 / 1024).toFixed(1);
          const mbTotal = (sumTotal / 1024 / 1024).toFixed(1);

          const stageLabel = isCached
            ? `正在读取本机 AI 模型缓存 (${downloadPct}%)…`
            : key.includes('wasm')
              ? `首次加载本地推理引擎 (${mbLoaded}/${mbTotal} MB)…`
              : `首次加载本地人像模型 (${mbLoaded}/${mbTotal} MB，${downloadPct}%)…`;

          onProgress?.({ percent: mappedPct, stageLabel });
        }
      },
    });
    hasCachedAllModelAssets = true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err || '未知错误');
    throw new Error(`本地 AI 抠图模型加载或推理失败：${detail}`);
  }

  onProgress?.({
    percent: 94,
    stageLabel: '正在执行高清遮罩还原与发丝去白边…',
  });

  const rawCutoutImageData = await compositeUpscaledMaskWithOriginalHd(
    lowResResultBlob,
    sourceElement
  );

  const sampledBgRgb = sampleDominantBackgroundRgb(sourceElement);
  const foregroundCanvas = cleanEdgeSpill(rawCutoutImageData, sampledBgRgb, defringeStrength);

  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = rawCutoutImageData.width;
  rawCanvas.height = rawCutoutImageData.height;
  const rawCtx = rawCanvas.getContext('2d');
  if (rawCtx) {
    rawCtx.putImageData(rawCutoutImageData, 0, 0);
  }
  const hdRawBlob = rawCtx ? await canvasToBlob(rawCanvas, 'image/png') : lowResResultBlob;

  onProgress?.({ percent: 100, stageLabel: '高清 AI 抠图与去白边完成' });

  return {
    rawCutoutImageData,
    foregroundCanvas,
    sampledBgRgb,
    blob: hdRawBlob,
  };
}
