import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowRight,
  Download,
  FileImage,
  Info,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { ConverterFormat } from '../types';
import { formatKB } from '../utils/compression';
import { ConvertedImageResult, convertImageFile } from '../utils/converter';
import { downloadFilesAsZip, triggerBlobDownload } from '../utils/download';

export function FormatConverter() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [targetFormat, setTargetFormat] = useState<ConverterFormat>('image/jpeg');
  const [targetKBInput, setTargetKBInput] = useState<string>('');
  const [isConverting, setIsConverting] = useState<boolean>(false);
  const [results, setResults] = useState<ConvertedImageResult[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      results.forEach((r) => URL.revokeObjectURL(r.url));
    };
  }, [results]);

  const appendFiles = useCallback((incoming: FileList | File[]) => {
    const valid = Array.from(incoming).filter((file) => {
      const lower = file.name.toLowerCase();
      return (
        file.type.startsWith('image/') ||
        lower.endsWith('.heic') ||
        lower.endsWith('.heif')
      );
    });
    if (valid.length === 0) return;
    setErrorMsg(null);
    setSourceFiles((prev) => [...prev, ...valid]);
  }, []);

  // Global Ctrl+V clipboard paste support
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pasted: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) pasted.push(f);
        }
      }
      if (pasted.length > 0) {
        e.preventDefault();
        appendFiles(pasted);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [appendFiles]);

  const handleConvertAll = async () => {
    if (sourceFiles.length === 0) return;
    try {
      setErrorMsg(null);
      setIsConverting(true);

      const parsedKB = parseFloat(targetKBInput);
      const targetKB = Number.isFinite(parsedKB) && parsedKB > 0 ? parsedKB : null;

      // Default high quality (0.95) when keeping original quality; binary search when targetKB is set
      const defaultQuality = 0.95;

      const convertedList: ConvertedImageResult[] = [];
      for (const file of sourceFiles) {
        const res = await convertImageFile(file, targetFormat, defaultQuality, targetKB);
        convertedList.push(res);
      }

      setResults((prev) => {
        prev.forEach((r) => URL.revokeObjectURL(r.url));
        return convertedList;
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '图片格式转换失败，请检查文件格式');
    } finally {
      setIsConverting(false);
    }
  };

  const handleClearAll = () => {
    setSourceFiles([]);
    setResults((prev) => {
      prev.forEach((r) => URL.revokeObjectURL(r.url));
      return [];
    });
    setErrorMsg(null);
  };

  const handleZipAll = async () => {
    if (results.length === 0) return;
    await downloadFilesAsZip(
      results.map((r) => ({ fileName: r.outputName, blob: r.blob })),
      `图片格式转换_${results.length}张.zip`
    );
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files?.length) {
      appendFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="space-y-5">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.heic,.heif"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) appendFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {errorMsg && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs sm:text-sm rounded-xl px-4 py-3 flex items-center justify-between gap-3">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-rose-500 hover:text-rose-800 font-medium shrink-0"
          >
            关闭
          </button>
        </div>
      )}

      {/* Upload Dropzone Card */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`bg-white rounded-2xl border-2 border-dashed transition-all cursor-pointer p-7 sm:p-10 text-center ${
          isDragOver
            ? 'border-slate-900 bg-slate-50'
            : 'border-slate-200 hover:border-slate-400'
        }`}
      >
        <div className="w-12 h-12 mx-auto rounded-2xl bg-slate-100 text-slate-700 flex items-center justify-center mb-3">
          <Upload className="w-6 h-6" />
        </div>
        <h2 className="text-sm sm:text-base font-semibold text-slate-900">
          点击选择或拖拽多张图片至此（支持批量转换）
        </h2>
        <p className="text-xs text-slate-500 mt-1.5">
          兼容 JPG、PNG、WebP 与苹果 HEIC 照片 · 本地离线转换，不上传任何文件
        </p>
      </div>

      {/* Simplified 2-Parameter Settings & File Queue */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 1. Target Format */}
          <div>
            <label className="block text-xs font-semibold text-slate-900 mb-2">
              目标格式
            </label>
            <div className="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-xl">
              {(
                [
                  { id: 'image/jpeg', label: 'JPG' },
                  { id: 'image/png', label: 'PNG' },
                  { id: 'image/webp', label: 'WebP' },
                ] as const
              ).map((fmt) => (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => setTargetFormat(fmt.id)}
                  className={`py-2 rounded-lg text-xs font-medium transition-all ${
                    targetFormat === fmt.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {fmt.label}
                </button>
              ))}
            </div>
            {targetFormat === 'image/jpeg' && (
              <p className="text-[11px] text-slate-500 mt-1.5 flex items-center gap-1">
                <Info className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                透明图转 JPG 自动底层填充纯白底，避免发黑
              </p>
            )}
          </div>

          {/* 2. File Size Control (Keep Original Quality or Target KB Limit) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-semibold text-slate-900">
                文件体积控制
              </label>
              <span className="text-[11px] text-slate-500">
                {targetFormat === 'image/png'
                  ? 'PNG 为无损格式'
                  : targetKBInput
                    ? `自动压缩至 ≤ ${targetKBInput} KB`
                    : '当前：保持原画质'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={10}
                max={10000}
                disabled={targetFormat === 'image/png'}
                placeholder="默认保持原画质，或输入目标 KB 上限"
                value={targetKBInput}
                onChange={(e) => setTargetKBInput(e.target.value)}
                className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 disabled:bg-slate-50 disabled:text-slate-400"
              />
              <button
                type="button"
                disabled={targetFormat === 'image/png'}
                onClick={() => setTargetKBInput('')}
                className={`px-2.5 py-2 rounded-xl border text-[11px] font-medium transition-colors shrink-0 disabled:opacity-40 ${
                  targetKBInput === ''
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                原画质
              </button>
              {['50', '100', '200'].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={targetFormat === 'image/png'}
                  onClick={() =>
                    setTargetKBInput((prev) => (prev === preset ? '' : preset))
                  }
                  className={`px-2 py-2 rounded-xl border text-[11px] font-medium transition-colors shrink-0 disabled:opacity-40 ${
                    targetKBInput === preset
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  ≤{preset}K
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Pending files list */}
        {sourceFiles.length > 0 && (
          <div className="pt-3 border-t border-slate-100 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700">
                待转换队列（已选 {sourceFiles.length} 张）
              </span>
              <button
                type="button"
                onClick={handleClearAll}
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                清空列表
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {sourceFiles.map((file, idx) => (
                <div
                  key={`${file.name}_${idx}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-700 max-w-full"
                >
                  <FileImage className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="truncate max-w-[160px]">{file.name}</span>
                  <span className="text-[11px] text-slate-400 font-mono">
                    {formatKB(file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setSourceFiles((prev) => prev.filter((_, i) => i !== idx))
                    }
                    className="ml-0.5 text-slate-400 hover:text-rose-600"
                    aria-label="移除此文件"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              disabled={isConverting}
              onClick={handleConvertAll}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 active:scale-[0.99] transition-all disabled:opacity-60"
            >
              {isConverting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  正在本地转换…
                </>
              ) : (
                <>开始转换 ({sourceFiles.length} 张)</>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Converted Results Grid */}
      {results.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm sm:text-base font-semibold text-slate-900">
                转换完成（共 {results.length} 张）
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                手机端可长按卡片图片直接保存到相册
              </p>
            </div>
            {results.length > 1 && (
              <button
                type="button"
                onClick={handleZipAll}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 active:scale-[0.98] transition-all"
              >
                <Archive className="w-3.5 h-3.5" />
                一键打包下载 (.zip)
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {results.map((item) => {
              const savedPct = Math.round(
                ((item.originalSize - item.outputSize) / Math.max(1, item.originalSize)) * 100
              );
              return (
                <div
                  key={item.id}
                  className="bg-slate-50 rounded-xl border border-slate-200/70 p-3 flex flex-col justify-between gap-3"
                >
                  <div className="rounded-lg overflow-hidden border border-slate-200 bg-checkerboard aspect-[4/3] flex items-center justify-center">
                    <img
                      src={item.url}
                      alt={item.outputName}
                      className="max-w-full max-h-full object-contain block"
                    />
                  </div>

                  <div className="space-y-2">
                    <div
                      className="text-xs font-semibold text-slate-900 truncate"
                      title={item.outputName}
                    >
                      {item.outputName}
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                      <span className="inline-flex items-center gap-1">
                        {formatKB(item.originalSize)}
                        <ArrowRight className="w-3 h-3 text-slate-400" />
                        <strong className="text-slate-900">{formatKB(item.outputSize)}</strong>
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded-md font-medium ${
                          savedPct >= 0
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-200/80 text-slate-700'
                        }`}
                      >
                        {savedPct >= 0 ? `-${savedPct}%` : `+${Math.abs(savedPct)}%`}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono">
                      {item.width} × {item.height} px
                    </div>
                    <button
                      type="button"
                      onClick={() => triggerBlobDownload(item.blob, item.outputName)}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-800 hover:bg-slate-100 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      保存图片
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
