import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { TransformState } from '../types';

interface PhotoCanvasEditorProps {
  image: HTMLCanvasElement | HTMLImageElement;
  renderVersion?: number;
  targetWidth: number;
  targetHeight: number;
  bgHex: string;
  transform: TransformState;
  onTransformChange: (next: TransformState) => void;
  /** Compact mode for mobile sticky top preview stage (36vh~40vh) */
  compact?: boolean;
}

export function PhotoCanvasEditor({
  image,
  renderVersion = 0,
  targetWidth,
  targetHeight,
  bgHex,
  transform,
  onTransformChange,
  compact = false,
}: PhotoCanvasEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showGuide, setShowGuide] = useState(true);

  const dragStateRef = useRef<{
    isDragging: boolean;
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
    pinchStartDist: number | null;
    pinchStartScale: number;
  }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    pinchStartDist: null,
    pinchStartScale: 1,
  });

  // Compute display box size preserving aspect ratio
  const aspectRatio = targetWidth / Math.max(1, targetHeight);
  const maxBoxHeight = compact ? 196 : 360;
  const maxBoxWidth = compact ? 168 : 300;
  let displayW = maxBoxHeight * aspectRatio;
  let displayH = maxBoxHeight;
  if (displayW > maxBoxWidth) {
    displayW = maxBoxWidth;
    displayH = maxBoxWidth / aspectRatio;
  }

  // Draw crisp retina preview on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderW = Math.round(displayW * dpr);
    const renderH = Math.round(displayH * dpr);
    if (canvas.width !== renderW || canvas.height !== renderH) {
      canvas.width = renderW;
      canvas.height = renderH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, renderW, renderH);
    if (bgHex !== 'transparent') {
      ctx.fillStyle = bgHex;
      ctx.fillRect(0, 0, renderW, renderH);
    }

    const imgW =
      image instanceof HTMLImageElement ? image.naturalWidth || image.width : image.width;
    const imgH =
      image instanceof HTMLImageElement ? image.naturalHeight || image.height : image.height;
    const coverScale = Math.max(renderW / imgW, renderH / imgH);
    const drawW = imgW * coverScale * transform.scale;
    const drawH = imgH * coverScale * transform.scale;

    const cx = renderW / 2 + transform.offsetX * renderW;
    const cy = renderH / 2 + transform.offsetY * renderH;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
  }, [image, renderVersion, bgHex, transform, displayW, displayH]);

  // Non-passive wheel listener for smooth PC zoom without scrolling the page
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.07 : 0.93;
      const nextScale = Math.max(0.5, Math.min(3.0, Number((transform.scale * factor).toFixed(3))));
      onTransformChange({ ...transform, scale: nextScale });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [transform, onTransformChange]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current.isDragging = true;
    dragStateRef.current.startX = e.clientX;
    dragStateRef.current.startY = e.clientY;
    dragStateRef.current.startOffsetX = transform.offsetX;
    dragStateRef.current.startOffsetY = transform.offsetY;
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStateRef.current.isDragging) return;
      const dx = (e.clientX - dragStateRef.current.startX) / displayW;
      const dy = (e.clientY - dragStateRef.current.startY) / displayH;
      onTransformChange({
        ...transform,
        offsetX: Math.max(-1.2, Math.min(1.2, dragStateRef.current.startOffsetX + dx)),
        offsetY: Math.max(-1.2, Math.min(1.2, dragStateRef.current.startOffsetY + dy)),
      });
    };
    const handleMouseUp = () => {
      dragStateRef.current.isDragging = false;
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [displayW, displayH, transform, onTransformChange]);

  const getTouchDist = (t1: React.Touch, t2: React.Touch) => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      dragStateRef.current.isDragging = true;
      dragStateRef.current.pinchStartDist = null;
      dragStateRef.current.startX = e.touches[0].clientX;
      dragStateRef.current.startY = e.touches[0].clientY;
      dragStateRef.current.startOffsetX = transform.offsetX;
      dragStateRef.current.startOffsetY = transform.offsetY;
    } else if (e.touches.length === 2) {
      dragStateRef.current.isDragging = false;
      dragStateRef.current.pinchStartDist = getTouchDist(e.touches[0], e.touches[1]);
      dragStateRef.current.pinchStartScale = transform.scale;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && dragStateRef.current.isDragging) {
      const dx = (e.touches[0].clientX - dragStateRef.current.startX) / displayW;
      const dy = (e.touches[0].clientY - dragStateRef.current.startY) / displayH;
      onTransformChange({
        ...transform,
        offsetX: Math.max(-1.2, Math.min(1.2, dragStateRef.current.startOffsetX + dx)),
        offsetY: Math.max(-1.2, Math.min(1.2, dragStateRef.current.startOffsetY + dy)),
      });
    } else if (e.touches.length === 2 && dragStateRef.current.pinchStartDist) {
      const dist = getTouchDist(e.touches[0], e.touches[1]);
      const ratio = dist / dragStateRef.current.pinchStartDist;
      const nextScale = Math.max(
        0.5,
        Math.min(3.0, Number((dragStateRef.current.pinchStartScale * ratio).toFixed(3)))
      );
      onTransformChange({ ...transform, scale: nextScale });
    }
  };

  const handleTouchEnd = () => {
    dragStateRef.current.isDragging = false;
    dragStateRef.current.pinchStartDist = null;
  };

  const handleReset = () => {
    onTransformChange({ scale: 1, offsetX: 0, offsetY: 0 });
  };

  return (
    <div className="flex flex-col items-center w-full">
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ width: `${Math.round(displayW)}px`, height: `${Math.round(displayH)}px` }}
        className={`relative rounded-xl overflow-hidden border border-slate-200 shadow-inner select-none touch-none cursor-grab active:cursor-grabbing ${
          bgHex === 'transparent' ? 'bg-checkerboard' : 'bg-white'
        }`}
      >
        <canvas ref={canvasRef} className="w-full h-full block" />

        {/* Semi-transparent head-and-shoulders reference guide */}
        {showGuide && (
          <svg
            viewBox="0 0 200 280"
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full pointer-events-none"
          >
            <line
              x1="14"
              y1="28"
              x2="186"
              y2="28"
              stroke="rgba(15, 23, 42, 0.45)"
              strokeWidth="1.2"
              strokeDasharray="4 4"
            />
            <line
              x1="14"
              y1="29"
              x2="186"
              y2="29"
              stroke="rgba(255, 255, 255, 0.65)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <text
              x="100"
              y="22"
              textAnchor="middle"
              fill="rgba(15, 23, 42, 0.55)"
              fontSize="9"
              fontWeight="500"
            >
              头顶留白线
            </text>

            <ellipse
              cx="100"
              cy="104"
              rx="42"
              ry="56"
              fill="none"
              stroke="rgba(255, 255, 255, 0.8)"
              strokeWidth="1.4"
              strokeDasharray="5 4"
            />
            <ellipse
              cx="100"
              cy="104"
              rx="42"
              ry="56"
              fill="none"
              stroke="rgba(15, 23, 42, 0.35)"
              strokeWidth="1"
              strokeDasharray="5 4"
            />

            <path
              d="M 18 258 C 24 210, 56 186, 100 186 C 144 186, 176 210, 182 258"
              fill="none"
              stroke="rgba(255, 255, 255, 0.82)"
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
            <path
              d="M 18 258 C 24 210, 56 186, 100 186 C 144 186, 176 210, 182 258"
              fill="none"
              stroke="rgba(15, 23, 42, 0.35)"
              strokeWidth="1"
              strokeDasharray="5 4"
            />
            <line
              x1="14"
              y1="208"
              x2="186"
              y2="208"
              stroke="rgba(15, 23, 42, 0.35)"
              strokeWidth="1"
              strokeDasharray="3 4"
            />
            <text
              x="178"
              y="203"
              textAnchor="end"
              fill="rgba(15, 23, 42, 0.55)"
              fontSize="9"
              fontWeight="500"
            >
              肩线
            </text>
          </svg>
        )}
      </div>

      {/* Framing controls: ultra-compact single row on mobile sticky preview, standard 2-row on PC */}
      {compact ? (
        <div className="w-full max-w-[320px] mt-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              onTransformChange({
                ...transform,
                scale: Math.max(0.5, Number((transform.scale - 0.08).toFixed(2))),
              })
            }
            aria-label="缩小"
            className="p-1 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <input
            type="range"
            min={0.5}
            max={2.6}
            step={0.01}
            value={transform.scale}
            onChange={(e) =>
              onTransformChange({ ...transform, scale: parseFloat(e.target.value) })
            }
            className="flex-1 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
          />
          <button
            type="button"
            onClick={() =>
              onTransformChange({
                ...transform,
                scale: Math.min(2.6, Number((transform.scale + 0.08).toFixed(2))),
              })
            }
            aria-label="放大"
            className="p-1 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setShowGuide((v) => !v)}
            className="px-2 py-1 rounded-lg bg-slate-100 text-[11px] text-slate-600 font-medium shrink-0"
          >
            {showGuide ? '隐藏线' : '参考线'}
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="px-2 py-1 rounded-lg bg-slate-100 text-[11px] text-slate-600 font-medium shrink-0"
          >
            重置
          </button>
        </div>
      ) : (
        <div className="w-full max-w-[300px] mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onTransformChange({
                  ...transform,
                  scale: Math.max(0.5, Number((transform.scale - 0.08).toFixed(2))),
                })
              }
              aria-label="缩小"
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <input
              type="range"
              min={0.5}
              max={2.6}
              step={0.01}
              value={transform.scale}
              onChange={(e) =>
                onTransformChange({ ...transform, scale: parseFloat(e.target.value) })
              }
              className="flex-1 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
            />
            <button
              type="button"
              onClick={() =>
                onTransformChange({
                  ...transform,
                  scale: Math.min(2.6, Number((transform.scale + 0.08).toFixed(2))),
                })
              }
              aria-label="放大"
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>支持拖拽定位 · 滚轮/双指缩放</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowGuide((v) => !v)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-slate-100 text-slate-600 transition-colors"
                title="切换头肩参考线"
              >
                {showGuide ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                <span>参考线</span>
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-slate-100 text-slate-600 transition-colors"
                title="重置构图"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>重置</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
