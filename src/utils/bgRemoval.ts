import { refinePortraitMatte } from './portraitMatte';
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
  /** Final Transparent Foreground Canvas after color-guided matting refinement (`cleanEdgeSpill`) */
  foregroundCanvas: HTMLCanvasElement;
  /** Sampled average background RGB from the original photo corners */
  sampledBgRgb: [number, number, number];
  blob: Blob;
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

const sourceAlphaLimits = new WeakMap<ImageData, Uint8Array>();

export function cleanEdgeSpill(
  raw: ImageData, bgRgb: [number, number, number], strengthPercent = 80, hasSourceRgb = true
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = raw.width;
  canvas.height = raw.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建前景画布');
  const image = ctx.createImageData(raw.width, raw.height);
  image.data.set(refinePortraitMatte(raw.data, raw.width, raw.height, bgRgb, strengthPercent, hasSourceRgb));
  const limits = sourceAlphaLimits.get(raw);
  if (limits) {
    for (let p = 0; p < limits.length; p++) {
      const i = 4 * p + 3;
      image.data[i] = Math.min(image.data[i], limits[p]);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
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

const MODEL_CACHE_NAME = 'id-photo-ai-model-assets-v2';
const MODEL_IDB_NAME = 'id_photo_ai_assets_db_v2';
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
 * so all FP16 model chunks and WASM binaries are persisted
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
        model: 'medium',
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
      const firstChunkHash = map?.['/models/medium']?.chunks?.[0]?.hash;
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
 * `maxInferenceEdge` before sending to AI inference.
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
export async function compositeUpscaledMaskWithOriginalHd(
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
  let limits: Uint8Array | undefined;
  for (let i = 3; i < totalBytes; i += 4) {
    if (hdPixels[i] < 255) {
      limits ??= new Uint8Array(totalBytes / 4).fill(255);
      limits[(i - 3) / 4] = hdPixels[i];
    }
    hdPixels[i] = Math.min(hdPixels[i], upscaledMaskData[i]);
  }

  if (limits) sourceAlphaLimits.set(hdImageData, limits);
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
  // Share the pending asset warmup with an immediate first upload.
  await preloadPromise;
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

  const maxInferenceEdge = 1024; // Native IS-Net input resolution.
  const { blob: downscaledBlob } = await createDownscaledInferenceBlob(
    sourceElement,
    maxInferenceEdge
  );

  const progressMap = new Map<string, { current: number; total: number }>();

  let lowResResultBlob: Blob;
  try {
    lowResResultBlob = await removeBackground(downscaledBlob, {
      publicPath: localPublicPath,
      model: 'medium',
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
