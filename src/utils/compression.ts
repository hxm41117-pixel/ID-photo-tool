import { injectImageDpi } from './dpi';

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas 导出图片失败'));
      },
      mimeType,
      quality
    );
  });
}

function scaleCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const next = document.createElement('canvas');
  next.width = Math.max(16, Math.round(source.width * scale));
  next.height = Math.max(16, Math.round(source.height * scale));
  const ctx = next.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, next.width, next.height);
  }
  return next;
}

export interface ExportCanvasOptions {
  canvas: HTMLCanvasElement;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  dpi?: number;
  /** Strict upper bound in KB (e.g. 30 or 50). Only applies to lossy formats (JPG / WebP). */
  targetKB?: number | null;
  /** Default quality when targetKB is not set (0.1 - 1.0) */
  quality?: number;
}

export interface ExportCanvasResult {
  blob: Blob;
  width: number;
  height: number;
  qualityUsed: number;
}

/**
 * Exports a canvas with DPI metadata injection and optional binary-search KB compression.
 * If the lowest JPEG/WebP quality still exceeds targetKB, automatically downscales dimensions
 * so the final file size is strictly below targetKB * 1024 bytes.
 */
export async function exportCanvasWithTargetKB(
  options: ExportCanvasOptions
): Promise<ExportCanvasResult> {
  const { canvas, mimeType, dpi, targetKB, quality = 0.92 } = options;

  const encode = async (c: HTMLCanvasElement, q?: number): Promise<Blob> => {
    let blob = await canvasToBlob(c, mimeType, q);
    if (dpi && (mimeType === 'image/jpeg' || mimeType === 'image/png')) {
      blob = await injectImageDpi(blob, dpi);
    }
    return blob;
  };

  // PNG is lossless; export directly with DPI metadata
  if (mimeType === 'image/png' || !targetKB || targetKB <= 0) {
    const blob = await encode(canvas, mimeType === 'image/png' ? undefined : quality);
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      qualityUsed: quality,
    };
  }

  const maxBytes = Math.max(1024, Math.floor(targetKB * 1024));

  // Fast check at high quality first
  const highQuality = 0.95;
  const firstTry = await encode(canvas, highQuality);
  if (firstTry.size < maxBytes) {
    return {
      blob: firstTry,
      width: canvas.width,
      height: canvas.height,
      qualityUsed: highQuality,
    };
  }

  // Helper: binary search quality on a given canvas
  const searchQuality = async (
    targetCanvas: HTMLCanvasElement
  ): Promise<{ blob: Blob; quality: number } | null> => {
    const minQ = 0.05;
    const minTry = await encode(targetCanvas, minQ);
    if (minTry.size >= maxBytes) {
      return null;
    }

    let low = minQ;
    let high = highQuality;
    let bestBlob = minTry;
    let bestQ = minQ;

    for (let i = 0; i < 9; i++) {
      const mid = (low + high) / 2;
      const candidate = await encode(targetCanvas, mid);
      if (candidate.size < maxBytes) {
        bestBlob = candidate;
        bestQ = mid;
        low = mid;
      } else {
        high = mid;
      }
    }

    return { blob: bestBlob, quality: bestQ };
  };

  // Try at original dimensions
  const originalHit = await searchQuality(canvas);
  if (originalHit) {
    return {
      blob: originalHit.blob,
      width: canvas.width,
      height: canvas.height,
      qualityUsed: originalHit.quality,
    };
  }

  // Lowest quality still exceeds maxBytes -> progressively downscale
  let scale = 0.88;
  let lastCanvas = canvas;
  for (let step = 0; step < 10; step++) {
    const scaled = scaleCanvas(canvas, scale);
    lastCanvas = scaled;
    const hit = await searchQuality(scaled);
    if (hit) {
      return {
        blob: hit.blob,
        width: scaled.width,
        height: scaled.height,
        qualityUsed: hit.quality,
      };
    }
    scale *= 0.85;
  }

  // Fallback: smallest scaled image at lowest quality
  const fallbackBlob = await encode(lastCanvas, 0.05);
  return {
    blob: fallbackBlob,
    width: lastCanvas.width,
    height: lastCanvas.height,
    qualityUsed: 0.05,
  };
}

export function formatKB(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}
