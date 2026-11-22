import { ConverterFormat } from '../types';
import { exportCanvasWithTargetKB } from './compression';

export interface ConvertedImageResult {
  id: string;
  originalName: string;
  outputName: string;
  originalSize: number;
  outputSize: number;
  width: number;
  height: number;
  url: string;
  blob: Blob;
  format: ConverterFormat;
}

function isHeicFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.heic') ||
    name.endsWith('.heif') ||
    file.type === 'image/heic' ||
    file.type === 'image/heif'
  );
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败，请确认文件未损坏'));
    };
    img.src = url;
  });
}

function replaceExtension(fileName: string, format: ConverterFormat): string {
  const extMap: Record<ConverterFormat, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  const base = fileName.replace(/\.[^/.]+$/, '') || 'image';
  return `${base}.${extMap[format]}`;
}

export async function convertImageFile(
  file: File,
  targetFormat: ConverterFormat,
  quality: number,
  targetKB?: number | null
): Promise<ConvertedImageResult> {
  let sourceBlob: Blob = file;

  // Decode Apple HEIC / HEIF on demand
  if (isHeicFile(file)) {
    const heic2anyModule = await import('heic2any');
    const heic2any = heic2anyModule.default || heic2anyModule;
    const converted = await heic2any({
      blob: file,
      toType: 'image/png',
      quality: 1,
    });
    sourceBlob = Array.isArray(converted) ? converted[0] : converted;
  }

  const img = await loadImageFromBlob(sourceBlob);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建转换画布');

  // Critical: Fill pure white background before drawing when exporting to JPEG,
  // preventing transparent PNG/WebP areas from turning solid black.
  if (targetFormat === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  const exported = await exportCanvasWithTargetKB({
    canvas,
    mimeType: targetFormat,
    quality,
    targetKB: targetFormat === 'image/png' ? null : targetKB,
  });

  const url = URL.createObjectURL(exported.blob);

  return {
    id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    originalName: file.name,
    outputName: replaceExtension(file.name, targetFormat),
    originalSize: file.size,
    outputSize: exported.blob.size,
    width: exported.width,
    height: exported.height,
    url,
    blob: exported.blob,
    format: targetFormat,
  };
}
