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
  /** Final Transparent Foreground Canvas after 3-step alpha & color post-processing (`cleanEdgeSpill`) */
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

  return [245, 245, 245];
}

/**
 * 3-Step Alpha Mask & Edge Post-Processing Pipeline (`cleanEdgeSpill`):
 *
 * Always clones `rawCutoutImageData` without mutating the source, returning a brand-new
 * Transparent Foreground Canvas (`HTMLCanvasElement`).
 *
 * Step 1: 杂点清理 (Low-Confidence Noise Cleanup)
 *   - Pixels with alpha < 0.15 (alpha < 38 / 255) are zeroed out immediately to eliminate
 *     scattered background white dots and translucent haze.
 *
 * Step 2: 边缘微缩与羽化 (Edge Erosion 1~2px & Soft Feathering)
 *   - Applies a morphological minimum filter (Erode) of 1~2px scaled by `strength` along the
 *     alpha boundary, followed by a separable 3×3 Gaussian-like feather blur on the edge band,
 *     shaving off the outermost residual white contour while keeping hair transitions natural.
 *
 * Step 3: 边缘颜色去污 (Color Decontamination & Inward Hair/Cloth Color Propagating)
 *   - Strips white background component `(255, 255, 255)` AND original sampled background color
 *     `bgRgb` from semi-transparent and outer edge pixels (`alpha / 255` unmixing).
 *   - Propagates interior opaque hair/clothing colors outward via Chamfer nearest-interior
 *     propagation so semi-transparent hair strands never glow white/gray against dark blue or red backgrounds.
 *   - Preserves deep 18px blue/red spill clamping for photos originally shot against colored backdrops.
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

  // =========================================================================
  // STEP 1: 杂点清理 — 将透明度低于 0.15 (38/255) 的低置信度像素直接归零
  // =========================================================================
  const LOW_ALPHA_CUTOFF = 38; // 0.15 * 255 ≈ 38.25
  const alpha0 = new Uint8Array(totalPixels);
  for (let p = 0; p < totalPixels; p++) {
    const a = clonedData[p * 4 + 3];
    if (a < LOW_ALPHA_CUTOFF) {
      alpha0[p] = 0;
      clonedData[p * 4 + 3] = 0;
    } else {
      alpha0[p] = a;
    }
  }

  if (clampedPct === 0) {
    ctx.putImageData(outImageData, 0, 0);
    return outCanvas;
  }

  // =========================================================================
  // STEP 2: 边缘微缩 (1~2px Erode) 与微弱羽化 (Soft Edge Feathering)
  // =========================================================================
  // Compute Chamfer distance from transparent background (alpha0 === 0)
  // AND propagate nearest interior opaque pixel index (`nearestInteriorIdx`)
  // so Step 3 can re-color contaminated hair fringes with true neighboring hair/cloth color.
  const resScale = Math.max(1, Math.max(width, height) / 600);
  const stepOrtho = 1 / resScale;
  const stepDiag = 1.4142 / resScale;
  const INF = 1e6;

  const distToBg = new Float32Array(totalPixels);
  const distToInterior = new Float32Array(totalPixels);
  const nearestInterior = new Int32Array(totalPixels);

  for (let p = 0; p < totalPixels; p++) {
    const a = alpha0[p];
    distToBg[p] = a === 0 ? 0 : INF;

    // Interior seed: high-opacity pixel (alpha >= 235) that is not pure white background glare
    const i = p * 4;
    const r = clonedData[i];
    const g = clonedData[i + 1];
    const b = clonedData[i + 2];
    const isBrightWhiteGlare = r > 235 && g > 235 && b > 235;
    if (a >= 235 && !isBrightWhiteGlare) {
      distToInterior[p] = 0;
      nearestInterior[p] = p;
    } else {
      distToInterior[p] = INF;
      nearestInterior[p] = -1;
    }
  }

  // Forward pass (top-left -> bottom-right) for both distance transforms
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      let dBg = distToBg[p];
      let dIn = distToInterior[p];
      let nearIn = nearestInterior[p];

      if (x > 0) {
        const left = p - 1;
        if (distToBg[left] + stepOrtho < dBg) dBg = distToBg[left] + stepOrtho;
        if (distToInterior[left] + stepOrtho < dIn) {
          dIn = distToInterior[left] + stepOrtho;
          nearIn = nearestInterior[left];
        }
      }
      if (y > 0) {
        const up = p - width;
        if (distToBg[up] + stepOrtho < dBg) dBg = distToBg[up] + stepOrtho;
        if (distToInterior[up] + stepOrtho < dIn) {
          dIn = distToInterior[up] + stepOrtho;
          nearIn = nearestInterior[up];
        }
        if (x > 0) {
          const ul = up - 1;
          if (distToBg[ul] + stepDiag < dBg) dBg = distToBg[ul] + stepDiag;
          if (distToInterior[ul] + stepDiag < dIn) {
            dIn = distToInterior[ul] + stepDiag;
            nearIn = nearestInterior[ul];
          }
        }
        if (x + 1 < width) {
          const ur = up + 1;
          if (distToBg[ur] + stepDiag < dBg) dBg = distToBg[ur] + stepDiag;
          if (distToInterior[ur] + stepDiag < dIn) {
            dIn = distToInterior[ur] + stepDiag;
            nearIn = nearestInterior[ur];
          }
        }
      }
      distToBg[p] = dBg;
      distToInterior[p] = dIn;
      nearestInterior[p] = nearIn;
    }
  }

  // Backward pass (bottom-right -> top-left)
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const p = row + x;
      let dBg = distToBg[p];
      let dIn = distToInterior[p];
      let nearIn = nearestInterior[p];

      if (x + 1 < width) {
        const right = p + 1;
        if (distToBg[right] + stepOrtho < dBg) dBg = distToBg[right] + stepOrtho;
        if (distToInterior[right] + stepOrtho < dIn) {
          dIn = distToInterior[right] + stepOrtho;
          nearIn = nearestInterior[right];
        }
      }
      if (y + 1 < height) {
        const down = p + width;
        if (distToBg[down] + stepOrtho < dBg) dBg = distToBg[down] + stepOrtho;
        if (distToInterior[down] + stepOrtho < dIn) {
          dIn = distToInterior[down] + stepOrtho;
          nearIn = nearestInterior[down];
        }
        if (x + 1 < width) {
          const dr = down + 1;
          if (distToBg[dr] + stepDiag < dBg) dBg = distToBg[dr] + stepDiag;
          if (distToInterior[dr] + stepDiag < dIn) {
            dIn = distToInterior[dr] + stepDiag;
            nearIn = nearestInterior[dr];
          }
        }
        if (x > 0) {
          const dl = down - 1;
          if (distToBg[dl] + stepDiag < dBg) dBg = distToBg[dl] + stepDiag;
          if (distToInterior[dl] + stepDiag < dIn) {
            dIn = distToInterior[dl] + stepDiag;
            nearIn = nearestInterior[dl];
          }
        }
      }
      distToBg[p] = dBg;
      distToInterior[p] = dIn;
      nearestInterior[p] = nearIn;
    }
  }

  // 2A. Morphological Erode (1~2px inward contraction on the alpha mask)
  const erodedAlpha = new Uint8Array(totalPixels);
  const erodeBlend = Math.min(1, strength * 1.1); // at 80% strength -> ~0.88 blend of 1~2px erosion

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const origA = alpha0[p];
      if (origA === 0) continue;

      const d = distToBg[p];
      if (d > 4.0) {
        erodedAlpha[p] = origA;
        continue;
      }

      // Compute 4-connected (1px radius) and 8-connected (1.5px radius) minimum alpha
      let min4 = origA;
      let min8 = origA;

      if (x > 0) {
        const a = alpha0[p - 1];
        if (a < min4) min4 = a;
      }
      if (x + 1 < width) {
        const a = alpha0[p + 1];
        if (a < min4) min4 = a;
      }
      if (y > 0) {
        const a = alpha0[p - width];
        if (a < min4) min4 = a;
      }
      if (y + 1 < height) {
        const a = alpha0[p + width];
        if (a < min4) min4 = a;
      }

      min8 = min4;
      if (y > 0 && x > 0 && alpha0[p - width - 1] < min8) min8 = alpha0[p - width - 1];
      if (y > 0 && x + 1 < width && alpha0[p - width + 1] < min8) min8 = alpha0[p - width + 1];
      if (y + 1 < height && x > 0 && alpha0[p + width - 1] < min8) min8 = alpha0[p + width - 1];
      if (y + 1 < height && x + 1 < width && alpha0[p + width + 1] < min8) min8 = alpha0[p + width + 1];

      // Blend between 4-neighbor and 8-neighbor erosion based on strength (1~2px inward erode)
      const targetEroded = strength >= 0.65 ? Math.round(min4 * 0.45 + min8 * 0.55) : min4;
      let nextA = Math.round(origA * (1 - erodeBlend) + targetEroded * erodeBlend);

      // Additional distance-based inward trim for outermost 1.5px white contour
      const erodeRadiusPx = 1.45 * strength;
      if (d <= erodeRadiusPx) {
        const hardCut = erodeRadiusPx * 0.5;
        if (d <= hardCut) {
          nextA = 0;
        } else {
          const ramp = (d - hardCut) / Math.max(0.05, erodeRadiusPx - hardCut);
          nextA = Math.min(nextA, Math.round(origA * Math.max(0, Math.min(1, ramp))));
        }
      }

      erodedAlpha[p] = nextA < LOW_ALPHA_CUTOFF ? 0 : nextA;
    }
  }

  // 2B. Soft Feathering (3×3 Gaussian kernel [1,2,1; 2,4,2; 1,2,1]/16 along the edge transition zone)
  const featheredAlpha = new Uint8Array(totalPixels);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const d = distToBg[p];
      const centerA = erodedAlpha[p];

      // Only feather pixels within the 0.5px ~ 3.5px edge transition band
      if (d > 3.5 || x === 0 || x === width - 1 || y === 0 || y === height - 1) {
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

      const blurred = sum >> 4; // divide by 16
      // Never let feathering re-introduce halo outside the eroded boundary where centerA === 0
      if (centerA === 0) {
        featheredAlpha[p] = 0;
      } else {
        const finalA = Math.round(centerA * 0.35 + blurred * 0.65);
        featheredAlpha[p] = finalA < 20 ? 0 : finalA;
      }
    }
  }

  // =========================================================================
  // STEP 3: 边缘颜色去污 (Color Decontamination)
  // 针对边缘半透明过渡像素，剥离原背景白色成分并向内采样邻近头发/衣物像素重着色
  // =========================================================================
  const [bgR, bgG, bgB] = bgRgb;
  const isBlueBg = bgB > bgR + 20 && bgB > bgG + 20;
  const isRedBg = bgR > bgG + 20 && bgR > bgB + 20;
  const MAX_BAND_DIST = 18.0;

  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    const finalAlpha = featheredAlpha[p];
    clonedData[i + 3] = finalAlpha;
    if (finalAlpha === 0) continue;

    const dist = distToBg[p];
    if (dist > MAX_BAND_DIST) continue;

    let r = clonedData[i];
    let g = clonedData[i + 1];
    let b = clonedData[i + 2];

    const isSkin = isSkinTonePixel(r, g, b);
    if (isSkin) continue;

    const alphaNorm = finalAlpha / 255;

    // -----------------------------------------------------------------------
    // 3A. Strip White Background Halo + Sample Inward Neighbor Hair/Cloth Color
    //     on semi-transparent & outer edge pixels (dist <= 6px or alpha < 245)
    // -----------------------------------------------------------------------
    if (dist <= 6.0 || finalAlpha < 245) {
      // Unmix white component (255, 255, 255) and sampled bgRgb component from semi-transparent pixel:
      // Observed C = alpha * F + (1 - alpha) * Bg  =>  F = (C - (1 - alpha) * Bg) / alpha
      const effA = Math.max(0.22, Math.min(0.92, alphaNorm * 0.85));
      // Blend reference background between pure white (255,255,255) and sampled corner background
      const refBgR = Math.round(255 * 0.55 + bgR * 0.45);
      const refBgG = Math.round(255 * 0.55 + bgG * 0.45);
      const refBgB = Math.round(255 * 0.55 + bgB * 0.45);

      const unmixR = Math.max(0, Math.min(255, (r - (1 - effA) * refBgR) / effA));
      const unmixG = Math.max(0, Math.min(255, (g - (1 - effA) * refBgG) / effA));
      const unmixB = Math.max(0, Math.min(255, (b - (1 - effA) * refBgB) / effA));

      // Check how much whiter/brighter this edge pixel is compared to its nearest interior hair/cloth pixel
      const nearIdx = nearestInterior[p];
      if (nearIdx >= 0 && distToInterior[p] <= 10.0) {
        const ni = nearIdx * 4;
        const inR = clonedData[ni];
        const inG = clonedData[ni + 1];
        const inB = clonedData[ni + 2];

        const edgeLuma = 0.299 * r + 0.587 * g + 0.114 * b;
        const inLuma = 0.299 * inR + 0.587 * inG + 0.114 * inB;

        // If the edge pixel is brighter than the interior (e.g. hair strand contaminated by white background)
        // or semi-transparent, replace/blend toward the interior hair/cloth color
        const lumaExcess = Math.max(0, (edgeLuma - inLuma) / 140);
        const translucencyWeight = 1 - alphaNorm;
        const edgeProximityWeight = Math.max(0, 1 - dist / 6.0);

        const inwardRecolorWeight = Math.min(
          0.92,
          strength * Math.max(translucencyWeight * 0.95, lumaExcess * 0.85, edgeProximityWeight * 0.65)
        );

        // First move toward unmixed color, then re-color with nearest interior hair/clothing pixel
        const midR = r * (1 - strength * 0.6) + unmixR * (strength * 0.6);
        const midG = g * (1 - strength * 0.6) + unmixG * (strength * 0.6);
        const midB = b * (1 - strength * 0.6) + unmixB * (strength * 0.6);

        r = Math.round(midR * (1 - inwardRecolorWeight) + inR * inwardRecolorWeight);
        g = Math.round(midG * (1 - inwardRecolorWeight) + inG * inwardRecolorWeight);
        b = Math.round(midB * (1 - inwardRecolorWeight) + inB * inwardRecolorWeight);
      } else {
        const unmixWeight = Math.min(0.88, strength * (1 - alphaNorm * 0.5));
        r = Math.round(r * (1 - unmixWeight) + unmixR * unmixWeight);
        g = Math.round(g * (1 - unmixWeight) + unmixG * unmixWeight);
        b = Math.round(b * (1 - unmixWeight) + unmixB * unmixWeight);
      }
    }

    // -----------------------------------------------------------------------
    // 3B. Deep 18px Blue / Red Backdrop Spill Neutralization for Dark Hair
    // -----------------------------------------------------------------------
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

    // Only intercept local static model/WASM requests under `/imgly-assets/`
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
 * Checks whether the local AI model chunks are already cached in Cache API or IndexedDB
 * so we can display accurate first-load vs. cached-instant status messages.
 */
