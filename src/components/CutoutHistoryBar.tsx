import { useEffect, useState } from 'react';
import { History, Trash2 } from 'lucide-react';
import { CachedCutout } from '../types';

interface CutoutHistoryBarProps {
  items: CachedCutout[];
  activeId?: string | null;
  onSelect: (item: CachedCutout) => void;
  onDelete: (id: string) => void;
}

export function CutoutHistoryBar({
  items,
  activeId,
  onSelect,
  onDelete,
}: CutoutHistoryBarProps) {
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const map: Record<string, string> = {};
    for (const item of items) {
      map[item.id] = URL.createObjectURL(item.blob);
    }
    setThumbUrls(map);
    return () => {
      Object.values(map).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 p-3.5 sm:p-4">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
          <History className="w-3.5 h-3.5 text-slate-500" />
          <span>最近 AI 抠图底稿（本机缓存，点击直接换底/改尺寸）</span>
        </div>
        <span className="text-[11px] text-slate-400">最多保留 4 张</span>
      </div>

      <div className="flex items-center gap-2.5 overflow-x-auto pb-0.5">
        {items.map((item) => {
          const isSelected = activeId === item.id;
          return (
            <div
              key={item.id}
              className={`relative group shrink-0 rounded-xl border p-1 transition-all ${
                isSelected
                  ? 'border-slate-900 ring-2 ring-slate-900/10 bg-slate-50'
                  : 'border-slate-200 hover:border-slate-300 bg-white'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(item)}
                className="block w-14 h-18 rounded-lg overflow-hidden bg-checkerboard"
                title={`使用缓存底稿 (${item.width}×${item.height})`}
              >
                {thumbUrls[item.id] && (
                  <img
                    src={thumbUrls[item.id]}
                    alt="缓存抠图底稿"
                    className="w-full h-full object-cover"
                  />
                )}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(item.id);
                }}
                aria-label="删除此缓存底稿"
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white border border-slate-200 shadow-sm text-slate-400 hover:text-rose-600 hover:border-rose-200 flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
