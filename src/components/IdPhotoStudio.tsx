import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  FolderOpen,
  ImagePlus,
  Info,
  Layers,
  Loader2,
  PlusCircle,
  Printer,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import {
  BATCH_FULL_SET_SPECS,
  BG_COLOR_PRESETS,
  BgChannelMode,
  CachedCutout,
  ExportFormat,
  GeneratedPhotoResult,
  SCENE_PRESETS,
  TransformState,
} from '../types';
import {
  aiPortraitCutout,
  AiProgressInfo,
  blobToRawImageData,
  cleanEdgeSpill,
  sampleDominantBackgroundRgb,
} from '../utils/bgRemoval';
import { exportCanvasWithTargetKB, formatKB } from '../utils/compression';
import { deleteCachedCutout, listCachedCutouts, saveCachedCutout } from '../utils/cutoutCache';
import { downloadFilesAsZip, triggerBlobDownload } from '../utils/download';
import {
  generateCatalogIndexCanvas,
  generateSixInchLayoutCanvas,
  renderFramedIdPhotoCanvas,
} from '../utils/layoutAndCatalog';
import { CutoutHistoryBar } from './CutoutHistoryBar';
import { PhotoCanvasEditor } from './PhotoCanvasEditor';
import { WeChatSaveGuide } from './WeChatSaveGuide';

type MobileConsoleTab = 'scene' | 'bg' | 'cutout';

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
      reject(new Error('图片加载失败，请重试'));
    };
    img.src = url;
  });
}