async function checkIsModelCachedLocally(localPublicPath: string): Promise<boolean> {
  if (hasCachedAllModelAssets) return true;
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(MODEL_CACHE_NAME);
      const keys = await cache.keys();
      // `/models/small` has 11 chunks + 3 WASM chunks = 14+ cached entries
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

  // Decode the low-res AI output (which carries the predicted alpha mask in its A channel)
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

  // 1. Draw the original high-res photo onto a full-resolution canvas to get crisp RGB pixels
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

  // 2. Smoothly upscale the low-res AI alpha mask to (origW × origH) with high-quality interpolation
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

  // 3. Apply the upscaled alpha channel onto the original high-definition RGB pixels
  const totalBytes = hdPixels.length;
  for (let i = 3; i < totalBytes; i += 4) {
    hdPixels[i] = upscaledMaskData[i];
  }

  return hdImageData;
}

/**
 * Unified AI Portrait Cutout Pipeline:
 *
 * 1. Loads lightweight quantized model (`model: 'small'` / `isnet_quint8`) & WASM strictly
 *    from local static path `${window.location.origin}/imgly-assets/` with persistent
 *    Cache API / IndexedDB caching (zero requests to slow overseas CDNs).
 * 2. Downscales the input image via offscreen Canvas to max edge <= 768px (640px on mobile)
 *    for fast inference, then smoothly upscales the resulting Alpha mask back to the original
 *    high-resolution photo dimensions.
 * 3. Runs the 3-step `cleanEdgeSpill` post-processing pipeline (low-confidence noise < 0.15 zeroing,
 *    1~2px edge erosion + feathering, and edge color decontamination).
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
    percent: 5,
    stageLabel: isCached
      ? '已命中本机持久化模型缓存，正在快速初始化引擎…'
      : '首次加载本地轻量 AI 模型（加载后自动永久缓存）…',
  });

  const { removeBackground } = await import('@imgly/background-removal');

  // Ensure we have an HTMLImageElement/HTMLCanvasElement for downscaling & HD compositing
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

  // Downscale image to max long edge <= 768px (512px~640px on mobile screens) before AI inference
  const isMobileViewport =
    typeof window !== 'undefined' && (window.innerWidth < 768 || navigator.maxTouchPoints > 1);
  const maxInferenceEdge = isMobileViewport ? 640 : 768;

  onProgress?.({
    percent: 10,
    stageLabel: `正在生成 ${maxInferenceEdge}px 轻量推理图以加速手机端运行…`,
  });

  const { blob: downscaledBlob } = await createDownscaledInferenceBlob(
    sourceElement,
    maxInferenceEdge
  );

  const progressMap = new Map<string, { current: number; total: number }>();

  let lowResResultBlob: Blob;
  try {
    lowResResultBlob = await removeBackground(downscaledBlob, {
      publicPath: localPublicPath,
      model: 'small', // Quantized lightweight ISNet (`isnet_quint8`, ~42MB)
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
            stageLabel: '正在执行 AI 人像分割推理…',
          });
          return;
        }

        if (sumTotal > 0) {
          const downloadPct = Math.min(100, Math.round((sumCurrent / sumTotal) * 100));
          const mappedPct = Math.max(12, Math.min(82, Math.round((sumCurrent / sumTotal) * 70) + 12));
          const mbLoaded = (sumCurrent / 1024 / 1024).toFixed(1);
          const mbTotal = (sumTotal / 1024 / 1024).toFixed(1);

          const stageLabel = isCached
            ? `正在从本机缓存读取 AI 模型 (${downloadPct}%)…`
            : key.includes('wasm')
              ? `首次加载本地 WASM 推理内核 (${mbLoaded}/${mbTotal} MB，将自动缓存)…`
              : `首次加载本地轻量人像模型 (${mbLoaded}/${mbTotal} MB，${downloadPct}%)…`;

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
    percent: 93,
    stageLabel: '正在将 Alpha 遮罩平滑放大至原图高清尺寸并清理发丝白边…',
  });

  // Upscale low-res alpha mask back to original high-definition photo dimensions
  const rawCutoutImageData = await compositeUpscaledMaskWithOriginalHd(
    lowResResultBlob,
    sourceElement
  );

  const sampledBgRgb = sampleDominantBackgroundRgb(sourceElement);

  // Run 3-step alpha & color post-processing (noise < 0.15 zeroing, 1~2px erode & feather, color decontamination)
  const foregroundCanvas = cleanEdgeSpill(rawCutoutImageData, sampledBgRgb, defringeStrength);

  // Encode raw high-res cutout to PNG blob so IndexedDB history cache stores the high-res cutout
  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = rawCutoutImageData.width;
  rawCanvas.height = rawCutoutImageData.height;
  const rawCtx = rawCanvas.getContext('2d');
  if (rawCtx) {
    rawCtx.putImageData(rawCutoutImageData, 0, 0);
  }
  const hdRawBlob = rawCtx ? await canvasToBlob(rawCanvas, 'image/png') : lowResResultBlob;

  onProgress?.({ percent: 100, stageLabel: '高清 AI 抠图与发丝去白边完成' });

  return {
    rawCutoutImageData,
    foregroundCanvas,
    sampledBgRgb,
    blob: hdRawBlob,
  };
}
