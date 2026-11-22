import { GeneratedPhotoResult, TransformState } from '../types';

/**
 * Renders the cached Transparent Foreground Canvas (or image) onto a brand-new
 * target-sized canvas, filling the pure background color first before drawing
 * the transparent portrait foreground proportionally on top.
 */
export function renderFramedIdPhotoCanvas(
  foregroundSource: HTMLCanvasElement | HTMLImageElement,
  targetWidth: number,
  targetHeight: number,
  bgHex: string,
  transform: TransformState
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建输出画布');

  // 1. Always clear and fill the target solid background color first
  ctx.clearRect(0, 0, targetWidth, targetHeight);
  if (bgHex !== 'transparent') {
    ctx.fillStyle = bgHex;
    ctx.fillRect(0, 0, targetWidth, targetHeight);
  }

  // 2. Proportionally composite the transparent foreground portrait layer on top
  const srcW =
    foregroundSource instanceof HTMLImageElement
      ? foregroundSource.naturalWidth || foregroundSource.width
      : foregroundSource.width;
  const srcH =
    foregroundSource instanceof HTMLImageElement
      ? foregroundSource.naturalHeight || foregroundSource.height
      : foregroundSource.height;

  const coverScale = Math.max(targetWidth / srcW, targetHeight / srcH);
  const drawW = srcW * coverScale * transform.scale;
  const drawH = srcH * coverScale * transform.scale;

  const centerX = targetWidth / 2 + transform.offsetX * targetWidth;
  const centerY = targetHeight / 2 + transform.offsetY * targetHeight;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(foregroundSource, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);

  return canvas;
}

/**
 * Generates a standard 6-inch photo paper canvas (102 × 152 mm = 1205 × 1795 px @ 300 DPI).
 * Arranges 1-inch photos in 8 copies (2×4), 2-inch photos in 4 copies (2×2),
 * or optimal grid for custom sizes, with white margins and light-gray dashed cutting guides.
 */
export function generateSixInchLayoutCanvas(
  photoCanvas: HTMLCanvasElement,
  specLabel: string,
  preferredCount?: number
): { canvas: HTMLCanvasElement; count: number; cols: number; rows: number } {
  const PAPER_W = 1205;
  const PAPER_H = 1795;

  const canvas = document.createElement('canvas');
  canvas.width = PAPER_W;
  canvas.height = PAPER_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建六寸排版画布');

  // Pure white photo paper background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, PAPER_W, PAPER_H);

  const cellW = photoCanvas.width;
  const cellH = photoCanvas.height;

  const minMargin = 32;
  const gap = 22;

  // Determine optimal cols × rows
  let cols = 2;
  let rows = 4;
  let rotate90 = false;

  if (preferredCount === 8) {
    // Check if upright 2×4 fits cleanly
    if (2 * cellW + gap + minMargin * 2 <= PAPER_W && 4 * cellH + 3 * gap + minMargin * 2 <= PAPER_H) {
      cols = 2;
      rows = 4;
      rotate90 = false;
    } else if (
      2 * cellH + gap + minMargin * 2 <= PAPER_W &&
      4 * cellW + 3 * gap + minMargin * 2 <= PAPER_H
    ) {
      cols = 2;
      rows = 4;
      rotate90 = true;
    } else {
      cols = Math.max(1, Math.floor((PAPER_W - minMargin * 2 + gap) / (cellW + gap)));
      rows = Math.max(1, Math.floor((PAPER_H - minMargin * 2 + gap) / (cellH + gap)));
    }
  } else if (preferredCount === 4) {
    if (2 * cellW + gap + minMargin * 2 <= PAPER_W && 2 * cellH + gap + minMargin * 2 <= PAPER_H) {
      cols = 2;
      rows = 2;
      rotate90 = false;
    } else {
      cols = Math.max(1, Math.floor((PAPER_W - minMargin * 2 + gap) / (cellW + gap)));
      rows = Math.max(1, Math.floor((PAPER_H - minMargin * 2 + gap) / (cellH + gap)));
    }
  } else {
    // Dynamic grid for custom sizes
    const uprightCols = Math.max(1, Math.floor((PAPER_W - minMargin * 2 + gap) / (cellW + gap)));
    const uprightRows = Math.max(1, Math.floor((PAPER_H - minMargin * 2 + gap) / (cellH + gap)));
    const rotCols = Math.max(1, Math.floor((PAPER_W - minMargin * 2 + gap) / (cellH + gap)));
    const rotRows = Math.max(1, Math.floor((PAPER_H - minMargin * 2 + gap) / (cellW + gap)));

    if (rotCols * rotRows > uprightCols * uprightRows) {
      cols = rotCols;
      rows = rotRows;
      rotate90 = true;
    } else {
      cols = uprightCols;
      rows = uprightRows;
      rotate90 = false;
    }
  }

  const drawCellW = rotate90 ? cellH : cellW;
  const drawCellH = rotate90 ? cellW : cellH;

  const gridW = cols * drawCellW + (cols - 1) * gap;
  const gridH = rows * drawCellH + (rows - 1) * gap;

  // If custom photo is larger than 6-inch paper, scale it down safely
  const fitScale = Math.min(1, (PAPER_W - minMargin * 2) / gridW, (PAPER_H - minMargin * 2) / gridH);
  const finalCellW = drawCellW * fitScale;
  const finalCellH = drawCellH * fitScale;
  const finalGap = gap * fitScale;
  const finalGridW = cols * finalCellW + (cols - 1) * finalGap;
  const finalGridH = rows * finalCellH + (rows - 1) * finalGap;

  const startX = (PAPER_W - finalGridW) / 2;
  const startY = (PAPER_H - finalGridH) / 2;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = startX + c * (finalCellW + finalGap);
      const y = startY + r * (finalCellH + finalGap);

      ctx.save();
      if (rotate90) {
        ctx.translate(x + finalCellW / 2, y + finalCellH / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(photoCanvas, -finalCellH / 2, -finalCellW / 2, finalCellH, finalCellW);
      } else {
        ctx.drawImage(photoCanvas, x, y, finalCellW, finalCellH);
      }
      ctx.restore();

      // Subtle solid outer border for white-background photos
      ctx.save();
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, finalCellW - 1, finalCellH - 1);
      ctx.restore();
    }
  }

  // Light-gray dashed cutting guide lines along grid boundaries
  ctx.save();
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([8, 6]);

  // Vertical cutting guides
  for (let c = 0; c <= cols; c++) {
    const xLine =
      c === 0
        ? startX - finalGap / 2
        : c === cols
          ? startX + finalGridW + finalGap / 2
          : startX + c * finalCellW + (c - 0.5) * finalGap;
    ctx.beginPath();
    ctx.moveTo(xLine, Math.max(12, startY - 26));
    ctx.lineTo(xLine, Math.min(PAPER_H - 12, startY + finalGridH + 26));
    ctx.stroke();
  }

  // Horizontal cutting guides
  for (let r = 0; r <= rows; r++) {
    const yLine =
      r === 0
        ? startY - finalGap / 2
        : r === rows
          ? startY + finalGridH + finalGap / 2
          : startY + r * finalCellH + (r - 0.5) * finalGap;
    ctx.beginPath();
    ctx.moveTo(Math.max(12, startX - 26), yLine);
    ctx.lineTo(Math.min(PAPER_W - 12, startX + finalGridW + 26), yLine);
    ctx.stroke();
  }
  ctx.restore();

  // Subtle footer caption in bottom margin
  ctx.save();
  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 20px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `6寸冲印排版 (102×152mm · 300DPI) · ${specLabel} × ${cols * rows}张`,
    PAPER_W / 2,
    PAPER_H - 10
  );
  ctx.restore();

  return { canvas, count: cols * rows, cols, rows };
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('目录缩略图加载失败'));
    img.src = url;
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Generates a white "规格对照目录图" index card displaying all batch-generated ID photos
 * with index numbers, spec names, background colors, pixel dimensions, and exact KB sizes.
 */