export function IdPhotoStudio() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Immutable raw cutout ImageData & sampled 4-corner background RGB
  const rawCutoutImageDataRef = useRef<ImageData | null>(null);
  const sampledBgRgbRef = useRef<[number, number, number]>([67, 142, 219]);

  const [originalBlob, setOriginalBlob] = useState<Blob | null>(null);
  const [originalImg, setOriginalImg] = useState<HTMLImageElement | null>(null);
  const [foregroundCanvas, setForegroundCanvas] = useState<HTMLCanvasElement | null>(null);
  const [renderVersion, setRenderVersion] = useState<number>(0);

  const [bgMode, setBgMode] = useState<BgChannelMode>('ai');
  const [defringeStrength, setDefringeStrength] = useState<number>(80);
  const defringeStrengthRef = useRef<number>(80);

  // Floating Toast for unmistakable AI cutout & processing feedback (never fail silently)
  const [toast, setToast] = useState<{ type: 'error' | 'success' | 'info'; message: string } | null>(
    null
  );
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback(
    (type: 'error' | 'success' | 'info', message: string, durationMs = 5000) => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      setToast({ type, message });
      toastTimerRef.current = window.setTimeout(() => setToast(null), durationMs);
    },
    []
  );

  // PC: Collapsible cutout settings panel under left preview (collapsed by default)
  const [isCutoutPanelOpen, setIsCutoutPanelOpen] = useState<boolean>(false);

  // Mobile (<768px): Active 3-tab console tab & Result Bottom Sheet Modal state
  const [mobileTab, setMobileTab] = useState<MobileConsoleTab>('scene');
  const [isMobileResultModalOpen, setIsMobileResultModalOpen] = useState<boolean>(false);
  const [mobileModalType, setMobileModalType] = useState<'single' | 'batch'>('single');
  const [isMobileWeChatFoldOpen, setIsMobileWeChatFoldOpen] = useState<boolean>(false);

  // AI cutout progress
  const [isAiRunning, setIsAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState<AiProgressInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // IndexedDB cache
  const [cachedCutouts, setCachedCutouts] = useState<CachedCutout[]>([]);
  const [activeCacheId, setActiveCacheId] = useState<string | null>(null);

  // Step 1: Scene Preset & Custom parameters
  const [sceneId, setSceneId] = useState<string>('general-1-inch');
  const [customW, setCustomW] = useState<number>(295);
  const [customH, setCustomH] = useState<number>(413);
  const [customDpiInput, setCustomDpiInput] = useState<string>('300');
  const [targetKBInput, setTargetKBInput] = useState<string>('');

  // Step 2: Background color & Export format
  const [bgHex, setBgHex] = useState<string>('#FFFFFF');
  const [customHex, setCustomHex] = useState<string>('#6395F9');
  const [format, setFormat] = useState<ExportFormat>('image/jpeg');

  // Framing transform
  const [transform, setTransform] = useState<TransformState>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });

  // Step 3: Output toggles & generation states
  const [enableSixInch, setEnableSixInch] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isBatchGenerating, setIsBatchGenerating] = useState<boolean>(false);

  // Generated outputs
  const [singleResult, setSingleResult] = useState<GeneratedPhotoResult | null>(null);
  const [sixInchResult, setSixInchResult] = useState<GeneratedPhotoResult | null>(null);
  const [batchResults, setBatchResults] = useState<GeneratedPhotoResult[]>([]);
  const [catalogResult, setCatalogResult] = useState<GeneratedPhotoResult | null>(null);

  // PC WeChat guide bottom card
  const [showWeChatGuide, setShowWeChatGuide] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  // Load IndexedDB cache on mount
  useEffect(() => {
    listCachedCutouts().then(setCachedCutouts);
  }, []);

  // Active layer rendered on framing canvas
  const activeCanvasLayer =
    bgMode === 'original' ? originalImg : foregroundCanvas || originalImg;

  // Derived active scene preset
  const activeScene = useMemo(
    () => SCENE_PRESETS.find((s) => s.id === sceneId) || SCENE_PRESETS[0],
    [sceneId]
  );

  const customDpi = useMemo(() => {
    const parsed = parseInt(customDpiInput, 10);
    if (!Number.isFinite(parsed)) return 300;
    return Math.max(72, Math.min(600, parsed));
  }, [customDpiInput]);

  const targetWidth =
    sceneId === 'custom' ? Math.max(50, Math.min(4000, customW || 295)) : activeScene.widthPx;
  const targetHeight =
    sceneId === 'custom' ? Math.max(50, Math.min(4000, customH || 413)) : activeScene.heightPx;
  const targetDpi = sceneId === 'custom' ? customDpi : activeScene.dpi;

  const isTransparentBg = bgHex === 'transparent';
  const effectiveFormat: ExportFormat = isTransparentBg ? 'image/png' : format;

  const activeBgPreset = useMemo(
    () => BG_COLOR_PRESETS.find((b) => b.hex.toLowerCase() === bgHex.toLowerCase()),
    [bgHex]
  );
  const activeBgLabel = activeBgPreset ? activeBgPreset.label : '自定义底';
  const activeBgShortName = activeBgPreset ? activeBgPreset.shortName : '自定义底';

  const parsedTargetKB = useMemo(() => {
    const n = parseFloat(targetKBInput);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [targetKBInput]);

  // Clear generated outputs when switching source photo
  const clearOutputs = useCallback(() => {
    setSingleResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setSixInchResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setBatchResults((prev) => {
      prev.forEach((r) => URL.revokeObjectURL(r.url));
      return [];
    });
    setCatalogResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setIsMobileResultModalOpen(false);
  }, []);

  /**
   * Re-executes `cleanEdgeSpill` from the unmodified `rawCutoutImageDataRef.current`
   * and immediately refreshes `foregroundCanvas` and `PhotoCanvasEditor`.
   */
  const recomputeForegroundFromRaw = useCallback((strengthVal: number) => {
    const rawData = rawCutoutImageDataRef.current;
    if (!rawData) return null;
    const cleanedCanvas = cleanEdgeSpill(rawData, sampledBgRgbRef.current, strengthVal);
    setForegroundCanvas(cleanedCanvas);
    setRenderVersion((v) => v + 1);
    return cleanedCanvas;
  }, []);

  // Real-time Defringe / Contraction slider handler
  const handleDefringeStrengthChange = useCallback(
    (nextStrength: number) => {
      defringeStrengthRef.current = nextStrength;
      setDefringeStrength(nextStrength);
      if (bgMode === 'original') {
        setBgMode('ai');
      }
      recomputeForegroundFromRaw(nextStrength);
    },
    [bgMode, recomputeForegroundFromRaw]
  );

  // Unified Local Offline AI portrait cutout -> saves immutable rawCutoutImageData & runs 3-step cleanEdgeSpill
  const executeAiCutoutForPhoto = useCallback(
    async (targetBlob: Blob, targetImg: HTMLImageElement) => {
      try {
        setErrorMsg(null);
        setIsAiRunning(true);
        setAiProgress({ percent: 5, stageLabel: '正在初始化本地 AI 抠图引擎…' });

        const res = await aiPortraitCutout(
          targetBlob,
          targetImg,
          defringeStrengthRef.current,
          (info) => {
            setAiProgress(info);
          }
        );

        rawCutoutImageDataRef.current = res.rawCutoutImageData;
        sampledBgRgbRef.current = res.sampledBgRgb;
        setForegroundCanvas(res.foregroundCanvas);
        setBgMode('ai');
        setRenderVersion((v) => v + 1);

        const updatedCache = await saveCachedCutout(
          res.blob,
          res.foregroundCanvas.width,
          res.foregroundCanvas.height
        );
        setCachedCutouts(updatedCache);
        if (updatedCache[0]) {
          setActiveCacheId(updatedCache[0].id);
        }
        showToast('success', 'AI 人像抠图与发丝去白边完成', 3000);
        return res.foregroundCanvas;
      } catch (err) {
        const msg =
          err instanceof Error
            ? `智能 AI 抠图失败：${err.message}`
            : '智能 AI 抠图失败，请刷新重试或改用默认浏览器打开';
        setErrorMsg(msg);
        showToast('error', msg, 7000);
        return null;
      } finally {
        setIsAiRunning(false);
        setTimeout(() => setAiProgress(null), 1200);
      }
    },
    [showToast]
  );

  // Import photo and immediately default to AI model automatic portrait cutout
  const handleImportFile = useCallback(
    async (file: File | Blob) => {
      try {
        setErrorMsg(null);
        const img = await loadImageFromBlob(file);
        setOriginalBlob(file);
        setOriginalImg(img);
        setForegroundCanvas(null);
        rawCutoutImageDataRef.current = null;
        sampledBgRgbRef.current = sampleDominantBackgroundRgb(img);
        setActiveCacheId(null);
        setTransform({ scale: 1, offsetX: 0, offsetY: 0 });
        setBgMode('ai');
        setRenderVersion((v) => v + 1);
        clearOutputs();

        await executeAiCutoutForPhoto(file, img);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : '导入图片失败');
      }
    },
    [clearOutputs, executeAiCutoutForPhoto]
  );

  // Global Ctrl+V clipboard paste support (PC)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            handleImportFile(file);
            break;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleImportFile]);

  // Re-run or switch back to AI cutout
  const runAiCutout = useCallback(async () => {
    if (!originalBlob || !originalImg) {
      showToast('error', '请先上传一张照片后再执行智能人像抠图');
      return;
    }
    if (rawCutoutImageDataRef.current) {
      setBgMode('ai');
      recomputeForegroundFromRaw(defringeStrengthRef.current);
      return;
    }
    await executeAiCutoutForPhoto(originalBlob, originalImg);
  }, [originalBlob, originalImg, executeAiCutoutForPhoto, recomputeForegroundFromRaw, showToast]);

  // Load cached AI cutout from IndexedDB -> restores unmodified rawCutoutImageData & runs cleanEdgeSpill
  const handleSelectCachedCutout = useCallback(
    async (item: CachedCutout) => {
      try {
        setErrorMsg(null);
        const [img, rawImageData] = await Promise.all([
          loadImageFromBlob(item.blob),
          blobToRawImageData(item.blob),
        ]);
        const bgRgb = sampleDominantBackgroundRgb(rawImageData);
        rawCutoutImageDataRef.current = rawImageData;
        sampledBgRgbRef.current = bgRgb;

        const cleanedCanvas = cleanEdgeSpill(
          rawImageData,
          bgRgb,
          defringeStrengthRef.current
        );

        setOriginalBlob(item.blob);
        setOriginalImg(img);
        setForegroundCanvas(cleanedCanvas);
        setBgMode('ai');
        setActiveCacheId(item.id);
        setTransform({ scale: 1, offsetX: 0, offsetY: 0 });
        setRenderVersion((v) => v + 1);
        clearOutputs();
      } catch {
        setErrorMsg('读取缓存底稿失败');
      }
    },
    [clearOutputs]
  );

  const handleDeleteCachedCutout = useCallback(
    async (id: string) => {
      const updated = await deleteCachedCutout(id);
      setCachedCutouts(updated);
      if (activeCacheId === id) setActiveCacheId(null);
    },
    [activeCacheId]
  );

  // Step 1: Scene Preset Selection
  const handleSelectScene = (id: string) => {
    setSceneId(id);
    const found = SCENE_PRESETS.find((s) => s.id === id);
    if (!found) return;

    if (id !== 'custom') {
      setBgHex(found.defaultBgHex);
      if (found.defaultBgHex !== 'transparent' && format === 'image/png') {
        setFormat('image/jpeg');
      }
      setCustomDpiInput(String(found.dpi));
      setTargetKBInput(found.maxKB ? String(found.maxKB) : '');
      recomputeForegroundFromRaw(defringeStrengthRef.current);
    }
  };

  // Step 2: Background Color Selection -> also re-runs cleanEdgeSpill from rawCutoutImageData
  const handleSelectBgHex = (hex: string) => {
    setBgHex(hex);
    if (hex === 'transparent') {
      setFormat('image/png');
    }
    if (bgMode === 'original') {
      setBgMode('ai');
    }
    recomputeForegroundFromRaw(defringeStrengthRef.current);
  };

  // Ensure we always have a freshly cleaned Transparent Foreground Canvas from rawCutoutImageData
  const ensureTransparentForeground = useCallback(async (): Promise<HTMLCanvasElement> => {
    if (rawCutoutImageDataRef.current) {
      const cleaned = cleanEdgeSpill(
        rawCutoutImageDataRef.current,
        sampledBgRgbRef.current,
        defringeStrengthRef.current
      );
      setForegroundCanvas(cleaned);
      setRenderVersion((v) => v + 1);
      return cleaned;
    }
    if (!originalBlob || !originalImg) throw new Error('请先选择一张照片');
    const canvas = await executeAiCutoutForPhoto(originalBlob, originalImg);
    if (!canvas) throw new Error('AI 抠图尚未完成，请稍候重试');
    return canvas;
  }, [originalBlob, originalImg, executeAiCutoutForPhoto]);

  // Step 3A: Generate Single ID Photo (+ optional 6-inch print layout)
  const handleGenerateSingle = useCallback(async () => {
    if (!activeCanvasLayer) return;
    try {
      setErrorMsg(null);
      setIsGenerating(true);

      const sourceLayer =
        bgMode === 'original' ? activeCanvasLayer : await ensureTransparentForeground();

      const framedCanvas = renderFramedIdPhotoCanvas(
        sourceLayer,
        targetWidth,
        targetHeight,
        bgHex,
        transform
      );

      const exported = await exportCanvasWithTargetKB({
        canvas: framedCanvas,
        mimeType: effectiveFormat,
        dpi: targetDpi,
        targetKB: effectiveFormat === 'image/jpeg' ? parsedTargetKB : null,
        quality: 0.94,
      });

      const ext = effectiveFormat === 'image/png' ? 'png' : 'jpg';
      const kbNum = Math.max(1, Math.round(exported.blob.size / 1024));
      const fileName = `${activeScene.label}_${activeBgLabel}_${kbNum}KB.${ext}`;
      const url = URL.createObjectURL(exported.blob);

      setSingleResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return {
          id: `single_${Date.now()}`,
          label: `${activeScene.label} · ${activeBgLabel}`,
          specLabel: activeScene.shortSpecLabel,
          bgLabel: activeBgLabel,
          fileName,
          blob: exported.blob,
          url,
          width: exported.width,
          height: exported.height,
          sizeBytes: exported.blob.size,
          dpi: targetDpi,
          format: effectiveFormat,
        };
      });

      if (enableSixInch) {
        const layoutBgCanvas =
          bgHex === 'transparent'
            ? renderFramedIdPhotoCanvas(sourceLayer, targetWidth, targetHeight, '#FFFFFF', transform)
            : framedCanvas;
        const { canvas: sixCanvas, count } = generateSixInchLayoutCanvas(
          layoutBgCanvas,
          activeScene.shortSpecLabel,
          activeScene.printCountHint
        );
        const sixExported = await exportCanvasWithTargetKB({
          canvas: sixCanvas,
          mimeType: 'image/jpeg',
          dpi: 300,
          quality: 0.95,
        });
        const sixUrl = URL.createObjectURL(sixExported.blob);
        setSixInchResult((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return {
            id: `six_${Date.now()}`,
            label: `六寸排版照 (${activeScene.shortSpecLabel} × ${count}张)`,
            specLabel: `6寸排版(${count}张)`,
            bgLabel: activeBgLabel,
            fileName: `六寸排版_${activeScene.shortSpecLabel}_${activeBgLabel}_${count}张.jpg`,
            blob: sixExported.blob,
            url: sixUrl,
            width: sixExported.width,
            height: sixExported.height,
            sizeBytes: sixExported.blob.size,
            dpi: 300,
            format: 'image/jpeg',
          };
        });
      } else {
        setSixInchResult((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return null;
        });
      }

      // Open Bottom Sheet Modal on mobile
      setMobileModalType('single');
      setIsMobileResultModalOpen(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '生成证件照失败');
    } finally {
      setIsGenerating(false);
    }
  }, [
    activeCanvasLayer,
    bgMode,
    ensureTransparentForeground,
    targetWidth,
    targetHeight,
    bgHex,
    transform,
    effectiveFormat,
    targetDpi,
    parsedTargetKB,
    activeScene,
    activeBgLabel,
    enableSixInch,
  ]);

  // Step 3B: Generate Red/White/Blue Batch Full Set (6 photos + Catalog Index Card)
  const handleGenerateBatchSet = useCallback(async () => {
    if (!originalImg && !foregroundCanvas) return;
    try {
      setErrorMsg(null);
      setIsBatchGenerating(true);

      const transparentFgCanvas = await ensureTransparentForeground();
      if (bgMode === 'original') {
        setBgMode('ai');
      }

      const generated: GeneratedPhotoResult[] = [];
      for (const spec of BATCH_FULL_SET_SPECS) {
        const framed = renderFramedIdPhotoCanvas(
          transparentFgCanvas,
          spec.widthPx,
          spec.heightPx,
          spec.bgHex,
          transform
        );
        const exported = await exportCanvasWithTargetKB({
          canvas: framed,
          mimeType: 'image/jpeg',
          dpi: spec.dpi,
          targetKB: parsedTargetKB,
          quality: 0.94,
        });
        const kbNum = Math.max(1, Math.round(exported.blob.size / 1024));
        const fileName = `${spec.specLabel}_${spec.bgLabel}_${kbNum}KB.jpg`;
        const url = URL.createObjectURL(exported.blob);

        generated.push({
          id: `batch_${spec.specLabel}_${spec.bgLabel}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          label: `${spec.specLabel} · ${spec.bgLabel}`,
          specLabel: spec.specLabel,
          bgLabel: spec.bgLabel,
          fileName,
          blob: exported.blob,
          url,
          width: exported.width,
          height: exported.height,
          sizeBytes: exported.blob.size,
          dpi: spec.dpi,
          format: 'image/jpeg',
        });
      }

      const catalogCanvas = await generateCatalogIndexCanvas(generated);
      const catalogExported = await exportCanvasWithTargetKB({
        canvas: catalogCanvas,
        mimeType: 'image/jpeg',
        dpi: 300,
        quality: 0.94,
      });
      const catalogUrl = URL.createObjectURL(catalogExported.blob);

      setBatchResults((prev) => {
        prev.forEach((r) => URL.revokeObjectURL(r.url));
        return generated;
      });
      setCatalogResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return {
          id: `catalog_${Date.now()}`,
          label: '规格对照目录图',
          specLabel: '对照目录',
          bgLabel: '索引卡',
          fileName: '00_证件照规格对照目录图.jpg',
          blob: catalogExported.blob,
          url: catalogUrl,
          width: catalogExported.width,
          height: catalogExported.height,
          sizeBytes: catalogExported.blob.size,
          dpi: 300,
          format: 'image/jpeg',
        };
      });

      // Open Bottom Sheet Modal on mobile
      setMobileModalType('batch');
      setIsMobileResultModalOpen(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '批量生成全套证件照失败');
    } finally {
      setIsBatchGenerating(false);
    }
  }, [
    originalImg,
    foregroundCanvas,
    ensureTransparentForeground,
    bgMode,
    transform,
    parsedTargetKB,
  ]);

  const handleDownloadSingle = (item: GeneratedPhotoResult) => {
    triggerBlobDownload(item.blob, item.fileName);
    setShowWeChatGuide(true);
  };

  const handleZipSingle = async () => {
    const files: Array<{ fileName: string; blob: Blob }> = [];
    if (singleResult) files.push({ fileName: singleResult.fileName, blob: singleResult.blob });
    if (sixInchResult) files.push({ fileName: sixInchResult.fileName, blob: sixInchResult.blob });
    if (files.length === 0) return;
    await downloadFilesAsZip(files, `证件照_${activeScene.label}_${activeBgLabel}.zip`);
  };

  const handleZipBatch = async () => {
    if (batchResults.length === 0) return;
    const files = batchResults.map((r) => ({ fileName: r.fileName, blob: r.blob }));
    if (catalogResult) {
      files.unshift({ fileName: catalogResult.fileName, blob: catalogResult.blob });
    }
    await downloadFilesAsZip(files, '常用证件照全套_一寸二寸白蓝红.zip');
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      handleImportFile(file);
    }
  };

  // Shared Scene & Custom Parameter Controls (rendered in Step 1 on PC and Tab ① on Mobile)
  const renderSceneAndSizeControls = () => (
    <div className="space-y-3.5">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {SCENE_PRESETS.map((scene) => {
          const active = sceneId === scene.id;
          return (
            <button
              key={scene.id}
              type="button"
              onClick={() => handleSelectScene(scene.id)}
              className={`p-2.5 rounded-xl border text-left transition-all active:scale-[0.99] ${
                active
                  ? 'border-slate-900 bg-slate-900 text-white shadow-sm'
                  : 'border-slate-200 hover:border-slate-300 bg-white text-slate-800'
              }`}
            >
              <div className="text-xs font-semibold truncate">{scene.label}</div>
              <div
                className={`text-[11px] mt-0.5 truncate ${
                  active ? 'text-slate-300' : 'text-slate-500'
                }`}
              >
                {scene.id === 'custom'
                  ? `${customW}×${customH}px · ${targetDpi}DPI`
                  : scene.descLabel}
              </div>
            </button>
          );
        })}
      </div>

      {/* Custom specification inputs when "自定义规格" is active (includes custom DPI 72~600 numeric input) */}
      {sceneId === 'custom' && (
        <div className="bg-slate-50 rounded-xl border border-slate-200/70 p-3 space-y-3">
          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">宽度 (px)</label>
              <input
                type="number"
                min={50}
                max={4000}
                value={customW}
                onChange={(e) => setCustomW(parseInt(e.target.value, 10) || 295)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-900 focus:outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">高度 (px)</label>
              <input
                type="number"
                min={50}
                max={4000}
                value={customH}
                onChange={(e) => setCustomH(parseInt(e.target.value, 10) || 413)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-900 focus:outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">体积上限 (KB)</label>
              <input
                type="number"
                min={5}
                max={2000}
                disabled={effectiveFormat === 'image/png'}
                placeholder="不限，如 50"
                value={targetKBInput}
                onChange={(e) => setTargetKBInput(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 disabled:bg-slate-100"
              />
            </div>
          </div>

          {/* DPI Quick Buttons (300 / 350) + Custom DPI Numeric Input (72 ~ 600) */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/60">
            <span className="text-[11px] text-slate-600 font-medium">
              DPI 元数据（72 ~ 600，写入 JFIF 文件头）
            </span>
            <div className="flex items-center gap-1.5">
              {[300, 350].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setCustomDpiInput(String(d))}
                  className={`px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors ${
                    customDpi === d
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {d} DPI
                </button>
              ))}
              <div className="relative flex items-center">
                <input
                  type="number"
                  min={72}
                  max={600}
                  value={customDpiInput}
                  onChange={(e) => setCustomDpiInput(e.target.value)}
                  onBlur={() => setCustomDpiInput(String(customDpi))}
                  aria-label="自定义 DPI"
                  placeholder="72~600"
                  className="w-22 pl-2.5 pr-8 py-1 rounded-lg border border-slate-200 bg-white text-xs font-mono text-slate-900 focus:outline-none focus:border-slate-900"
                />
                <span className="absolute right-2 text-[10px] text-slate-400 pointer-events-none">
                  DPI
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Automatic Standard Match Summary Bar */}
      <div className="bg-slate-50 border border-slate-200/80 rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-slate-700 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span className="truncate">
            已自动匹配官方标准：
            <strong className="font-semibold text-slate-900">
              {targetWidth}×{targetHeight}px · {activeBgShortName} · {targetDpi}DPI ·{' '}
              {parsedTargetKB && effectiveFormat === 'image/jpeg'
                ? `≤${parsedTargetKB}KB`
                : '不限体积'}
            </strong>
          </span>
        </div>
        {sceneId !== 'custom' && (
          <button
            type="button"
            onClick={() => {
              setCustomW(targetWidth);
              setCustomH(targetHeight);
              setCustomDpiInput(String(targetDpi));
              setSceneId('custom');
            }}
            className="text-[11px] text-slate-500 hover:text-slate-900 underline underline-offset-2 shrink-0"
          >
            微调参数
          </button>
        )}
      </div>
    </div>
  );

  // Shared Background Color & Format Controls (rendered in Step 2 on PC and Tab ② on Mobile)
  const renderBackgroundAndFormatControls = () => (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        {BG_COLOR_PRESETS.map((c) => {
          const selected = bgHex.toLowerCase() === c.hex.toLowerCase();
          const isRecommended =
            sceneId !== 'custom' &&
            activeScene.defaultBgHex.toLowerCase() === c.hex.toLowerCase();
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => handleSelectBgHex(c.hex)}
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium transition-all active:scale-[0.98] ${
                selected
                  ? 'border-slate-900 bg-slate-900 text-white shadow-xs'
                  : 'border-slate-200 hover:border-slate-300 text-slate-700 bg-white'
              }`}
            >
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                  selected ? 'border-white/40' : 'border-slate-300/80'
                } ${c.hex === 'transparent' ? 'bg-checkerboard' : ''}`}
                style={c.hex !== 'transparent' ? { backgroundColor: c.hex } : undefined}
              >
                {selected && (
                  <Check
                    className={`w-2.5 h-2.5 ${
                      c.hex === '#FFFFFF' || c.hex === 'transparent'
                        ? 'text-slate-900'
                        : 'text-white'
                    }`}
                  />
                )}
              </span>
              <span>{c.label}</span>
              {isRecommended && (
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    selected ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  推荐
                </span>
              )}
            </button>
          );
        })}

        {/* Custom Color Picker */}
        <label
          className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium cursor-pointer transition-all ${
            !BG_COLOR_PRESETS.some((b) => b.hex.toLowerCase() === bgHex.toLowerCase())
              ? 'border-slate-900 bg-slate-900 text-white shadow-xs'
              : 'border-slate-200 hover:border-slate-300 text-slate-700 bg-white'
          }`}
        >
          <input
            type="color"
            value={customHex}
            onChange={(e) => {
              setCustomHex(e.target.value);
              handleSelectBgHex(e.target.value);
            }}
            className="w-4 h-4 rounded cursor-pointer border-0 p-0 bg-transparent"
          />
          自定义色
        </label>
      </div>

      {effectiveFormat === 'image/png' && (
        <p className="text-[11px] text-slate-500 flex items-center gap-1">
          <Info className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          {isTransparentBg
            ? '透明底已自动锁定 PNG；PNG 为无损高清格式，文件体积会偏大'
            : 'PNG 为无损高清格式，文件体积会偏大'}
        </p>
      )}
    </div>
  );

  // Shared AI Cutout & Edge Fine-Tuning Controls (rendered in Left Collapsible Panel on PC and Tab ③ on Mobile)
  const renderCutoutAndDefringeControls = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 bg-white rounded-xl border border-slate-200/80 p-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
            {isAiRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-900 truncate">
              {isAiRunning ? 'AI 智能人像抠图处理中…' : 'AI 智能人像抠图（默认启用）'}
            </div>
            <div className="text-[10px] text-slate-500 truncate">
              {isAiRunning
                ? aiProgress?.stageLabel || '正在加载本地轻量模型…'
                : '本地轻量量化模型 · 缩放推理 + 原图高清合成'}
            </div>
          </div>
        </div>
        <button
          type="button"
          disabled={isAiRunning || !originalBlob || !originalImg}
          onClick={() => {
            if (originalBlob && originalImg) {
              executeAiCutoutForPhoto(originalBlob, originalImg);
            }
          }}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[11px] font-medium text-slate-700 shrink-0 disabled:opacity-50 transition-colors"
        >
          {isAiRunning ? '处理中…' : '重新抠图'}
        </button>
      </div>

      {/* Unified Edge Defringe / Erode & Feather / Color Decontamination Slider (default 80%) */}
      <div className="bg-white rounded-lg border border-slate-200/70 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-700 font-medium">边缘微缩羽化与去白边/去溢色强度</span>
          <div className="flex items-center gap-1.5">
            {defringeStrength !== 80 && (
              <button
                type="button"
                onClick={() => handleDefringeStrengthChange(80)}
                className="text-[10px] text-slate-400 hover:text-slate-700 underline"
              >
                重置 80%
              </button>
            )}
            <span className="font-mono text-slate-900 font-semibold">{defringeStrength}%</span>
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={defringeStrength}
          onChange={(e) => handleDefringeStrengthChange(parseInt(e.target.value, 10))}
          className="w-full h-1.5 bg-slate-200 rounded-lg cursor-pointer"
        />
        <div className="flex justify-between text-[10px] text-slate-400">
          <span>0%（仅清理低置信杂点）</span>
          <span>80%（推荐，1~2px微缩+去白边）</span>
          <span>100%（强力收缩去污）</span>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-0.5">
        <span>已自动开启低透明杂点清理、1~2px 边缘微缩羽化与发丝颜色去污</span>
        {bgMode === 'original' ? (
          <button
            type="button"
            onClick={runAiCutout}
            className="text-slate-700 font-medium hover:text-slate-900 underline underline-offset-2 shrink-0 ml-2"
          >
            恢复 AI 抠图
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setBgMode('original')}
            className="text-slate-500 hover:text-slate-800 underline underline-offset-2 shrink-0 ml-2"
          >
            对比原图
          </button>
        )}
      </div>
    </div>
  );

  // Shared 6-inch print toggle
  const renderSixInchSwitch = () => (
    <div className="bg-slate-50 rounded-xl border border-slate-200/70 p-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl bg-white border border-slate-200/80 text-slate-700 flex items-center justify-center shrink-0">
          <Printer className="w-4 h-4" />
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-900">同时生成六寸冲印排版照</div>
          <div className="text-[11px] text-slate-500">
            102 × 152 mm (1205×1795 px @ 300DPI)，含白边与裁剪辅助线
          </div>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enableSixInch}
        onClick={() => setEnableSixInch((v) => !v)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
          enableSixInch ? 'bg-slate-900' : 'bg-slate-200'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
            enableSixInch ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );

  const hasAnyResult = Boolean(singleResult || sixInchResult || batchResults.length > 0);

  return (
    <div className="space-y-4 md:space-y-5 pb-20 md:pb-0">
      {/* Floating Toast Notification (never fails silently) */}
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] w-[92vw] max-w-md pointer-events-auto">
          <div
            className={`rounded-xl px-4 py-3 shadow-lg border text-xs sm:text-sm flex items-start justify-between gap-3 ${
              toast.type === 'error'
                ? 'bg-rose-600 text-white border-rose-700'
                : toast.type === 'success'
                  ? 'bg-slate-900 text-white border-slate-800'
                  : 'bg-white text-slate-800 border-slate-200'
            }`}
          >
            <span className="leading-relaxed">{toast.message}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="关闭通知"
              className="opacity-75 hover:opacity-100 shrink-0 mt-0.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImportFile(file);
          e.target.value = '';
        }}
      />

      {/* IndexedDB Recent AI Cutouts Strip (visible at top on PC or before upload; on mobile after upload it's in Tab ③) */}
      <div className={activeCanvasLayer ? 'hidden md:block' : 'block'}>
        <CutoutHistoryBar
          items={cachedCutouts}
          activeId={activeCacheId}
          onSelect={handleSelectCachedCutout}
          onDelete={handleDeleteCachedCutout}
        />
      </div>

      {/* Error banner */}
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

      {/* Upload Dropzone when no photo is loaded */}
      {!activeCanvasLayer ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`bg-white rounded-2xl border-2 border-dashed transition-all cursor-pointer p-10 sm:p-16 text-center ${
            isDragOver
              ? 'border-slate-900 bg-slate-50/80'
              : 'border-slate-200 hover:border-slate-400'
          }`}
        >
          <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-100 text-slate-700 flex items-center justify-center mb-4">
            <ImagePlus className="w-7 h-7" />
          </div>
          <h2 className="text-base sm:text-lg font-semibold text-slate-900">
            点击选择照片，或拖拽图片至此
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-2 max-w-md mx-auto leading-relaxed">
            手机端支持直接从相册选图，电脑端支持拖拽或{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700 font-mono text-xs">
              Ctrl+V
            </kbd>{' '}
            剪贴板粘贴。所有处理均在本地浏览器完成，不上传服务器。
          </p>
          <button
            type="button"
            className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 active:scale-[0.98] transition-all"
          >
            <ImagePlus className="w-4 h-4" />
            从设备选择照片
          </button>
        </div>
      ) : (
        <>
          {/* ===================================================================== */}
          {/* MOBILE LAYOUT (< 768px): Sticky Top Preview + 3-Tab Console + Modal   */}
          {/* ===================================================================== */}
          <div className="md:hidden space-y-3">
            {/* 1. Sticky Top Preview Stage (sticky top-0 z-20, 36vh~40vh) */}
            <div className="sticky top-0 z-20 -mx-4 px-4 pt-1 pb-2 bg-[#F4F5F7]/95 backdrop-blur-md">
              <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs p-3 min-h-[258px] max-h-[40vh] flex flex-col justify-between">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-semibold text-slate-900 truncate">
                      {activeScene.label}
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono shrink-0">
                      {targetWidth}×{targetHeight} · {targetDpi}DPI
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-[11px] font-medium text-slate-700 active:bg-slate-100 shrink-0"
                  >
                    <RefreshCw className="w-3 h-3" />
                    换图
                  </button>
                </div>

                <PhotoCanvasEditor
                  image={activeCanvasLayer}
                  renderVersion={renderVersion}
                  targetWidth={targetWidth}
                  targetHeight={targetHeight}
                  bgHex={bgHex}
                  transform={transform}
                  onTransformChange={setTransform}
                  compact={true}
                />

                {aiProgress && (
                  <div className="mt-1.5 bg-slate-900 text-white rounded-lg px-2.5 py-1.5 flex items-center justify-between text-[11px]">
                    <span className="truncate">{aiProgress.stageLabel}</span>
                    <span className="font-mono ml-2">{aiProgress.percent}%</span>
                  </div>
                )}
              </div>
            </div>

            {/* 2. Middle 3-Tab Console Switcher */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-3.5 space-y-3.5">
              <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-xl">
                {(
                  [
                    { id: 'scene', label: '① 场景与尺寸' },
                    { id: 'bg', label: '② 背景底色' },
                    { id: 'cutout', label: '③ 抠图微调' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setMobileTab(tab.id)}
                    className={`py-2 rounded-lg text-xs font-semibold transition-all ${
                      mobileTab === tab.id
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Active Tab Content (only renders 1 panel at a time) */}
              {mobileTab === 'scene' && (
                <div className="space-y-3.5">
                  {renderSceneAndSizeControls()}
                  {renderSixInchSwitch()}
                </div>
              )}

              {mobileTab === 'bg' && (
                <div className="space-y-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800">选择底色与格式</span>
                    <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200/60">
                      <button
                        type="button"
                        disabled={isTransparentBg}
                        onClick={() => setFormat('image/jpeg')}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                          effectiveFormat === 'image/jpeg'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-500 disabled:opacity-40'
                        }`}
                      >
                        JPG
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormat('image/png')}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                          effectiveFormat === 'image/png'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-500'
                        }`}
                      >
                        PNG
                      </button>
                    </div>
                  </div>
                  {renderBackgroundAndFormatControls()}
                </div>
              )}

              {mobileTab === 'cutout' && (
                <div className="space-y-3">
                  {renderCutoutAndDefringeControls()}
                  <CutoutHistoryBar
                    items={cachedCutouts}
                    activeId={activeCacheId}
                    onSelect={handleSelectCachedCutout}
                    onDelete={handleDeleteCachedCutout}
                  />
                </div>
              )}
            </div>

            {/* 3. Mobile Fixed Bottom Floating Action Bar */}
            <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200 px-3.5 py-2.5 flex items-center gap-2 shadow-lg">
              <button
                type="button"
                disabled={isGenerating || isBatchGenerating}
                onClick={handleGenerateBatchSet}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 text-xs font-semibold active:scale-[0.98] transition-all disabled:opacity-60 shrink-0"
              >
                {isBatchGenerating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Layers className="w-3.5 h-3.5" />
                )}
                红白蓝全套
              </button>

              <button
                type="button"
                disabled={isGenerating || isBatchGenerating}
                onClick={handleGenerateSingle}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-semibold active:scale-[0.98] transition-all disabled:opacity-60"
              >
                {isGenerating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                生成证件照
              </button>

              {hasAnyResult && (
                <button
                  type="button"
                  onClick={() => setIsMobileResultModalOpen(true)}
                  className="px-2.5 py-2.5 rounded-xl bg-slate-100 text-slate-700 text-xs font-medium shrink-0"
                >
                  看成品
                </button>
              )}
            </div>
          </div>

          {/* ===================================================================== */}
          {/* PC / TABLET LAYOUT (>= 768px): Existing Dual-Column 1-2-3 Layout      */}
          {/* ===================================================================== */}
          <div className="hidden md:grid md:grid-cols-12 gap-5 items-start">
            {/* LEFT COLUMN: Pure Preview Canvas + Default-Collapsed Cutout & Edge Fine-Tuning Panel */}
            <div className="md:col-span-5 space-y-3">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                className={`bg-white rounded-2xl border p-4 sm:p-5 transition-colors ${
                  isDragOver ? 'border-slate-900 bg-slate-50/50' : 'border-slate-200/80'
                }`}
              >
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">预览与构图</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {activeScene.label} · {targetWidth} × {targetHeight} px
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    换一张图
                  </button>
                </div>

                <PhotoCanvasEditor
                  image={activeCanvasLayer}
                  renderVersion={renderVersion}
                  targetWidth={targetWidth}
                  targetHeight={targetHeight}
                  bgHex={bgHex}
                  transform={transform}
                  onTransformChange={setTransform}
                />

                {aiProgress && (
                  <div className="mt-4 bg-slate-50 border border-slate-200/70 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-800">{aiProgress.stageLabel}</span>
                      <span className="font-mono text-slate-600">{aiProgress.percent}%</span>
                    </div>
                    <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-slate-900 rounded-full transition-all duration-200"
                        style={{ width: `${aiProgress.percent}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-slate-500">
                      首次加载高精度抠图引擎后将自动缓存在本机，下次打开秒出图
                    </p>
                  </div>
                )}

                {/* Default-Collapsed Panel: 抠图微调 */}
                <div className="mt-4 pt-3.5 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setIsCutoutPanelOpen((v) => !v)}
                    className="w-full flex items-center justify-between text-xs text-slate-600 hover:text-slate-900 py-1 transition-colors"
                  >
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
                      抠图微调
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                      {bgMode === 'ai' ? 'AI 智能人像抠图' : '保留原图'}
                      {' · '}去白边/溢色 {defringeStrength}%
                      {isCutoutPanelOpen ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </span>
                  </button>

                  {isCutoutPanelOpen && (
                    <div className="mt-3 bg-slate-50/80 border border-slate-200/60 rounded-xl p-3">
                      {renderCutoutAndDefringeControls()}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: Strict 1-2-3 Linear Step Flow */}
            <div className="md:col-span-7 space-y-4">
              {/* STEP 1: 选择使用场景（含自定义入口） */}
              <div className="bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-5 space-y-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center justify-center">
                      1
                    </span>
                    <h3 className="text-sm font-semibold text-slate-900">选择使用场景</h3>
                  </div>
                  <span className="text-xs text-slate-400">自动匹配尺寸 · 底色 · DPI · 体积</span>
                </div>
                {renderSceneAndSizeControls()}
              </div>

              {/* STEP 2: 确认背景底色 */}
              <div className="bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-5 space-y-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center justify-center">
                      2
                    </span>
                    <h3 className="text-sm font-semibold text-slate-900">确认背景底色</h3>
                  </div>

                  <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200/60">
                    <button
                      type="button"
                      disabled={isTransparentBg}
                      onClick={() => setFormat('image/jpeg')}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                        effectiveFormat === 'image/jpeg'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-500 hover:text-slate-800 disabled:opacity-40'
                      }`}
                    >
                      JPG
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormat('image/png')}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                        effectiveFormat === 'image/png'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      PNG
                    </button>
                  </div>
                </div>
                {renderBackgroundAndFormatControls()}
              </div>

              {/* STEP 3: 导出与打包 */}
              <div className="bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center justify-center">
                      3
                    </span>
                    <h3 className="text-sm font-semibold text-slate-900">导出与打包</h3>
                  </div>
                  <span className="text-xs text-slate-400">支持手机长按存图与 ZIP 防压缩打包</span>
                </div>

                {renderSixInchSwitch()}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    disabled={isGenerating || isBatchGenerating}
                    onClick={handleGenerateSingle}
                    className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 active:scale-[0.99] transition-all disabled:opacity-60"
                  >
                    {isGenerating ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    生成当前证件照
                  </button>

                  <button
                    type="button"
                    disabled={isGenerating || isBatchGenerating}
                    onClick={handleGenerateBatchSet}
                    className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-slate-300 bg-white text-slate-900 text-sm font-medium hover:bg-slate-50 active:scale-[0.99] transition-all disabled:opacity-60"
                  >
                    {isBatchGenerating ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Layers className="w-4 h-4" />
                    )}
                    一键生成红白蓝全套（6张+目录图）
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ===================================================================== */}
      {/* PC INLINE RESULT CARDS (hidden on mobile < 768px)                     */}
      {/* ===================================================================== */}
      {(singleResult || sixInchResult) && (
        <div className="hidden md:block bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm sm:text-base font-semibold text-slate-900">成品预览与保存</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                手机浏览器可直接<span className="font-medium text-slate-700">长按成品图</span>选择「保存到相册」
              </p>
            </div>
            <div className="flex items-center gap-2">
              {singleResult && (
                <button
                  type="button"
                  onClick={() => handleDownloadSingle(singleResult)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 active:scale-[0.98] transition-all"
                >
                  <Download className="w-3.5 h-3.5" />
                  下载保存
                </button>
              )}
              <button
                type="button"
                onClick={handleZipSingle}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 active:scale-[0.98] transition-all"
              >
                <Archive className="w-3.5 h-3.5" />
                打包防压缩 (.zip)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {singleResult && (
              <div className="bg-slate-50 rounded-xl border border-slate-200/70 p-4 flex flex-col items-center">
                <div
                  className={`rounded-lg overflow-hidden border border-slate-200 shadow-sm max-w-[220px] ${
                    singleResult.format === 'image/png' ? 'bg-checkerboard' : 'bg-white'
                  }`}
                >
                  <img
                    src={singleResult.url}
                    alt={singleResult.label}
                    className="block w-full h-auto"
                  />
                </div>
                <div className="mt-3 text-center space-y-1">
                  <div className="text-xs font-semibold text-slate-900">{singleResult.label}</div>
                  <div className="text-xs text-slate-500 font-mono">
                    {singleResult.width} × {singleResult.height} px · {singleResult.dpi} DPI ·{' '}
                    <span className="text-slate-900 font-semibold">
                      {formatKB(singleResult.sizeBytes)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {sixInchResult && (
              <div className="bg-slate-50 rounded-xl border border-slate-200/70 p-4 flex flex-col items-center">
                <div className="rounded-lg overflow-hidden border border-slate-200 shadow-sm bg-white max-w-[220px]">
                  <img
                    src={sixInchResult.url}
                    alt={sixInchResult.label}
                    className="block w-full h-auto"
                  />
                </div>
                <div className="mt-3 text-center space-y-1.5">
                  <div className="text-xs font-semibold text-slate-900">{sixInchResult.label}</div>
                  <div className="text-xs text-slate-500 font-mono">
                    {sixInchResult.width} × {sixInchResult.height} px · 300 DPI ·{' '}
                    <span className="text-slate-900 font-semibold">
                      {formatKB(sixInchResult.sizeBytes)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDownloadSingle(sixInchResult)}
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    单独下载六寸排版图
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={() => setShowWeChatGuide(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-slate-200 bg-slate-50 text-xs text-slate-600 hover:text-slate-900 hover:border-slate-300 transition-colors"
            >
              <Info className="w-3.5 h-3.5" />
              发微信防压缩方法
            </button>
          </div>
        </div>
      )}

      {batchResults.length > 0 && (
        <div className="hidden md:block bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm sm:text-base font-semibold text-slate-900">
                红白蓝常用全套证件照（一寸/二寸 × 白/蓝/红 + 规格对照目录图）
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                支持长按单张直存相册，或一键打包全部 7 张图片（含目录索引卡）
              </p>
            </div>
            <button
              type="button"
              onClick={handleZipBatch}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 active:scale-[0.98] transition-all"
            >
              <Archive className="w-3.5 h-3.5" />
              一键打包全套 (.zip)
            </button>
          </div>

          {catalogResult && (
            <div className="bg-slate-50 rounded-xl border border-slate-200/70 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-slate-900">
                  规格对照目录图（存入相册后肉眼对照选用）
                </span>
                <button
                  type="button"
                  onClick={() => handleDownloadSingle(catalogResult)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                >
                  <Download className="w-3 h-3" />
                  保存目录图 ({formatKB(catalogResult.sizeBytes)})
                </button>
              </div>
              <div className="rounded-xl overflow-hidden border border-slate-200 bg-white max-w-2xl mx-auto">
                <img
                  src={catalogResult.url}
                  alt="证件照规格对照目录图"
                  className="block w-full h-auto"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {batchResults.map((item, idx) => (
              <div
                key={item.id}
                className="bg-slate-50 rounded-xl border border-slate-200/70 p-3 flex flex-col items-center"
              >
                <div className="w-full flex items-center justify-between text-[11px] text-slate-500 mb-2">
                  <span className="px-1.5 py-0.5 rounded bg-slate-900 text-white font-mono text-[10px]">
                    #{String(idx + 1).padStart(2, '0')}
                  </span>
                  <span className="font-medium text-slate-700">{item.label}</span>
                </div>
                <div className="rounded-lg overflow-hidden border border-slate-200 bg-white w-28 sm:w-32">
                  <img src={item.url} alt={item.fileName} className="block w-full h-auto" />
                </div>
                <div className="mt-2.5 text-[11px] text-slate-500 font-mono text-center">
                  {item.width}×{item.height} · {formatKB(item.sizeBytes)}
                </div>
                <button
                  type="button"
                  onClick={() => handleDownloadSingle(item)}
                  className="mt-2 w-full inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                >
                  <Download className="w-3 h-3" />
                  保存单张
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MOBILE (< 768px) BOTTOM SHEET MODAL FOR GENERATED RESULTS             */}
      {/* ===================================================================== */}
      {isMobileResultModalOpen && (
        <div
          className="fixed inset-0 z-50 md:hidden bg-slate-900/50 backdrop-blur-xs flex items-end justify-center"
          onClick={() => setIsMobileResultModalOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-h-[86vh] bg-white rounded-t-2xl border-t border-slate-200 shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Drawer Header */}
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  {mobileModalType === 'batch'
                    ? '红白蓝全套成品（长按图片直接存相册）'
                    : '证件照成品（长按图片直接存相册）'}
                </h3>
                <p className="text-[11px] text-slate-500">
                  在手机浏览器中手指长按下方图片即可唤起「保存到相册」
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsMobileResultModalOpen(false)}
                aria-label="关闭成品弹窗"
                className="p-1.5 rounded-xl bg-slate-100 text-slate-500 active:bg-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Drawer Scrollable Content */}
            <div className="p-4 overflow-y-auto space-y-4">
              {mobileModalType === 'single' && (
                <>
                  {singleResult && (
                    <div className="bg-slate-50 rounded-xl border border-slate-200/70 p-3.5 flex flex-col items-center">
                      <div
                        className={`rounded-lg overflow-hidden border border-slate-200 shadow-xs max-w-[180px] ${
                          singleResult.format === 'image/png' ? 'bg-checkerboard' : 'bg-white'
                        }`}
                      >
                        <img
                          src={singleResult.url}
                          alt={singleResult.label}
                          className="block w-full h-auto"
                        />
                      </div>
                      <div className="mt-2.5 text-center">
                        <div className="text-xs font-semibold text-slate-900">
                          {singleResult.label}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                          {singleResult.width} × {singleResult.height} px · {singleResult.dpi} DPI ·{' '}
                          <strong className="text-slate-900">
                            {formatKB(singleResult.sizeBytes)}
                          </strong>
                        </div>
                      </div>
                    </div>
                  )}

                  {sixInchResult && (
                    <div className="bg-slate-50 rounded-xl border border-slate-200/70 p-3.5 flex flex-col items-center">
                      <div className="rounded-lg overflow-hidden border border-slate-200 shadow-xs bg-white max-w-[200px]">
                        <img
                          src={sixInchResult.url}
                          alt={sixInchResult.label}
                          className="block w-full h-auto"
                        />
                      </div>
                      <div className="mt-2.5 text-center space-y-1">
                        <div className="text-xs font-semibold text-slate-900">
                          {sixInchResult.label}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {sixInchResult.width} × {sixInchResult.height} px · 300 DPI ·{' '}
                          <strong className="text-slate-900">
                            {formatKB(sixInchResult.sizeBytes)}
                          </strong>
                        </div>
                        <button
                          type="button"
                          onClick={() => triggerBlobDownload(sixInchResult.blob, sixInchResult.fileName)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-700"
                        >
                          <Download className="w-3 h-3" />
                          下载六寸排版图
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Actions inside single drawer */}
                  <div className="grid grid-cols-2 gap-2">
                    {singleResult && (
                      <button
                        type="button"
                        onClick={() =>
                          triggerBlobDownload(singleResult.blob, singleResult.fileName)
                        }
                        className="inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-semibold"
                      >
                        <Download className="w-3.5 h-3.5" />
                        下载保存图片
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleZipSingle}
                      className="inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-800 text-xs font-semibold"
                    >
                      <Archive className="w-3.5 h-3.5" />
                      打包防压缩 (.zip)
                    </button>
                  </div>
                </>
              )}

              {mobileModalType === 'batch' && (
                <>
                  {catalogResult && (
                    <div className="bg-slate-50 rounded-xl border border-slate-200/70 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-900">
                          规格对照目录图（长按可保存）
                        </span>
                        <span className="text-[11px] font-mono text-slate-500">
                          {formatKB(catalogResult.sizeBytes)}
                        </span>
                      </div>
                      <div className="rounded-lg overflow-hidden border border-slate-200 bg-white">
                        <img
                          src={catalogResult.url}
                          alt="规格对照目录图"
                          className="block w-full h-auto"
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2">
                    {batchResults.map((item, idx) => (
                      <div
                        key={item.id}
                        className="bg-slate-50 rounded-xl border border-slate-200/70 p-2 flex flex-col items-center"
                      >
                        <div className="text-[10px] font-semibold text-slate-700 mb-1 truncate w-full text-center">
                          #{idx + 1} {item.label}
                        </div>
                        <div className="rounded overflow-hidden border border-slate-200 bg-white w-full">
                          <img src={item.url} alt={item.fileName} className="block w-full h-auto" />
                        </div>
                        <div className="mt-1 text-[10px] font-mono text-slate-500">
                          {formatKB(item.sizeBytes)}
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={handleZipBatch}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-semibold"
                  >
                    <Archive className="w-3.5 h-3.5" />
                    一键打包全套防压缩 (.zip)
                  </button>
                </>
              )}

              {/* Collapsible WeChat Anti-Compression Guide inside Mobile Bottom Sheet */}
              <div className="border border-slate-200/80 rounded-xl bg-slate-50/70 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setIsMobileWeChatFoldOpen((v) => !v)}
                  className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs font-medium text-slate-700"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-slate-500" />
                    发微信防压缩方法（保留原图画质与 DPI）
                  </span>
                  {isMobileWeChatFoldOpen ? (
                    <ChevronUp className="w-4 h-4 text-slate-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  )}
                </button>

                {isMobileWeChatFoldOpen && (
                  <div className="px-3.5 pb-3.5 pt-1 space-y-2.5 border-t border-slate-200/60">
                    <p className="text-[11px] text-slate-600 leading-relaxed">
                      直接发相册图会被微信压缩，发送时请点聊天框右下角{' '}
                      <strong className="text-slate-900">+</strong> →{' '}
                      <strong className="text-slate-900">文件</strong> → 左上角切换
                      <strong className="text-slate-900">「手机相册」</strong>选图
                    </p>
                    <div className="grid grid-cols-3 gap-1.5">
                      <div className="bg-white border border-slate-200/70 rounded-lg p-2 text-center">
                        <PlusCircle className="w-3.5 h-3.5 mx-auto text-slate-700 mb-1" />
                        <div className="text-[10px] font-medium text-slate-800">1. 点右下角 +</div>
                      </div>
                      <div className="bg-white border border-slate-200/70 rounded-lg p-2 text-center">
                        <FileText className="w-3.5 h-3.5 mx-auto text-slate-700 mb-1" />
                        <div className="text-[10px] font-medium text-slate-800">2. 选「文件」</div>
                      </div>
                      <div className="bg-white border border-slate-200/70 rounded-lg p-2 text-center">
                        <FolderOpen className="w-3.5 h-3.5 mx-auto text-slate-700 mb-1" />
                        <div className="text-[10px] font-medium text-slate-800">3. 切「手机相册」</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PC Contextual WeChat Anti-Compression Guide Bottom Card */}
      <WeChatSaveGuide
        open={showWeChatGuide}
        onClose={() => setShowWeChatGuide(false)}
        onDownloadZip={
          batchResults.length > 0
            ? handleZipBatch
            : singleResult
              ? handleZipSingle
              : undefined
        }
      />
    </div>
  );
}
