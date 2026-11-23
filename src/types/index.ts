export type AppTab = 'id-photo' | 'converter';

export type ExportFormat = 'image/jpeg' | 'image/png';
export type ConverterFormat = 'image/jpeg' | 'image/png' | 'image/webp';

export type BgChannelMode = 'ai' | 'original';

export interface ScenePreset {
  id: string;
  label: string;
  shortSpecLabel: string;
  descLabel: string;
  widthPx: number;
  heightPx: number;
  dpi: number;
  defaultBgHex: string;
  defaultBgName: string;
  maxKB: number | null;
  /** Number of copies in 6-inch print layout if standard */
  printCountHint?: number;
}

export interface BgColorPreset {
  id: string;
  label: string;
  shortName: string;
  hex: string; // 'transparent' for transparent background
}

export interface TransformState {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface GeneratedPhotoResult {
  id: string;
  label: string;
  specLabel: string;
  bgLabel: string;
  fileName: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  sizeBytes: number;
  dpi: number;
  format: ExportFormat;
}

export interface CachedCutout {
  originalBlob?: Blob;
  id: string;
  createdAt: number;
  blob: Blob;
  width: number;
  height: number;
}

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: 'general-1-inch',
    label: '通用一寸',
    shortSpecLabel: '一寸',
    descLabel: '295×413 px · 300 DPI',
    widthPx: 295,
    heightPx: 413,
    dpi: 300,
    defaultBgHex: '#FFFFFF',
    defaultBgName: '纯白底',
    maxKB: null,
    printCountHint: 8,
  },
  {
    id: 'general-2-inch',
    label: '通用二寸',
    shortSpecLabel: '二寸',
    descLabel: '413×579 px · 300 DPI',
    widthPx: 413,
    heightPx: 579,
    dpi: 300,
    defaultBgHex: '#FFFFFF',
    defaultBgName: '纯白底',
    maxKB: null,
    printCountHint: 4,
  },
  {
    id: 'civil-servant',
    label: '公务员/事业单位',
    shortSpecLabel: '一寸',
    descLabel: '295×413 px · 限 ≤30KB',
    widthPx: 295,
    heightPx: 413,
    dpi: 300,
    defaultBgHex: '#438EDB',
    defaultBgName: '天蓝底',
    maxKB: 30,
    printCountHint: 8,
  },
  {
    id: 'teacher-cert',
    label: '教师资格证报名',
    shortSpecLabel: '一寸',
    descLabel: '295×413 px · 限 ≤200KB',
    widthPx: 295,
    heightPx: 413,
    dpi: 300,
    defaultBgHex: '#FFFFFF',
    defaultBgName: '纯白底',
    maxKB: 200,
    printCountHint: 8,
  },
  {
    id: 'passport-visa',
    label: '出入境/护照签证',
    shortSpecLabel: '大一寸',
    descLabel: '390×567 px · 限 ≤100KB',
    widthPx: 390,
    heightPx: 567,
    dpi: 300,
    defaultBgHex: '#FFFFFF',
    defaultBgName: '纯白底',
    maxKB: 100,
    printCountHint: 4,
  },
  {
    id: 'social-security',
    label: '社保/居住证回执',
    shortSpecLabel: '社保回执',
    descLabel: '358×441 px · 350 DPI · ≤50KB',
    widthPx: 358,
    heightPx: 441,
    dpi: 350,
    defaultBgHex: '#FFFFFF',
    defaultBgName: '纯白底',
    maxKB: 50,
    printCountHint: 8,
  },
  {
    id: 'custom',
    label: '自定义规格',
    shortSpecLabel: '自定义',
    descLabel: '手动设置宽高 / DPI / KB',
    widthPx: 295,
    heightPx: 413,
    dpi: 300,
    defaultBgHex: '#FFFFFF',
    defaultBgName: '纯白底',
    maxKB: null,
  },
];

export const BG_COLOR_PRESETS: BgColorPreset[] = [
  { id: 'white', label: '纯净白', shortName: '纯白底', hex: '#FFFFFF' },
  { id: 'sky-blue', label: '证件天蓝', shortName: '天蓝底', hex: '#438EDB' },
  { id: 'gov-blue', label: '政务深蓝', shortName: '深蓝底', hex: '#2B579A' },
  { id: 'china-red', label: '中国红', shortName: '红底', hex: '#D81E06' },
  { id: 'transparent', label: '透明底', shortName: '透明底', hex: 'transparent' },
];

export const BATCH_FULL_SET_SPECS: Array<{
  presetId: string;
  specLabel: string;
  widthPx: number;
  heightPx: number;
  dpi: number;
  bgLabel: string;
  bgHex: string;
}> = [
  { presetId: '1-inch', specLabel: '一寸', widthPx: 295, heightPx: 413, dpi: 300, bgLabel: '白底', bgHex: '#FFFFFF' },
  { presetId: '1-inch', specLabel: '一寸', widthPx: 295, heightPx: 413, dpi: 300, bgLabel: '蓝底', bgHex: '#438EDB' },
  { presetId: '1-inch', specLabel: '一寸', widthPx: 295, heightPx: 413, dpi: 300, bgLabel: '红底', bgHex: '#D81E06' },
  { presetId: '2-inch', specLabel: '二寸', widthPx: 413, heightPx: 579, dpi: 300, bgLabel: '白底', bgHex: '#FFFFFF' },
  { presetId: '2-inch', specLabel: '二寸', widthPx: 413, heightPx: 579, dpi: 300, bgLabel: '蓝底', bgHex: '#438EDB' },
  { presetId: '2-inch', specLabel: '二寸', widthPx: 413, heightPx: 579, dpi: 300, bgLabel: '红底', bgHex: '#D81E06' },
];