export async function generateCatalogIndexCanvas(
  items: GeneratedPhotoResult[]
): Promise<HTMLCanvasElement> {
  const CARD_W = 1200;
  const PADDING = 48;
  const HEADER_H = 112;
  const COLS = 3;
  const GAP = 28;
  const TILE_W = Math.floor((CARD_W - PADDING * 2 - GAP * (COLS - 1)) / COLS);
  const TILE_H = 440;
  const ROWS = Math.ceil(items.length / COLS);
  const FOOTER_H = 56;
  const CARD_H = HEADER_H + ROWS * TILE_H + Math.max(0, ROWS - 1) * GAP + PADDING + FOOTER_H;

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建目录索引画布');

  // Clean white card background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Header
  ctx.fillStyle = '#0F172A';
  ctx.font = '600 32px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('证件照全套规格对照目录', PADDING, 62);

  ctx.fillStyle = '#64748B';
  ctx.font = '400 20px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(`共 ${items.length} 张标准照 · 存入手机相册后可按编号快速对照选用`, PADDING, 94);

  // Subtle divider
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PADDING, HEADER_H - 6);
  ctx.lineTo(CARD_W - PADDING, HEADER_H - 6);
  ctx.stroke();

  const loadedImgs = await Promise.all(items.map((item) => loadImageFromUrl(item.url)));

  items.forEach((item, index) => {
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    const x = PADDING + col * (TILE_W + GAP);
    const y = HEADER_H + 16 + row * (TILE_H + GAP);

    // Tile container
    ctx.save();
    drawRoundedRect(ctx, x, y, TILE_W, TILE_H, 18);
    ctx.fillStyle = '#F8FAFC';
    ctx.fill();
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Thumbnail bounding box
    const thumbBoxX = x + 22;
    const thumbBoxY = y + 22;
    const thumbBoxW = TILE_W - 44;
    const thumbBoxH = 266;

    const img = loadedImgs[index];
    const scale = Math.min(thumbBoxW / img.width, thumbBoxH / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const drawX = thumbBoxX + (thumbBoxW - drawW) / 2;
    const drawY = thumbBoxY + (thumbBoxH - drawH) / 2;

    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    // Subtle hairline around thumbnail so pure-white photos stay clearly visible
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.strokeRect(drawX + 0.5, drawY + 0.5, drawW - 1, drawH - 1);

    // Index badge (#01)
    const badgeText = `#${String(index + 1).padStart(2, '0')}`;
    ctx.save();
    drawRoundedRect(ctx, x + 20, y + 306, 52, 28, 8);
    ctx.fillStyle = '#0F172A';
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(badgeText, x + 46, y + 325);
    ctx.restore();

    // Spec + Background color
    ctx.fillStyle = '#0F172A';
    ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`${item.specLabel} · ${item.bgLabel}`, x + 82, y + 327);

    // Pixel dimensions & DPI
    ctx.fillStyle = '#475569';
    ctx.font = '400 18px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`${item.width} × ${item.height} px · ${item.dpi} DPI`, x + 20, y + 368);

    // File size & filename
    const kb = Math.round(item.sizeBytes / 1024);
    ctx.fillStyle = '#64748B';
    ctx.font = '500 18px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`文件大小：${kb} KB`, x + 20, y + 402);
  });

  // Footer note
  ctx.fillStyle = '#94A3B8';
  ctx.font = '400 17px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    '本地浏览器离线生成 · 零上传隐私保护',
    CARD_W / 2,
    CARD_H - 22
  );

  return canvas;
}
