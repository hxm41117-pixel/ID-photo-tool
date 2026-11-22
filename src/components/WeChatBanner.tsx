import { useEffect, useState } from 'react';
import { Compass, X } from 'lucide-react';

export function WeChatBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent || '';
    const isWeChatOrQQ = /MicroMessenger/i.test(ua) || /\bQQ\//i.test(ua);
    if (isWeChatOrQQ) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="bg-slate-900 text-slate-100 text-xs sm:text-sm">
      <div className="max-w-5xl mx-auto px-4 py-2.5 flex items-start sm:items-center justify-between gap-3">
        <div className="flex items-start sm:items-center gap-2 leading-relaxed">
          <Compass className="w-4 h-4 shrink-0 mt-0.5 sm:mt-0 text-sky-300" />
          <span>
            建议点击右上角，选择「在默认浏览器或夸克中打开」，本地 AI 抠图速度更快、大图导出更稳定
          </span>
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          aria-label="关闭提示"
          className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
